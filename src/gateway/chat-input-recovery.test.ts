import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperatorInputRecoverySource,
  createRestartRecoveryOperatorSource,
} from "../agents/operator-run-recovery-source.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import * as pendingInputSources from "../config/sessions/session-pending-input-source.js";
import { discardSessionPendingInput } from "../config/sessions/session-pending-input-withdrawal.js";
import { loadOrCreateDeviceIdentityAsync } from "../infra/device-identity-async.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatInputRecovery } from "./chat-input-recovery-source.js";
import {
  CHAT_INPUT_RECOVERY_MAX_AGE_MS,
  readChatInputRecoveryAdmission,
  resumeChatInput,
} from "./chat-input-recovery.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { handleChatAbortRequestWithLifecycle } from "./server-methods/chat-abort-handler.js";
import { normalizeChatSendRequest } from "./server-methods/chat-send-request.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./server-methods/chat.abort.test-helpers.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const dispatch = vi.hoisted(() => vi.fn());
const externalProvenance = { kind: "external_user" as const, sourceTool: "acp_bridge" };
const sourceReceipt = "[Synthetic trusted source receipt]";
vi.mock(import("./server-in-process-dispatch.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchGatewayRequestInProcess: dispatch,
}));

afterEach(() => {
  dispatch.mockReset();
  vi.restoreAllMocks();
});

async function withInput(
  run: (input: Awaited<ReturnType<typeof prepareInput>>) => Promise<void>,
  consumed = false,
  approvedText = "Approved redacted input",
  withProvenance = false,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const input = await prepareInput(stateDir, consumed, approvedText, withProvenance);
    await run(input);
  });
}

async function prepareInput(
  stateDir: string,
  consumed: boolean,
  approvedText: string,
  withProvenance: boolean,
) {
  await loadOrCreateDeviceIdentityAsync();
  const profile = ensureProfileForEmail("input-recovery@example.test");
  const fixture = await createOperatorRecoveryFixture({
    stateDir,
    context: createContext(),
    config: {},
    profileId: profile.id,
  });
  const request = await normalizeChatSendRequest({
    client: fixture.client,
    params: {
      sessionKey: fixture.target.sessionKey,
      idempotencyKey: fixture.target.sourceRunId,
      message: "Original private input",
      fastMode: true,
      timeoutMs: 42_000,
      queueMode: "followup",
      ...(withProvenance
        ? { systemInputProvenance: externalProvenance, systemProvenanceReceipt: sourceReceipt }
        : {}),
    },
  });
  if (!request.ok) {
    throw new Error(request.error);
  }
  const recovery = expectDefined(
    createChatInputRecovery({
      request: request.value,
      source: fixture.entry.restartRecoveryOperatorSource,
    }),
    "recoverable chat metadata",
  );
  const message: PersistedUserTurnMessage = {
    role: "user",
    content: approvedText,
    timestamp: Date.now(),
    idempotencyKey: `${fixture.target.sourceRunId}:user`,
    __openclaw: {
      chatInputRecovery: recovery,
      chatRequestIdentity: expectDefined(
        request.value.requestIdentity,
        "original request identity",
      ),
      media: [{ url: "media://inbound/synthetic.png", contentType: "image/png" }],
    },
  };
  const receipt = expectDefined(
    await stageSessionPendingInput(fixture.target, {
      runId: fixture.target.sourceRunId,
      requestFingerprint: "original-request-fingerprint",
      message,
      assertCurrent() {},
    }),
    "accepted chat input",
  );
  if (consumed) {
    await receipt.run(() =>
      persistSessionTranscriptTurn(fixture.target, {
        expectedSessionId: fixture.target.sessionId,
        messages: [{ message }],
      }),
    );
  }
  receipt.finish("interrupted");
  await receipt.settled?.();
  return {
    fixture,
    profile,
    message: receipt.message,
    target: { ...fixture.target, inputId: receipt.inputId, runId: fixture.target.sourceRunId },
    options: { signal: new AbortController().signal, assertCurrent: () => {} },
  };
}

