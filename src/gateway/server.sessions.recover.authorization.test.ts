import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, expect, test, vi } from "vitest";
import { SessionsRecoverResultSchema } from "../../packages/gateway-protocol/src/schema/sessions-recover.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { retainGatewayOperatorRun } from "./operator-run-cancellation.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
type Request = Parameters<typeof handleGatewayRequest>[0];
function humanActor(client: NonNullable<Request["client"]>) {
  const { profileId: id } = client.authenticatedUserProfile!;
  return { type: "human" as const, source: "profile" as const, id };
}

const operatorRunCaptures = vi.hoisted(
  () => new Map<string, Awaited<ReturnType<typeof retainGatewayOperatorRun>>>(),
);

vi.mock("./operator-run-cancellation.js", async () => {
  const actual = await vi.importActual<typeof import("./operator-run-cancellation.js")>(
    "./operator-run-cancellation.js",
  );
  return {
    ...actual,
    retainGatewayOperatorRun: async (
      params: Parameters<typeof actual.retainGatewayOperatorRun>[0],
    ) => {
      const retained = await actual.retainGatewayOperatorRun(params);
      operatorRunCaptures.set(params.runId, retained);
      return retained;
    },
  };
});

afterEach(() => {
  operatorRunCaptures.clear();
  closeOpenClawStateDatabaseForTest();
});
const prepareProfiles = useUserProfileCatalogForTest();

async function recoveryFixture(name: string, withWriter = false) {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = `agent:main:dashboard:${name}-recovery`;
  const sourceSessionId = `${name}-recovery-source`;
  const owner = roleClient("view", `${name}-owner`);
  owner.connect.scopes = ["operator.sessions.write"];
  const writer = withWriter ? roleClient("write", `${name}-writer`) : undefined;
  if (writer) {
    writer.connect.scopes = ["operator.write"];
  }
  await prepareProfiles();
  for (const client of writer ? [owner, writer] : [owner]) {
    prepareGatewayRecipientProfile(client);
  }
  const cfg = getRuntimeConfig();
  await writeSessionStore({
    entries: {
      [sourceKey]: sessionStoreEntry(sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: `cycle-${sourceSessionId}`,
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
        createdActor: humanActor(owner),
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
    messages: [{ role: "user", content: "finish the interrupted work" }],
  });
  return {
    owner,
    writer,
    storePath,
    sourceKey,
    cfg: {
      ...cfg,
      gateway: { ...cfg.gateway, roles: rolePolicyConfig().gateway!.roles },
      session: { ...cfg.session, store: storePath },
    },
  };
}

async function registeredSessionRecover({
  key,
  ...options
}: { key: string } & Pick<Request, "client" | "context" | "hasCurrentClientAuthority">) {
  const respond = vi.fn<Request["respond"]>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "recover",
      method: "sessions.recover",
      params: { agentId: "main", key },
    },
    ...options,
    respond,
    isWebchatConnect: () => false,
  });
  const [ok, payload, error] = expectDefined(respond.mock.lastCall, "sessions.recover response");
  if (payload !== undefined && !Value.Check(SessionsRecoverResultSchema, payload)) {
    throw new Error("sessions.recover returned an invalid payload");
  }
  return { ok, payload, error };
}

function expectRecovery(
  result: Awaited<ReturnType<typeof registeredSessionRecover>>,
  continuation: unknown,
  session = { key: expect.any(String) },
) {
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    payload: { ...session, continuation },
  });
  return expectDefined(result.payload, "recovered session");
}

