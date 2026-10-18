import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { readPendingInputSource } from "../../config/sessions/session-pending-input-source.js";
import { parseSessionPendingInputMessage } from "../../config/sessions/session-pending-input-value.js";
import { discardSessionPendingInput } from "../../config/sessions/session-pending-input-withdrawal.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getReservedRpcSourceInput,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  captureSessionControllerStop,
  stopSession,
  type SessionStopHookContext,
} from "../../sessions/session-controller.stop.js";
import { abortChatRunById, type ChatAbortOps } from "../chat-abort.js";
import { decodeGatewayOperatorRecoverySource } from "../operator-run-recovery-source.js";
import type { resolveChatAbortTargetRejection } from "./chat-abort-authorization.js";
import { abortControlledSubagents } from "./chat-abort-descendants.js";
import type { ChatAbortSessionSnapshot } from "./chat-aborted-partial.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

/** Withdraw saved input without invoking Stop hooks for an unrelated current turn. */
export async function discardInterruptedClientInput(params: {
  context: GatewayRequestContext;
  session: ChatAbortSessionSnapshot;
  runId: string;
  assertCurrent: () => void;
  authorizeRunTarget: (
    target: Parameters<typeof resolveChatAbortTargetRejection>[0]["target"],
  ) => boolean;
  respond: GatewayRequestHandlerOptions["respond"];
}): Promise<void> {
  const { context, session, runId, assertCurrent, authorizeRunTarget, respond } = params;
  if (!session.ok || !session.value.entry) {
    respond(true, { ok: true, aborted: false, runIds: [] });
    return;
  }
  const target = {
    agentId: session.value.agentId,
    storePath: session.value.storePath,
    sessionKey: session.value.canonicalKey,
    sessionId: session.value.entry.sessionId,
  };
  let withdrawn = false;
  const retained = await readPendingInputSource(target, `${runId}:user`, true);
  assertCurrent();
  const row = retained?.snapshot.pending;
  if (
    retained?.snapshot.current &&
    row?.run_id === runId &&
    row.state === "interrupted" &&
    row.consumed_event_id == null
  ) {
    const recovery = parseSessionPendingInputMessage(row.message_json)["__openclaw"]
      ?.chatInputRecovery;
    const source = isRecord(recovery)
      ? decodeGatewayOperatorRecoverySource(recovery.source)
      : undefined;
    if (
      source &&
      (source.agentId !== target.agentId ||
        source.sessionKey !== target.sessionKey ||
        source.sessionId !== target.sessionId ||
        source.sourceRunId !== runId)
    ) {
      throw new Error("Interrupted input does not match its original admission.");
    }
    if (
      !authorizeRunTarget({
        ...target,
        requester: source?.snapshot.device
          ? { deviceId: source.snapshot.device.deviceId }
          : undefined,
      })
    ) {
      return;
    }
    withdrawn = await discardSessionPendingInput(target, runId, () => {
      assertCurrent();
      retained.assertCurrent();
      // Recovery may have claimed this input while its saved source was being read.
      if (
        getRpcSourceForGateway(runId, context.resolveGatewayContext) ||
        getReservedRpcSourceInput(runId, { resolveGatewayContext: context.resolveGatewayContext })
      ) {
        throw new Error("Run changed before input removal; refresh and retry.");
      }
    });
    if (withdrawn) {
      emitSessionsChanged(
        context,
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          reason: "agent.input.settled",
        },
        { accessChanged: false },
      );
    }
  }
  respond(true, { ok: true, aborted: withdrawn, runIds: withdrawn ? [runId] : [] });
}

type ExactClientRunStopResult = {
  aborted: boolean;
  descendants?: Awaited<ReturnType<typeof abortControlledSubagents>>;
  failure?: { error: unknown };
};

/**
 * Stops one exact Gateway RPC run through Stop source `client-run`: its source
 * input, its chat presentation, and that turn's controlled subagents.
 */
export async function stopExactClientRun(params: {
  ops: ChatAbortOps;
  cfg: OpenClawConfig;
  runId: string;
  active: RpcSourceRef;
  assertCurrent?: () => void;
  hookContext: Omit<SessionStopHookContext, "sessionKey" | "sessionId">;
  /** Runs once the parent cancellation result is known. */
  afterParent?: () => void;
  /** Runs after the chat abort is prepared, before it commits. */
  onAbortPrepared?: () => (() => void) | void;
}): Promise<ExactClientRunStopResult> {
  const { ops, runId, active } = params;
  // Capture the exact input before any await can select a successor.
  const capture = captureSessionControllerStop({ inputs: [active.input] });
  const { sessionKey, sessionId, agentId } = getRpcSourceIdentity(active);
  const result: ExactClientRunStopResult = { aborted: false };
  const assertCurrent = () => {
    params.assertCurrent?.();
    const replacement = getRpcSourceForGateway(runId, getGatewayContextResolver(active.input));
    if (replacement) {
      const identity = getRpcSourceIdentity(replacement);
      if (
        replacement !== active ||
        identity.sessionKey !== sessionKey ||
        identity.sessionId !== sessionId ||
        identity.agentId !== agentId
      ) {
        throw new Error("Run changed before cancellation; retry Stop.");
      }
    }
  };
  try {
    await stopSession({
      source: "client-run",
      capture,
      assertCurrent,
      reason: createAgentRunDirectAbortError(),
      hookContext: { ...params.hookContext, sessionKey, sessionId },
      afterParent: params.afterParent,
      continueChildStop: () => result.aborted,
      onCancelled: (target) => {
        if (target === active.input) {
          result.aborted = true;
        }
      },
      cancelInput: (_input, cancel) =>
        abortChatRunById(ops, {
          runId,
          sessionKey,
          expectedEntry: active,
          cancel,
          assertCurrent,
          stopReason: "rpc",
          onAbortPrepared: params.onAbortPrepared,
          onAbortCommitted: () => {
            result.aborted = true;
          },
        }).aborted,
      stopChildren: async (applyParentStop) => {
        result.descendants = await abortControlledSubagents({
          cfg: params.cfg,
          sessionKey,
          agentId,
          requesterTurnRunId: runId,
          sessionId,
          assertCurrent,
          beforeKill: applyParentStop,
          parentStopAccepted: () => result.aborted,
        });
        return {
          stopped: result.descendants?.killed ?? 0,
          failed: result.descendants?.status === "error" ? result.descendants.failed : 0,
        };
      },
    }).completed;
  } catch (error) {
    if (result.aborted && result.descendants?.status === "error") {
      result.descendants = {
        ...result.descendants,
        failed: result.descendants.failed + 1,
        error: `${result.descendants.error}; ${formatErrorMessage(error)}`,
      };
    } else {
      result.failure = { error };
    }
  }
  return result;
}
