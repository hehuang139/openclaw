import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { deferred } from "./deferred.test-helpers.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir } = createMemoryWikiTestHarness();

describe("withMemoryWikiVaultMutation", () => {
  it("serializes mutations for one vault and permits nested work", async () => {
    const vaultPath = await createTempDir("memory-wiki-mutation-");
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = withMemoryWikiVaultMutation(vaultPath, async () => {
      order.push("first:start");
      firstEntered.resolve();
      await withMemoryWikiVaultMutation(vaultPath, async () => {
        order.push("first:nested");
      });
      await releaseFirst.promise;
      order.push("first:end");
    });
    await firstEntered.promise;

    const second = withMemoryWikiVaultMutation(vaultPath, async () => {
      order.push("second");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start", "first:nested"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:nested", "first:end", "second"]);
  });

  it("allows distinct agent vaults to mutate in parallel", async () => {
    const root = await createTempDir("memory-wiki-mutation-agents-");
    const firstEntered = deferred();
    const secondEntered = deferred();
    const releaseFirst = deferred();

    const first = withMemoryWikiVaultMutation(path.join(root, "support"), async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = withMemoryWikiVaultMutation(path.join(root, "marketing"), async () => {
      secondEntered.resolve();
    });

    await secondEntered.promise;
    releaseFirst.resolve();
    await Promise.all([first, second]);
  });

  it("serializes physical aliases of one vault", async () => {
    const root = await createTempDir("memory-wiki-vault-alias-");
    const vaultPath = path.join(root, "vault");
    const aliasPath = path.join(root, "vault-alias");
    await fs.mkdir(vaultPath);
    await fs.symlink(vaultPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let aliasEntered = false;
    let first: Promise<void> | undefined;
    let alias: Promise<void> | undefined;

    try {
      first = withMemoryWikiVaultMutation(vaultPath, async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      await firstEntered.promise;
      alias = withMemoryWikiVaultMutation(aliasPath, async () => {
        aliasEntered = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(aliasEntered).toBe(false);

      releaseFirst.resolve();
      await Promise.all([first, alias]);
      expect(aliasEntered).toBe(true);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, alias].filter((item) => item !== undefined));
    }
  });
  it("queues detached work after its inherited transaction has ended", async () => {
    const vaultPath = await createTempDir("memory-wiki-mutation-detached-");
    const releaseDetached = deferred();
    const holderEntered = deferred();
    const releaseHolder = deferred();
    let detachedEntered = false;
    let detached!: Promise<void>;

    await withMemoryWikiVaultMutation(vaultPath, async () => {
      detached = (async () => {
        await releaseDetached.promise;
        await withMemoryWikiVaultMutation(vaultPath, async () => {
          detachedEntered = true;
        });
      })();
    });

    const holder = withMemoryWikiVaultMutation(vaultPath, async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
    });
    try {
      await holderEntered.promise;
      releaseDetached.resolve();
      await setImmediate();
      expect(detachedEntered).toBe(false);

      releaseHolder.resolve();
      await Promise.all([holder, detached]);
      expect(detachedEntered).toBe(true);
    } finally {
      releaseDetached.resolve();
      releaseHolder.resolve();
      await Promise.allSettled([holder, detached]);
    }
  });
});