describe("interrupted chat input recovery", () => {
  it("withdraws an interrupted input through chat.abort without stopping unrelated work", () =>
    withInput(async ({ fixture, target, options }) => {
      const running = createActiveRun(target.sessionKey, {
        ...target,
        runId: "unrelated-running-input",
      });
      const context = createChatAbortContext({
        sources: [["unrelated-running-input", running]],
        getRuntimeConfig: fixture.context.getRuntimeConfig,
        getSessionEventSubscriberConnIds: () => new Set(),
      });
      const respond = await invokeChatAbortHandler({
        handler: handleChatAbortRequestWithLifecycle,
        context,
        request: { sessionKey: target.sessionKey, runId: target.runId, discardPendingInput: true },
        client: fixture.client,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: [target.runId],
      });
      expect(
        (await pendingInputSources.readPendingInputSource(target, `${target.runId}:user`, true))
          ?.snapshot.pending?.state,
      ).toBe("cancelled");
      expect(running.input.abortSignal.aborted).toBe(false);
      await resumeChatInput(fixture.context, target, options);
      expect(dispatch).not.toHaveBeenCalled();
    }));

  it("keeps interrupted input when discard authority changes after its stored read", () =>
    withInput(async ({ fixture, target }) => {
      let current = true;
      const read = pendingInputSources.readPendingInputSource;
      vi.spyOn(pendingInputSources, "readPendingInputSource").mockImplementation(
        async (...args) => {
          const result = await read(...args);
          current = false;
          return result;
        },
      );
      const context = createChatAbortContext({
        getRuntimeConfig: fixture.context.getRuntimeConfig,
        getSessionEventSubscriberConnIds: () => new Set(),
      });
      await expect(
        invokeChatAbortHandler({
          handler: (options) =>
            handleChatAbortRequestWithLifecycle({
              ...options,
              hasCurrentClientAuthority: () => current,
            }),
          context,
          request: {
            sessionKey: target.sessionKey,
            runId: target.runId,
            discardPendingInput: true,
          },
          client: fixture.client,
        }),
      ).rejects.toThrow(/authority changed/);
      expect((await read(target, `${target.runId}:user`, true))?.snapshot.pending?.state).toBe(
        "interrupted",
      );
    }));

  it("retains approved input, media, identity, provenance and chat options under the original operator", () =>
    withInput(
      async ({ fixture, target, message, options }) => {
        dispatch.mockImplementation(async (method, params, requestOptions) => {
          expect(method).toBe("chat.send");
          expect(params).toMatchObject({
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            idempotencyKey: target.runId,
            message: "Approved redacted input",
            fastMode: true,
            timeoutMs: 42_000,
            queueMode: "followup",
          });
          expect(JSON.stringify(params)).not.toContain("Original private input");
          expect(readChatInputRecoveryAdmission(target.runId)).toMatchObject({
            message,
            requestFingerprint: "original-request-fingerprint",
            clientInfo: fixture.client.connect.client,
          });
          const normalized = await normalizeChatSendRequest({
            params,
            client: requestOptions.client,
          });
          expect(normalized).toMatchObject({
            ok: true,
            value: {
              requestIdentity: message["__openclaw"]?.chatRequestIdentity,
              systemInputProvenance: externalProvenance,
              systemProvenanceReceipt: sourceReceipt,
            },
          });
          requestOptions.sessionMutationCommitGuard();
          expect(requestOptions.client.internal.operatorRunAuthority.profileId).toBe(
            fixture.client.authenticatedUserProfile?.profileId,
          );
        });
        await resumeChatInput(fixture.context, target, options);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(readChatInputRecoveryAdmission(target.runId)).toBeUndefined();
      },
      false,
      "Approved redacted input",
      true,
    ));

  it.each(["cancelled", "consumed", "expired", "archived", "replaced", "permission"] as const)(
    "does not dispatch a %s input",
    (change) =>
      withInput(async ({ fixture, target, profile, options }) => {
        if (change === "cancelled") {
          await discardSessionPendingInput(target, target.runId, options.assertCurrent);
        } else if (change === "expired") {
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + CHAT_INPUT_RECOVERY_MAX_AGE_MS + 1);
        } else if (change === "archived" || change === "replaced") {
          await replaceSessionEntry(target, {
            ...fixture.entry,
            ...(change === "archived" ? { archivedAt: Date.now() } : { sessionId: "replacement" }),
          });
        } else if (change === "permission") {
          setUserProfileRole(profile.id, "changed-role");
        }
        const result = resumeChatInput(fixture.context, target, options);
        if (change === "expired" || change === "archived" || change === "permission") {
          await expect(result).rejects.toThrow();
        } else {
          await result;
        }
        expect(dispatch).not.toHaveBeenCalled();
      }, change === "consumed"),
  );

  it.each(["/stop", "/new"])(
    "does not interpret approved plain input transformed into %s as a command",
    (approvedText) =>
      withInput(
        async ({ fixture, target, options }) => {
          dispatch.mockImplementation(async (_method, params, requestOptions) => {
            expect(params.suppressCommandInterpretation).toBeUndefined();
            const normalized = await normalizeChatSendRequest({
              params,
              client: requestOptions.client,
            });
            expect(normalized).toMatchObject({
              ok: true,
              value: {
                rawMessage: approvedText,
                stopCommand: false,
                turnKind: "main",
                suppressCommandInterpretation: true,
              },
            });
          });
          await resumeChatInput(fixture.context, target, options);
          expect(dispatch).toHaveBeenCalledOnce();
        },
        false,
        approvedText,
      ),
  );

  it("rechecks live operator authority after dispatch preparation yields", () =>
    withInput(async ({ fixture, target, profile, options }) => {
      dispatch.mockImplementation(async (_method, _params, requestOptions) => {
        await Promise.resolve();
        setUserProfileRole(profile.id, "changed-role");
        requestOptions.sessionMutationCommitGuard();
      });
      await expect(resumeChatInput(fixture.context, target, options)).rejects.toThrow(/changed/);
    }));

  it("captures pending user input authority for child sessions without changing main-turn recovery", () =>
    withInput(async ({ fixture }) => {
      const captured = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: fixture.client,
          context: fixture.context,
          sourceAuthority: null,
        }),
        "current operator",
      );
      try {
        const params = {
          authority: captured.authority,
          entry: { ...fixture.entry, spawnedBy: "agent:main:parent", spawnDepth: 1 },
          ...fixture.target,
        };
        expect(createRestartRecoveryOperatorSource(params)).toBeUndefined();
        expect(createOperatorInputRecoverySource(params)).toMatchObject({
          sessionId: fixture.target.sessionId,
          sourceRunId: fixture.target.sourceRunId,
        });
      } finally {
        captured.release();
      }
    }));
});
