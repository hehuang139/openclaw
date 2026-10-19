import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hashText,
  MEMORY_CHUNKING_VERSION,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { MEMORY_INDEX_PROVENANCE_VERSION, type MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });
const createConfig = (model = "mock-embed") =>
  fixture.createConfig({ model, vectorEnabled: false });
const alphaResult = expect.arrayContaining([
  expect.objectContaining({ path: "memory/2026-01-12.md" }),
]);
const versionKeys = ["chunkingVersion", "provenanceVersion"] as const;
const versions = {
  chunkingVersion: MEMORY_CHUNKING_VERSION,
  provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION,
};
type VersionKey = keyof typeof versions;

async function closeManager(manager: Awaited<ReturnType<typeof fixture.getFreshManager>>) {
  await manager.close();
  await closeAllMemorySearchManagers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}

function withDatabase<T>(dbPath: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function readMeta(db: DatabaseSync): MemoryIndexMeta {
  const row = db
    .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
    .get();
  if (typeof row?.value !== "string") {
    throw new Error("fixture index metadata is missing");
  }
  return JSON.parse(row.value) as MemoryIndexMeta;
}

function updateMeta(db: DatabaseSync, meta: MemoryIndexMeta) {
  db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
    JSON.stringify(meta),
  );
}
async function publishIndex(cfg: ReturnType<typeof createConfig>): Promise<string> {
  const manager = await fixture.getFreshManager(cfg);
  await manager.sync({ reason: "test", force: true });
  const dbPath = manager.status().dbPath;
  if (!dbPath) {
    throw new Error("fixture database path is missing");
  }
  await closeManager(manager);
  return dbPath;
}
describe("memory search after a runtime index upgrade", () => {
  async function seedIndex(
    cfg: ReturnType<typeof createConfig>,
    versionKey: VersionKey = "chunkingVersion",
    offset = -1,
  ): Promise<string> {
    const dbPath = await publishIndex(cfg);
    // Reopen unchanged indexed files as an older runtime's publication.
    withDatabase(dbPath, (db) => {
      updateMeta(db, { ...readMeta(db), [versionKey]: versions[versionKey] + offset });
    });
    return dbPath;
  }

  it("rebuilds unchanged prior-version content on the first default search", async () => {
    const cfg = createConfig();
    const dbPath = await seedIndex(cfg);
    const manager = await fixture.getFreshManager(cfg, "default");

    const results = await manager.search("alpha", { lexicalOnly: true });

    expect(results).toEqual(alphaResult);
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION);

    await closeManager(manager);
    const publication = () =>
      withDatabase(dbPath, (db) => ({
        meta: readMeta(db),
        revision: db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get(),
      }));
    const rebuilt = publication();
    const embedded = fixture.provider.embedBatchCalls;
    const reopened = await fixture.getFreshManager(cfg, "default");
    await reopened.sync({ reason: "watch" });
    expect(await reopened.search("alpha", { lexicalOnly: true })).not.toEqual([]);
    expect(fixture.provider.embedBatchCalls).toBe(embedded);
    expect(publication()).toEqual(rebuilt);
  });

  it("keeps status inspection read-only during an upgrade", async () => {
    const cfg = createConfig();
    const dbPath = await seedIndex(cfg);
    const manager = await fixture.getFreshManager(cfg, "status");

    expect(manager.status().custom?.indexIdentity).toMatchObject({
      status: "mismatched",
      code: "chunking_version",
      owner: "openclaw",
    });
    expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION - 1);
  });

  it.each(versionKeys)("preserves newer %s indexes until explicit reindex", async (versionKey) => {
    const currentVersion = versions[versionKey];
    const cfg = createConfig();
    const dbPath = await seedIndex(cfg, versionKey, 1);
    const manager = await fixture.getFreshManager(cfg);
    const embedded = fixture.provider.embedBatchCalls;
    await manager.sync({ reason: "search", force: true });
    expect(await manager.search("alpha", { lexicalOnly: true })).toEqual([]);
    expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(currentVersion + 1);
    expect(fixture.provider.embedBatchCalls).toBe(embedded);
    await manager.sync({ reason: "cli", force: true });
    expect(await manager.search("alpha", { lexicalOnly: true })).not.toEqual([]);
    expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(currentVersion);
  });

  it.each(versionKeys)(
    "serves only compatible lexical rows when the %s rebuild fails",
    async (versionKey) => {
      const currentVersion = versions[versionKey];
      const cfg = createConfig();
      const dbPath = await seedIndex(cfg, versionKey);
      await fs.writeFile(
        path.join(fixture.paths.memory, "2026-01-12.md"),
        "# Log\nAlpha memory line changed after the prior publication.",
      );
      fixture.provider.embedBatchPermanentFailure = new Error("embedding migration unavailable");
      const manager = await fixture.getFreshManager(cfg);
      const results = await manager.search("alpha", { lexicalOnly: true });
      if (versionKey === "chunkingVersion") {
        expect(results).toEqual(alphaResult);
      } else {
        expect(results).toEqual([]);
      }
      expect(withDatabase(dbPath, readMeta)[versionKey]).toBe(currentVersion - 1);
    },
  );
});

describe("memory search after an EmbeddingGemma input format upgrade", () => {
  it("re-embeds unchanged legacy-identity cache rows once on ordinary search", async () => {
    const cfg = fixture.createConfig({
      model: "embeddinggemma",
      cacheEnabled: true,
      vectorEnabled: false,
    });
    const dbPath = await publishIndex(cfg);
    // Reopen the unchanged fixture cache under the identity used before task prefixes.
    const legacyProviderKey = withDatabase(dbPath, (db) => {
      const meta = readMeta(db);
      const providerKey = hashText(JSON.stringify({ provider: meta.provider, model: meta.model }));
      delete meta.embeddingInputFormatVersion;
      updateMeta(db, { ...meta, providerKey });
      db.prepare("UPDATE memory_embedding_cache SET provider_key = ?").run(providerKey);
      expect(
        db.prepare("SELECT count(*) AS count FROM memory_embedding_cache").get()?.count,
      ).toBeGreaterThan(0);
      return providerKey;
    });
    fixture.provider.embeddedBatchTexts.length = 0;
    fixture.provider.embeddedQueryTexts.length = 0;
    const previousBatches = fixture.provider.embedBatchCalls;
    const manager = await fixture.getFreshManager(cfg);

    expect(await manager.search("alpha")).toEqual(alphaResult);
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(fixture.provider.embedBatchCalls).toBeGreaterThan(previousBatches);
    expect(fixture.provider.embeddedBatchTexts).toEqual([
      expect.stringMatching(/^title: none \| text: /),
    ]);
    expect(fixture.provider.embeddedQueryTexts).toEqual(["task: search result | query: alpha"]);
    await closeManager(manager);
    const upgraded = withDatabase(dbPath, readMeta);
    expect(upgraded.embeddingInputFormatVersion).toBe(1);
    expect(upgraded.providerKey).not.toBe(legacyProviderKey);

    const rebuiltBatches = fixture.provider.embedBatchCalls;
    const reopened = await fixture.getFreshManager(cfg);
    await reopened.sync({ reason: "watch" });
    expect(await reopened.search("alpha")).not.toEqual([]);
    expect(fixture.provider.embedBatchCalls).toBe(rebuiltBatches);
    expect(reopened.status().custom?.indexIdentity).toEqual({ status: "valid" });
    await closeManager(reopened);
    expect(withDatabase(dbPath, readMeta)).toEqual(upgraded);
  });
});
