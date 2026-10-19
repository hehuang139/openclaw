import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { withoutGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  prepareSessionsSendCommunication,
  SessionCommunicationDeniedError,
} from "../agents/tools/sessions-send-communication.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import { readPendingInputSource } from "../config/sessions/session-pending-input-source.js";
import { parseSessionPendingInputMessage } from "../config/sessions/session-pending-input-value.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CommunicationEndpoint } from "../sessions/communication-admission.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import {
  readSessionSendDelivery,
  type SessionSendDelivery,
  type SessionSendDeliveryEndpoint,
} from "./session-send-delivery.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

export class SessionSendEndpointChangedError extends Error {
  constructor(
    endpoint: "source" | "target",
    expected: SessionSendDeliveryEndpoint,
    current: CommunicationEndpoint,
    message = "Session delivery endpoint was replaced",
  ) {
    super(
      `${message}: ${JSON.stringify({
        endpoint,
        reason: "endpoint-replaced",
        sessionKeyHash: sha256HexPrefixCore(expected.sessionKey, 16),
        previousSessionId: expected.sessionId,
        currentSessionId: current.entry?.sessionId ?? null,
        previousGeneration: expected.lifecycleRevision ?? null,
        currentGeneration: current.entry?.lifecycleRevision ?? null,
        archived: Boolean(current.entry?.archivedAt),
      })}`,
    );
  }
}

/** Both pending replay and consumed-input recovery use the same current peer policy. */
export async function prepareSessionSendRecoveryCommunication(params: {
  config: OpenClawConfig;
  delivery: SessionSendDelivery;
  inputProvenance: PersistedUserTurnMessage["provenance"];
  target: Pick<SessionSendDeliveryEndpoint, "agentId" | "sessionKey" | "sessionId">;
  assertCurrent: () => void;
  signal?: AbortSignal;
}) {
  const load = async (
    side: "source" | "target",
    expected: SessionSendDeliveryEndpoint,
  ): Promise<CommunicationEndpoint> => {
    const loaded = await resolveGatewaySessionStoreTargetInWorker({
      cfg: params.config,
      key: expected.sessionKey,
      agentId: expected.agentId,
      assertActive: params.assertCurrent,
      projection: "full",
    });
    const current = {
      agentId: loaded.agentId,
      sessionKey: loaded.canonicalKey,
      storePath: loaded.readSource?.path ?? loaded.storePath,
      entry: loaded.store[loaded.canonicalKey],
    };
    if (
      current.agentId !== expected.agentId ||
      current.sessionKey !== expected.sessionKey ||
      current.entry?.sessionId !== expected.sessionId ||
      current.entry.lifecycleRevision !== expected.lifecycleRevision
    ) {
      throw new SessionSendEndpointChangedError(side, expected, current);
    }
    return current;
  };
  const [source, target] = await Promise.all([
    load("source", params.delivery.source),
    load("target", params.delivery.target),
  ]);
  if (
    target.agentId !== params.target.agentId ||
    target.sessionKey !== params.target.sessionKey ||
    target.entry?.sessionId !== params.target.sessionId
  ) {
    throw new SessionSendEndpointChangedError(
      "target",
      params.delivery.target,
      target,
      "Session delivery target does not own this input",
    );
  }
  if (source.entry?.archivedAt || target.entry?.archivedAt) {
    return undefined;
  }
  // The accepted input survives its sender turn; a triggering turn cannot lend it authority.
  return withoutGatewayToolCallerIdentity(() =>
    prepareSessionsSendCommunication({
      config: params.config,
      source,
      target,
      message: params.delivery.message,
      dispatchMessage: params.delivery.message,
      inputProvenance: params.inputProvenance,
      access: { sandboxed: params.delivery.sandboxed },
      allowApproval: false,
      assertSourceCurrent: params.assertCurrent,
      callGateway: async () => {
        throw new Error("Session delivery recovery requires current direct access");
      },
      signal: params.signal,
    }),
  );
}

/** Restore the consumed input's current source without delivering its message again. */
export async function prepareConsumedSessionSendSource(params: {
  config?: OpenClawConfig;
  target: SessionSendDeliveryEndpoint & { storePath: string };
  sourceRunId: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<{ source: SessionSourceAssertion; release: () => void } | undefined> {
  const runKey = buildRunUserTurnIdempotencyKey(params.sourceRunId);
  const keys = params.sourceRunId.endsWith(":user") ? [params.sourceRunId, runKey] : [runKey];
  for (const key of keys) {
    const retained = await readPendingInputSource(params.target, key, false);
    const snapshot = retained?.snapshot;
    if (!retained || !snapshot?.current) {
      return undefined;
    }
    // A collected input may retain its consumed row; ordinary input lives in the transcript.
    const message = snapshot.pending
      ? snapshot.pending.consumed_event_id == null
        ? undefined
        : parseSessionPendingInputMessage(snapshot.pending.message_json)
      : snapshot.committed;
    if (!message) {
      continue;
    }
    const delivery = readSessionSendDelivery(message);
    if (
      !delivery ||
      (delivery.runId !== params.sourceRunId && message.idempotencyKey !== params.sourceRunId)
    ) {
      continue;
    }
    const assertCurrent = () => {
      params.assertCurrent();
      retained.assertCurrent();
    };
    const communication = await prepareSessionSendRecoveryCommunication({
      config: params.config ?? readRuntimeConfig(),
      delivery,
      inputProvenance: message.provenance,
      target: params.target,
      assertCurrent,
      signal: params.signal,
    });
    if (!communication) {
      throw new SessionCommunicationDeniedError("Session delivery endpoint is archived");
    }
    return {
      source: () => {
        assertCurrent();
        communication.assertCurrent();
      },
      release: communication.close,
    };
  }
  return undefined;
}