test("sessions.recover denies a narrow continuation into a linked foreign successor", async () => {
  const fixture = await recoveryFixture("linked-foreign", true);
  const { owner: sourceOwner, storePath, sourceKey, cfg } = fixture;
  const broadWriter = expectDefined(fixture.writer, "broad writer fixture");
  const revokedRole = rolePolicyConfig().gateway!.roles!;
  const writeRole = expectDefined(revokedRole.definitions.write, "write role fixture");
  writeRole.sessions = { others: "view" };
  const revokedCfg = { ...cfg, gateway: { ...cfg.gateway, roles: revokedRole } };
  const context = createDirectChatContext({
    getRuntimeConfig: () =>
      loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath })?.mainRestartRecovery
        ?.tombstone?.recoveredSessionKey
        ? revokedCfg
        : cfg,
  });
  const recover = (client: typeof sourceOwner, ctx = context) =>
    registeredSessionRecover({ client, context: ctx, key: sourceKey });

  const successor = expectRecovery(await recover(broadWriter), {
    status: "rejected",
  });
  const { key: successorKey, sessionId: successorSessionId } = successor;
  const expectedSession = { key: successorKey, sessionId: successorSessionId };
  const successorScope = { agentId: "main", sessionKey: successorKey, storePath };
  expect(loadSessionEntry(successorScope)?.createdActor).toEqual(humanActor(broadWriter));
  const transcriptBefore = await loadTranscriptEvents({
    ...successorScope,
    sessionId: successorSessionId,
  });
  const runCountBefore = vi.mocked(context.addChatRun).mock.calls.length;

  expectRecovery(
    await recover(sourceOwner),
    {
      status: "rejected",
      error: { code: "FORBIDDEN", message: "Session-scoped writes require your own session." },
    },
    expectedSession,
  );
  expect(vi.mocked(context.addChatRun).mock.calls.length).toBe(runCountBefore);
  await expect(
    loadTranscriptEvents({ ...successorScope, sessionId: successorSessionId }),
  ).resolves.toEqual(transcriptBefore);
  expect(operatorRunCaptures.size).toBe(0);

  await addSessionMember(successorScope, {
    identityId: sourceOwner.authenticatedUserProfile!.profileId,
    addedBy: broadWriter.authenticatedUserProfile!.profileId,
    expectedSessionId: successorSessionId,
  });
  sourceOwner.connect.scopes = ["operator.write"];
  const allowedContext = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const granted = expectRecovery(
    await recover(sourceOwner, allowedContext),
    { status: "started" },
    expectedSession,
  );
  const memberRunId = "runId" in granted.continuation && granted.continuation.runId;
  expect(typeof memberRunId === "string" && operatorRunCaptures.has(memberRunId)).toBe(true);
  expect(allowedContext.addChatRun).toHaveBeenCalledOnce();
});

test("sessions.recover retains source revocation for its accepted own successor", async () => {
  const { owner, storePath, sourceKey, cfg } = await recoveryFixture("narrow-own");
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const requestAuthority = captureGatewayDeviceRevocation(
    context,
    { deviceId: "narrow-recovery-device", role: "operator" },
    () => true,
  );
  const recovered = expectRecovery(
    await registeredSessionRecover({
      client: owner,
      context,
      key: sourceKey,
      hasCurrentClientAuthority: requestAuthority.isCurrent,
    }),
    { status: "started" },
  );
  const runId = "runId" in recovered.continuation && recovered.continuation.runId;
  if (typeof runId !== "string") {
    throw new Error("recovery did not return its admitted run");
  }
  const acceptedRun = expectDefined(rpcSourceTesting.get(runId), "registered active run");
  const retainedRun = expectDefined(operatorRunCaptures.get(runId), "retained operator authority");
  const cancellationWork: Promise<unknown>[] = [];
  context.trackExecution = async (run) => {
    const operation = Promise.resolve().then(run);
    cancellationWork.push(operation);
    return await operation;
  };
  const providerCancellation = vi.fn();
  acceptedRun.input.abortSignal.addEventListener("abort", providerCancellation, { once: true });
  retainedRun.armCancellation();
  requestAuthority.release();
  expect(requestAuthority.isCurrent()).toBe(true);
  expect(acceptedRun.input.abortSignal.aborted).toBe(false);
  invalidateGatewayDeviceRevocation(context, "narrow-recovery-device", "operator");
  await Promise.allSettled(cancellationWork);
  expect(requestAuthority.isCurrent()).toBe(false);
  expect(acceptedRun.input.abortSignal.aborted).toBe(true);
  expect(providerCancellation).toHaveBeenCalledOnce();
  retainedRun.release();
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: recovered.key, storePath })?.createdActor,
  ).toEqual(humanActor(owner));
});
