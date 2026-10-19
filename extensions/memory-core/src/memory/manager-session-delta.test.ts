import type { DatabaseSync } from "node:sqlite";
import { publishSessionTranscriptUpdateByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const activity = vi.hoisted(() => ({
  listener: undefined as ((busy: boolean) => void) | undefined,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    observeAgentRunActivity: (_agentId: string, listener: (busy: boolean) => void) => {
      activity.listener = listener;
      listener(false);
      return () => {
        activity.listener = undefined;
      };
    },
  };
});

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory session delta publication", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig, getFreshManager, seedSessionTranscript } = fixture;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  });
  async function createSessionManager(cacheEnabled?: boolean) {
    const manager = await getFreshManager(
      createConfig({ sources: ["sessions"], sessionMemory: true, cacheEnabled }),
    );
    onTestFinished(() => manager.close());
    return manager;
  }
  async function settle(manager: Awaited<ReturnType<typeof getFreshManager>>, delay = 30_000) {
    await vi.advanceTimersByTimeAsync(delay);
    await (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
  }
  function interruptNextBatch() {
    fixture.provider.beforeEmbedBatch = async () => {
      fixture.provider.beforeEmbedBatch = null;
      activity.listener?.(true);
    };
  }
  const sessionIdentity = (sessionId: string) => ({
    sessionId,
    sessionKey: `agent:main:chat:${sessionId}`,
  });
  const message = (content: string) => ({ role: "user" as const, timestamp: Date.now(), content });

  it("yields an interrupted pass and indexes every pending session after the next quiet period", async () => {
    const manager = await createSessionManager(true);
    await manager.sync({ reason: "initial", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const sessions = Array.from({ length: 9 }, (_, index) => sessionIdentity(`resume-${index}`));
    for (const session of sessions) {
      await seedSessionTranscript({
        ...session,
        messages: [message(`resumeproof alpha ${session.sessionId}`)],
      });
      await publishSessionTranscriptUpdateByIdentity({ agentId: "main", ...session });
    }
    interruptNextBatch();
    const indexedPaths = () =>
      database
        .prepare("SELECT path FROM memory_index_sources WHERE source = 'sessions' ORDER BY path")
        .all();

    await settle(manager);
    expect(fixture.provider.embedBatchCalls).toBeGreaterThan(0);
    expect(indexedPaths()).toEqual([]);

    activity.listener?.(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(indexedPaths()).toEqual([]);
    await settle(manager, 1);
    expect(indexedPaths()).toEqual(
      sessions.map(({ sessionId }) => ({ path: `sessions/main/${sessionId}.jsonl` })),
    );
    expect(
      database
        .prepare(
          "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? ORDER BY path",
        )
        .all("resumeproof"),
    ).toEqual(indexedPaths());
    expect(manager.status().dirty).toBe(false);
  });

  it("keeps the published index when a background rebuild is interrupted", async () => {
    const target = sessionIdentity("rebuild");
    await seedSessionTranscript({
      ...target,
      messages: [message("stableproof original")],
    });
    const manager = await createSessionManager();
    await manager.sync({ reason: "initial", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const read = (query: string) =>
      readPublishedSessionIndex(database, "sessions/main/rebuild.jsonl", query);
    const before = read("stableproof");
    await seedSessionTranscript({
      ...target,
      messages: [message("newproof appended")],
    });
    Reflect.set(manager, "memoryFullRetryDirty", true);
    interruptNextBatch();
    await publishSessionTranscriptUpdateByIdentity({ agentId: "main", ...target });
    await settle(manager);
    expect(read("stableproof")).toEqual(before);
    expect(manager.status().dirty).toBe(true);

    activity.listener?.(false);
    await settle(manager);
    expect(read("newproof").search).not.toEqual([]);
    expect(manager.status().dirty).toBe(false);
  });

  it("settles ten queued turns incrementally with the same search results as a full reindex", async () => {
    const sessionId = "growing-session";
    const sessionKey = `agent:main:chat:${sessionId}`;
    const sessionPath = `sessions/main/${sessionId}.jsonl`;
    // Each long turn fills its own chunk, so appends leave earlier chunks unchanged.
    const turn = (index: number) =>
      message(`turnmarker${index} ` + `topic${index} detail `.repeat(400));
    const manager = await createSessionManager(false);
    await (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
    await seedSessionTranscript({ sessionId, sessionKey, messages: [1, 2, 3, 4].map(turn) });
    await manager.sync({ reason: "initial", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const read = (query: string) => readPublishedSessionIndex(database, sessionPath, query);
    const initial = read("turnmarker1");
    const before = initial.chunks;
    expect(before.length).toBeGreaterThan(2);

    fixture.provider.embeddedBatchTexts = [];
    for (let index = 5; index < 15; index += 1) {
      await seedSessionTranscript({ sessionId, sessionKey, messages: [turn(index)] });
      await publishSessionTranscriptUpdateByIdentity({ agentId: "main", sessionId, sessionKey });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(read("turnmarker14").search).toEqual([]);
    expect(fixture.provider.embeddedBatchTexts).toEqual([]);
    await settle(manager);

    const after = read("turnmarker14");
    expect(after.search).not.toEqual([]);
    const kept = before.filter((row) => after.chunks.some((next) => next.id === row.id));
    // Only the trailing chunk may change; every earlier row stays untouched.
    expect(kept.length).toBeGreaterThanOrEqual(before.length - 1);
    expect(after.chunks).toEqual(expect.arrayContaining(kept));
    expect(read("turnmarker1").search).toEqual(initial.search);
    const texts = fixture.provider.embeddedBatchTexts;
    expect(texts.some((text) => /\bturnmarker1\b/.test(text))).toBe(false);
    expect(texts.some((text) => text.includes("turnmarker14"))).toBe(true);
    expect(manager.status().dirty).toBe(false);
    const search = async () =>
      (await manager.search("turnmarker14", { lexicalOnly: true, sources: ["sessions"] })).map(
        ({ path, startLine, endLine, snippet, source }) => [
          path,
          startLine,
          endLine,
          snippet,
          source,
        ],
      );
    const incrementalResults = await search();
    expect(incrementalResults.length).toBeGreaterThan(0);
    await manager.sync({ reason: "full-comparison", force: true });
    expect(await search()).toEqual(incrementalResults);
  });
});
