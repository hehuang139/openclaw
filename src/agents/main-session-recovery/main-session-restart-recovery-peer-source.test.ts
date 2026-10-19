import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readPendingInputSource } from "../../config/sessions/session-pending-input-source.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentTurnTestContext } from "../../gateway/agent-turn/agent-run-dispatch.test-support.js";
import {
  prepareAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
} from "../../gateway/agent-turn/agent-run-user-turn.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { readSessionSendDelivery } from "../../gateway/session-send-delivery.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { buildCurrentRunRestartRecoveryClaim } from "../agent-command-restart-recovery.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { prepareSessionsSendCommunication } from "../tools/sessions-send-communication.js";
import { markStartupOrphanedMainSessionsForRecovery } from "./main-session-restart-recovery-marking.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

afterEach(() => {
  testing.resetSessionControllerForTest();
  resetGatewayWorkAdmission();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it("recovers a consumed peer input through two process losses without replaying the input", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const source = {
      agentId: "main",
      sessionKey: "agent:main:peer-source",
      sessionId: "peer-source-session",
      lifecycleRevision: "peer-source-generation",
    };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:peer-target",
      sessionId: "peer-target-session",
      lifecycleRevision: "peer-target-generation",
      storePath,
    };
    const runId = "accepted-peer-input";
    const message = "Complete the saved peer task.";
    const provenance = {
      kind: "inter_session" as const,
      sourceTool: "sessions_send",
      sourceSessionKey: source.sessionKey,
    };
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      session: { store: storePath, communication: { send: "always", receive: "always" } },
      tools: { sessions: { visibility: "all" } },
    };
    setRuntimeConfigSnapshot(cfg);
    const sourceEntry = { ...source, updatedAt: 1 };
    const targetEntry = {
      sessionId: target.sessionId,
      lifecycleRevision: target.lifecycleRevision,
      updatedAt: 1,
    };
    await replaceSessionEntry({ ...source, storePath }, sourceEntry);
    await replaceSessionEntry(target, targetEntry);
    const receiver = vi.fn(async () => {
      const turn = await prepareAgentRunUserTurn({
        assertCurrent() {},
        onUserTurnMediaPersisted() {},
        request: { message, idempotencyKey: runId, deliver: false },
        cfg,
        sessionEntry: targetEntry,
        resolvedSessionKey: target.sessionKey,
        admittedSessionId: target.sessionId,
        activeSessionAgentId: target.agentId,
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: true,
        message,
        effectiveTranscriptInputText: message,
        inputProvenance: provenance,
        images: [],
        offloadedRefs: [],
        runId,
        client: null,
        context: createAgentTurnTestContext(),
      });
      try {
        expect(await turn.recorder!.persistApproved()).toMatchObject({ appended: true });
        await turn.recorder!.completeProcessingAsync!(
          buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
        );
      } finally {
        await releasePreparedAgentRunUserTurn(turn);
      }
      return { runId, status: "accepted" };
    });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const endpoint = async (sessionKey: string) => {
      const loaded = await resolveGatewaySessionStoreTargetInWorker({
        cfg,
        key: sessionKey,
        agentId: "main",
        assertActive() {},
        projection: "full",
      });
      return {
        agentId: loaded.agentId,
        sessionKey: loaded.canonicalKey,
        storePath: loaded.readSource?.path ?? loaded.storePath,
        entry: loaded.store[loaded.canonicalKey],
      };
    };
    const communication = await withPluginRuntimeGatewayContextResolver(
      () => context,
      async () =>
        prepareSessionsSendCommunication({
          config: cfg,
          source: await endpoint(source.sessionKey),
          target: await endpoint(target.sessionKey),
          message,
          inputProvenance: provenance,
          allowApproval: false,
          callGateway: async <T>() => (await receiver()) as T,
        }),
    );
    try {
      await communication.callGateway({
        method: "agent",
        params: {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          message,
          inputProvenance: provenance,
          idempotencyKey: runId,
        },
      });
    } finally {
      communication.close();
    }
    const accepted = await readPendingInputSource(target, `${runId}:user`, false);
    // Standalone input promotion removes its queue row; committed bytes retain its source.
    expect(accepted?.snapshot.pending).toBeUndefined();
    expect(accepted?.snapshot.committed).toBeDefined();
    const originalTranscript = await loadTranscriptEvents(target);
    const savedMessage = expectDefined(accepted?.snapshot.committed, "accepted peer input");
    expect(readSessionSendDelivery(savedMessage)).toMatchObject({
      runId,
      source,
      target: { sessionKey: target.sessionKey, sessionId: target.sessionId },
    });
    await updateSessionEntry(target, (entry) => ({
      ...buildCurrentRunRestartRecoveryClaim({
        entry,
        runId,
        sourceRunId: runId,
        sourceIngress: "internal",
      }),
      lifecycleRunId: runId,
      status: "interrupted",
      abortedLastRun: true,
    }));

    const dispatchGate = createDeferred();
    const finalDispatchGate = createDeferred();
    const dispatches: string[] = [];
    const skipped: string[] = [];
    let assertEffectCurrent: (() => void) | undefined;
    let current = true;
    const runtime: GatewayRecoveryRuntime = {
      prepareRestartRecovery: () => undefined,
      dispatchSessionMethod: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
      dispatchAgent: async <T>(
        request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeout?: number,
        options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        await options?.prepareDispatchCurrent?.();
        options?.assertAdmissionCurrent?.();
        assertEffectCurrent = options?.assertAdmissionCurrent;
        dispatches.push(request.message);
        options?.onStartOwner?.({
          observe: () => ({ executionStarted: true }),
          abort: () => false,
        });
        options?.onAccepted?.({ runId: request.idempotencyKey, status: "accepted" });
        options?.onExecutionStarted?.();
        await (dispatches.length === 1 ? dispatchGate.promise : finalDispatchGate.promise);
        return { runId: request.idempotencyKey, status: "ok" } as T;
      },
    };
    const recover = () =>
      recoverStore({
        storeAgentId: target.agentId,
        storePath,
        cfg,
        handledSessionKeys: new Set(),
        gatewayRuntime: runtime,
        onSkipped: (reason) => skipped.push(reason),
        shouldContinue: () => current,
      });
    try {
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
      rotateAgentEventLifecycleGeneration();
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
      const firstRecovery = await recover();
      expect(skipped).toEqual([]);
      expect(firstRecovery).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
      expect(() => assertEffectCurrent!()).not.toThrow();
      await updateSessionEntry({ ...source, storePath }, () => ({
        communication: { send: "never" },
      }));
      expect(() => assertEffectCurrent!()).toThrow(/communication/i);
      await updateSessionEntry({ ...source, storePath }, () => ({
        communication: { send: "always" },
      }));

      // The admitted continuation vanishes without a terminal owner receipt.
      current = false;
      dispatchGate.resolve();
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
      testing.resetSessionControllerForTest();
      rotateAgentEventLifecycleGeneration();
      current = true;
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
      expect(await recover()).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(dispatches).toHaveLength(2);
      expect(
        dispatches.every((prompt) => prompt.includes("Your previous turn was interrupted")),
      ).toBe(true);
      expect(receiver).toHaveBeenCalledOnce();
      expect(() => assertEffectCurrent!()).not.toThrow();
      finalDispatchGate.resolve();
      await vi.waitFor(() => {
        expect(() => assertEffectCurrent!()).toThrow();
      });
      expect(loadSessionEntry(target)).toMatchObject({ abortedLastRun: false });
      expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
      expect(await loadTranscriptEvents(target)).toEqual(originalTranscript);
    } finally {
      current = false;
      dispatchGate.resolve();
      finalDispatchGate.resolve();
    }
  });
});
