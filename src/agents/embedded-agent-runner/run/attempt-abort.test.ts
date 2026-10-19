// Coverage for external cancellation and timeout paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { countActiveToolExecutions } from "../../embedded-agent-subscribe.handlers.tools.start.js";
import type { EmbeddedAgentQueueHandle } from "../runs.js";
import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
} from "./attempt-finalize.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./attempt-session-settle.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import type { EmbeddedAttemptExecutionState } from "./types.js";

const mocks = vi.hoisted(() => ({
  markActiveEmbeddedRunAbandoned: vi.fn(),
}));

vi.mock("../../embedded-agent-subscribe.handlers.tools.start.js");

vi.mock("../runs.js", () => ({
  markActiveEmbeddedRunAbandoned: mocks.markActiveEmbeddedRunAbandoned,
}));

function createAbortFixture(source = new AbortController()) {
  const runAbortController = new AbortController();
  const state: Pick<EmbeddedAttemptExecutionState, "terminal"> = { terminal: { kind: "ok" } };
  const abort = vi.fn(async (_reason?: unknown) => {});
  const tracker = createEmbeddedAttemptSessionSettleTracker({ abort });
  const cleanupAfterEarlyAbort = vi.fn(async () => {});
  const attempt = {
    abortSignal: source.signal,
    onAttemptTimeout: vi.fn(),
    runId: "run-test",
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-test",
    sessionKey: "agent:main",
    timeoutMs: 60_000,
  };
  const controller = createEmbeddedAttemptExternalAbortController({
    abortSignal: source.signal,
    cleanupAfterEarlyAbort,
    runAbortController,
    runId: attempt.runId,
    state,
  });
  const createRunAbort = (
    overrides: Partial<Parameters<typeof createEmbeddedAttemptRunAbort>[0]> = {},
  ) =>
    createEmbeddedAttemptRunAbort({
      abortActiveSession: tracker.abortActiveSession,
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt,
      getQueueHandle: () => undefined,
      isProbeSession: false,
      log: { warn: vi.fn() },
      runAbortController,
      state,
      ...overrides,
    });
  return {
    source,
    runAbortController,
    state,
    abort,
    tracker,
    cleanupAfterEarlyAbort,
    attempt,
    controller,
    createRunAbort,
  };
}

beforeEach(() => {
  vi.mocked(countActiveToolExecutions).mockReset().mockReturnValue(0);
  mocks.markActiveEmbeddedRunAbandoned.mockReset();
});

describe("createEmbeddedAttemptExternalAbortController", () => {
  it("preserves external cancellation through active session settlement", async () => {
    const { source, runAbortController, state, abort, tracker, controller } = createAbortFixture();
    controller.setActiveSessionAbort(tracker.abortActiveSession);
    controller.arm();
    const reason = new Error("cancelled");

    source.abort(reason);

    expect(state.terminal).toEqual({
      kind: "aborted",
      source: "external",
      failure: { source: "prompt", error: reason },
    });
    expect(runAbortController.signal.reason).toBe(reason);
    expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
    await tracker.buildAbortSettlePromise();
    controller.dispose();
  });

  it("classifies timeout during compaction without also blaming a tool", () => {
    const { source, runAbortController, state, controller } = createAbortFixture();
    vi.mocked(countActiveToolExecutions).mockReturnValue(1);
    controller.setCompactionState({
      isPendingOrRetrying: () => true,
      isInFlight: () => false,
    });
    controller.arm();
    const reason = new Error("deadline");
    reason.name = "TimeoutError";

    source.abort(reason);

    expect(projectAgentRunAttemptTerminal(state.terminal)).toMatchObject({
      aborted: true,
      externalAbort: true,
      timedOut: true,
      timedOutDuringCompaction: true,
      timedOutDuringToolExecution: false,
    });
    expect(runAbortController.signal.reason).toBe(reason);
    controller.dispose();
  });

  it("hands an external timeout to the live attempt exactly once", async () => {
    const {
      source,
      runAbortController,
      state,
      abort,
      tracker,
      controller,
      attempt,
      createRunAbort,
    } = createAbortFixture();
    const abortRun = createRunAbort({
      getQueueHandle: () => ({}) as EmbeddedAgentQueueHandle,
      isProbeSession: true,
    });
    controller.setRunAbort(abortRun);
    controller.setCompactionState({
      isPendingOrRetrying: () => false,
      isInFlight: () => false,
    });
    controller.arm();
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt,
      runAbortSignal: runAbortController.signal,
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 1_000,
      isProbeSession: true,
      abortRun,
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });

    try {
      const reason = new Error("upstream request timed out");
      reason.name = "TimeoutError";
      source.abort(reason);
      await tracker.buildAbortSettlePromise();

      expect(state.terminal).toEqual({
        kind: "timeout",
        phase: "prompt",
        source: "external",
        aborted: true,
      });
      expect(attempt.onAttemptTimeout).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
      expect(mocks.markActiveEmbeddedRunAbandoned).toHaveBeenCalledOnce();
    } finally {
      timeout.clearTimers();
      controller.dispose();
    }
  });

  it("classifies abort after preparation cleanup", async () => {
    const source = new AbortController();
    const reason = new Error("cancelled during setup");
    reason.name = "AbortError";
    source.abort(reason);
    const { cleanupAfterEarlyAbort, state, controller } = createAbortFixture(source);

    await expect(controller.throwIfFiredAfterPrepCleanup()).rejects.toBe(reason);

    expect(cleanupAfterEarlyAbort).toHaveBeenCalledOnce();
    expect(projectAgentRunAttemptTerminal(state.terminal)).toMatchObject({
      aborted: true,
      externalAbort: true,
      promptError: reason,
      timedOut: false,
    });
    const firstTerminal = state.terminal;
    controller.arm();
    expect(() => controller.throwIfFired()).toThrow(reason);
    expect(state.terminal).toBe(firstTerminal);
    controller.dispose();
  });
});

describe("createEmbeddedAttemptRunAbort", () => {
  it("settles timeout state, session work, and queue ownership", async () => {
    const { state, attempt, runAbortController, createRunAbort } = createAbortFixture();
    const timeoutReason = new Error("attempt deadline");
    timeoutReason.name = "TimeoutError";
    const abortCompaction = vi.fn();
    const abortActiveSession = vi.fn(async () => {});
    const queueHandle = {} as EmbeddedAgentQueueHandle;
    vi.mocked(countActiveToolExecutions).mockReturnValue(1);
    const abortRun = createRunAbort({
      abortActiveSession,
      activeSession: { abortCompaction, isCompacting: true },
      getQueueHandle: () => queueHandle,
    });

    abortRun(true, timeoutReason);
    await Promise.resolve();

    expect(state.terminal).toEqual({
      kind: "timeout",
      phase: "tool_execution",
      source: "runtime",
      aborted: true,
    });
    expect(attempt.onAttemptTimeout).toHaveBeenCalledWith(timeoutReason);
    expect(runAbortController.signal.reason).toBe(timeoutReason);
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(abortActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.markActiveEmbeddedRunAbandoned).toHaveBeenCalledWith({
      sessionId: "session-test",
      handle: queueHandle,
      sessionKey: "agent:main",
      sessionFile: "/tmp/session.jsonl",
      reason: "timeout",
    });
  });

  it("preserves a manual abort reason", () => {
    const abortReason = new Error("manual abort");
    const { runAbortController, createRunAbort } = createAbortFixture();
    const abortRun = createRunAbort();

    abortRun(false, abortReason);

    expect(runAbortController.signal.reason).toBe(abortReason);
  });
});
