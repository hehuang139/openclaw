import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayClientInfo } from "../../packages/gateway-protocol/src/client-info.js";
import { MEDIA_ONLY_USER_TEXT } from "../sessions/user-turn-media.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export const CHAT_INPUT_RECOVERY_MAX_AGE_MS = 24 * 60 * 60_000;

export type ChatInputRecoveryTarget = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  inputId: string;
  runId: string;
};

type ChatInputRecoveryAdmission = {
  target: ChatInputRecoveryTarget;
  message: PersistedUserTurnMessage;
  requestFingerprint: string;
  clientInfo?: GatewayClientInfo;
  suppressCommandInterpretation: boolean;
};
const admission = resolveGlobalSingleton(
  Symbol.for("openclaw.chatInputRecoveryAdmission"),
  () => new AsyncLocalStorage<ChatInputRecoveryAdmission>(),
);

export function readChatInputRecoveryAdmission(
  runId: string,
): ChatInputRecoveryAdmission | undefined {
  const current = admission.getStore();
  return current?.target.runId === runId ? current : undefined;
}

/** Re-enter chat admission with exact durable custody and current operator authority. */
export async function resumeChatInput(
  context: GatewayRequestContext,
  target: ChatInputRecoveryTarget,
  options: { signal: AbortSignal; assertCurrent: () => void },
  methodRegistry?: GatewayMethodRegistry,
): Promise<void> {
  const [
    { readSessionEntryReadOnlyInWorker },
    { readPendingInputSource },
    { parseSessionPendingInputMessage },
    { restoreGatewayOperatorSource },
    { decodeGatewayOperatorRecoverySource },
    { dispatchGatewayRequestInProcess },
    { createSyntheticPluginRuntimeClient },
  ] = await Promise.all([
    import("../config/sessions/session-entry-read-runtime.js"),
    import("../config/sessions/session-pending-input-source.js"),
    import("../config/sessions/session-pending-input-value.js"),
    import("./operator-run-recovery.js"),
    import("./operator-run-recovery-source.js"),
    import("./server-in-process-dispatch.js"),
    import("./server-plugin-runtime-client.js"),
  ]);
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  assertCurrent();
  const retained = await readPendingInputSource(target, `${target.runId}:user`, true);
  assertCurrent();
  const row = retained?.snapshot.pending;
  if (!retained?.snapshot.current || !row || row.consumed_event_id != null) {
    return;
  }
  if (
    row.state !== "interrupted" ||
    row.input_id !== target.inputId ||
    row.run_id !== target.runId
  ) {
    return;
  }
  const message = parseSessionPendingInputMessage(row.message_json);
  const metadata = message["__openclaw"]?.chatInputRecovery;
  if (!isRecord(metadata) || metadata.version !== 1 || !isRecord(metadata.request)) {
    throw new Error("Interrupted chat input has no resumable operator source.");
  }
  const request = metadata.request;
  const source = decodeGatewayOperatorRecoverySource(metadata.source);
  if (
    source.agentId !== target.agentId ||
    source.sessionKey !== target.sessionKey ||
    source.sessionId !== target.sessionId ||
    source.sourceRunId !== target.runId ||
    !row.request_hash.startsWith("request:")
  ) {
    throw new Error("Interrupted chat input does not match its original admission.");
  }
  const assertAge = () => {
    if (Date.now() - row.accepted_at > CHAT_INPUT_RECOVERY_MAX_AGE_MS) {
      throw new Error("Interrupted chat input is older than the automatic recovery window.");
    }
  };
  const checkSource = async () => {
    assertCurrent();
    retained.assertCurrent();
    assertAge();
    const entry = await readSessionEntryReadOnlyInWorker(target, assertCurrent);
    assertCurrent();
    if (
      !entry ||
      entry.archivedAt ||
      entry.sessionId !== source.sessionId ||
      entry.lifecycleRevision !== source.lifecycleRevision
    ) {
      throw new Error("Interrupted chat input session was archived, reset, or replaced.");
    }
  };
  const restored = await restoreGatewayOperatorSource({
    target,
    snapshot: source.snapshot,
    context,
    assertCurrent,
    prepareCurrent: checkSource,
  });
  try {
    let accepted = false;
    const guard = () => {
      assertCurrent();
      retained.assertCurrent();
      if (!accepted) {
        assertAge();
      }
      restored.authority.assertCurrent();
    };
    const client = createSyntheticPluginRuntimeClient({
      authenticatedUserProfile: restored.authenticatedUserProfile,
      operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
      operatorRunAuthority: restored.authority,
      scopes: [...restored.authority.scopes],
    });
    const text = extractTextFromChatContent(message.content, { joinWith: "\n" }) ?? "";
    guard();
    await admission.run(
      {
        target,
        message,
        requestFingerprint: row.request_hash.slice("request:".length),
        clientInfo: isRecord(metadata.clientInfo)
          ? (metadata.clientInfo as GatewayClientInfo) // SAFETY: Stored by chat admission.
          : undefined,
        suppressCommandInterpretation: metadata.suppressCommandInterpretation === true,
      },
      () =>
        dispatchGatewayRequestInProcess(
          "chat.send",
          {
            ...request,
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            idempotencyKey: target.runId,
            message: text || MEDIA_ONLY_USER_TEXT,
          },
          {
            client,
            context,
            methodRegistry,
            signal: options.signal,
            prepareDispatchCurrent: checkSource,
            assertPreparationCurrent: guard,
            sessionMutationCommitGuard: guard,
            hasCurrentClientAuthority: () => {
              guard();
              return true;
            },
          },
        ),
    );
    accepted = true;
  } finally {
    restored.release();
  }
}
