import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  emitSessionTranscriptUpdate,
  resetTranscriptUpdateListener,
  SessionStartupCatchupHarness,
  startupHarnessDatabases,
} from "./manager-sync-ops.startup-catchup.test-support.js";

const { activity } = await vi.hoisted(() => import("./manager-session-activity.test-support.js"));

describe("session index scheduling", () => {
  let testState: OpenClawTestState;
  let harness: SessionStartupCatchupHarness;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-scheduling-",
      layout: "state-only",
    });
    await captureRuntimeConfigAsyncReader()();
    harness = await SessionStartupCatchupHarness.create([]);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    harness.startTranscriptListener();
  });

  afterEach(async () => {
    harness.stopTranscriptListener();
    vi.clearAllTimers();
    vi.useRealTimers();
    resetTranscriptUpdateListener();
    for (const database of startupHarnessDatabases) {
      await database.closeShadow();
    }
    startupHarnessDatabases.clear();
    await testState.restoreEnv();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetPluginStateStoreForTests();
    await testState.cleanup();
  });

  function append(sessionId: string) {
    const target = { agentId: "main", sessionId, sessionKey: `agent:main:chat:${sessionId}` };
    emitSessionTranscriptUpdate({ target });
    return target;
  }
  const pass = (...sessions: Array<ReturnType<typeof append> | undefined>) => ({
    reason: "session-delta",
    sessions,
    archiveFiles: [],
  });
  const catchup = { reason: "session-startup-catchup" };
  async function expectPendingFor(delay: number) {
    await vi.advanceTimersByTimeAsync(delay);
    expect(harness.syncCalls).toEqual([]);
  }
  async function expectPassAfter(delay: number, ...sessions: ReturnType<typeof append>[]) {
    await vi.advanceTimersByTimeAsync(delay);
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([pass(...sessions)]);
  }
  async function expectAttemptsAfter(delay: number, index: unknown, count: number) {
    await vi.advanceTimersByTimeAsync(delay);
    expect(index).toHaveBeenCalledTimes(count);
  }
  function fallbackFixture(sessionId: string, persistentFailure = false) {
    const target = append(sessionId);
    const error = createMemoryEmbeddingOperationError({
      operation: "batch",
      cause: "embedding backend failed",
    });
    const state = { lastAttemptAt: 0, rebuildNext: false };
    const fail = async () => {
      state.lastAttemptAt = Date.now();
      throw error;
    };
    const index = vi.fn(async () => {});
    if (persistentFailure) {
      index.mockImplementation(fail);
    } else {
      index.mockImplementationOnce(fail);
    }
    harness["syncArchiveFiles"] = index;
    harness["activateFallbackProvider"] = vi.fn(async () => true);
    harness["sync"] = async (params) => {
      harness.syncCalls.push(params ?? {});
      if (state.rebuildNext || (!persistentFailure && params?.reason !== "session-delta")) {
        state.rebuildNext = false;
        await harness.runSyncForTest(params);
      } else {
        await harness["syncTargetedSessions"](new Set([`/tmp/${sessionId}.jsonl`]));
      }
    };
    return { target, index, state };
  }

  it("waits for a fresh quiet period and includes every pending session in one pass", async () => {
    const first = append("first");
    await vi.advanceTimersByTimeAsync(20_000);
    const second = append("second");
    append("first");
    await expectPendingFor(29_999);
    await expectPassAfter(1, first, second);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(harness.syncCalls).toHaveLength(1);
  });

  it("bounds continuous transcript deferral at five minutes", async () => {
    const target = append("continuous");
    for (let elapsed = 0; elapsed < 280_000; elapsed += 20_000) {
      await vi.advanceTimersByTimeAsync(20_000);
      append("continuous");
    }
    await expectPendingFor(19_999);
    await expectPassAfter(1, target);
  });

  it("starts overdue work as soon as a long running turn settles", async () => {
    activity.listener?.(true);
    const target = append("busy");
    await expectPendingFor(360_000);
    activity.listener?.(false);
    await expectPassAfter(1, target);
  });

  it("caps deferral across back-to-back turns and only starts in an idle gap", async () => {
    const target = { agentId: "main", sessionId: "busy", sessionKey: "agent:main:chat:busy" };
    for (let turn = 0; turn < 15; turn++) {
      activity.listener?.(true);
      append("busy");
      await expectPendingFor(20_000);
      activity.listener?.(false);
      await vi.advanceTimersByTimeAsync(1);
      if (turn < 14) {
        expect(harness.syncCalls).toEqual([]);
      }
    }
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([pass(target)]);
  });

  it("keeps pending work when a new turn starts during the quiet period", async () => {
    const first = append("before-turn");
    await vi.advanceTimersByTimeAsync(29_000);
    activity.listener?.(true);
    const second = append("during-turn");
    await expectPendingFor(60_000);
    activity.listener?.(false);
    await expectPassAfter(30_000, first, second);
  });

  it("retries a failed pass with its original targets and updates queued during that pass", async () => {
    const first = append("first");
    const second = append("second");
    let third: ReturnType<typeof append> | undefined;
    const sync = vi.spyOn(
      harness as unknown as { sync: (params: { reason?: string }) => Promise<void> },
      "sync",
    );
    sync.mockImplementationOnce(async (params) => {
      harness.syncCalls.push(params);
      third = append("third");
      append("first");
      throw new Error("temporary index publication failure");
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.syncCalls).toEqual([pass(first, second)]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(harness.syncCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([pass(first, second), pass(first, second, third)]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(harness.syncCalls).toHaveLength(2);
    sync.mockRestore();
  });

  it("keeps the final automatic retry until a long rebuild cooldown expires", async () => {
    const { target, index } = fallbackFixture("cooldown");
    // Earlier rebuild failures have reached the existing thirty-minute cap.
    for (let attempt = 0; attempt < 7; attempt++) {
      harness["recordFullReindexFailure"](false);
    }
    await expectAttemptsAfter(30_000, index, 1);
    await vi.advanceTimersByTimeAsync(60_000 + 300_000);
    expect(harness.syncCalls).toEqual([pass(target), catchup, catchup]);
    await expectAttemptsAfter(1_800_000 - 390_000 - 1, index, 1);
    expect(harness.syncCalls).toHaveLength(3);

    await expectAttemptsAfter(1, index, 2);
    expect(harness.syncCalls).toHaveLength(4);
    await expectAttemptsAfter(3_600_000, index, 2);
  });

  it("backs off handled fallback failures, yields to turns, and stops retrying until new activity", async () => {
    const { target, index, state } = fallbackFixture("fallback", true);
    await expectAttemptsAfter(30_000, index, 1);
    for (const [attempt, delay] of [60_000, 300_000, 900_000].entries()) {
      await expectAttemptsAfter(state.lastAttemptAt + delay - Date.now() - 1, index, attempt + 1);
      if (attempt === 1) {
        activity.listener?.(true);
        await expectAttemptsAfter(60_000, index, attempt + 1);
        activity.listener?.(false);
      }
      await expectAttemptsAfter(1, index, attempt + 2);
    }
    await expectAttemptsAfter(3_600_000, index, 4);
    expect(harness.syncCalls).toEqual([pass(target), catchup, catchup, catchup]);
    expect(harness["sessionsFullRetryDirty"]).toBe(true);

    index.mockResolvedValue(undefined);
    activity.listener?.(true);
    await expectAttemptsAfter(30_000, index, 4);
    harness["recordFullReindexFailure"](false);
    state.rebuildNext = true;
    activity.listener?.(false);
    await expectAttemptsAfter(1, index, 4);
    await expectAttemptsAfter(59_998, index, 4);
    await expectAttemptsAfter(2, index, 5);
    await expectAttemptsAfter(3_600_000, index, 5);
  });
});
