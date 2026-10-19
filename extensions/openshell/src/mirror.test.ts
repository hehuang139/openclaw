import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
  replaceDirectoryContents,
  stageDirectoryContents,
} from "./mirror.js";

const dirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  // Keep nested socket paths within macOS's 104-byte sockaddr_un.sun_path.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-mir-"));
  dirs.push(dir);
  return dir;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  const result = fs.lstat(targetPath);
  await expect(result).rejects.toBeInstanceOf(Error);
  await expect(result).rejects.toMatchObject({ code: "ENOENT" });
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

async function expectFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    expect(await fs.readFile(path.join(root, name), "utf8")).toBe(contents);
  }
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("replaceDirectoryContents", () => {
  it("unlinks target hardlinks before replacing host content", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();
    const outside = await makeTmpDir();
    await fs.writeFile(path.join(outside, "original.txt"), "host-only");
    await fs.link(path.join(outside, "original.txt"), path.join(target, "a.txt"));
    await fs.writeFile(path.join(source, "a.txt"), "hello");
    await fs.writeFile(path.join(target, "old.txt"), "stale");

    await replaceDirectoryContents({ sourceDir: source, targetDir: target });

    expect(await fs.readFile(path.join(target, "a.txt"), "utf8")).toBe("hello");
    expect(await fs.readFile(path.join(outside, "original.txt"), "utf8")).toBe("host-only");
    await expectPathMissing(path.join(target, "old.txt"));
  });

  it("applies remote deletions and file-directory replacements without protected links", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();
    await writeFiles(target, {
      "deleted/nested/old.txt": "stale",
      "now-file/old.txt": "stale",
      "now-directory": "stale",
    });
    const files = { "now-file": "file", "now-directory/new.txt": "directory" };
    await writeFiles(source, files);
    await fs.mkdir(path.join(source, "empty-directory"));

    await replaceDirectoryContents({ sourceDir: source, targetDir: target });

    await expectPathMissing(path.join(target, "deleted"));
    await expectFiles(target, files);
    expect(await fs.readdir(path.join(target, "empty-directory"))).toEqual([]);
  });

  it("waits for in-flight copies before reporting a mirror failure", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();
    await writeFiles(source, { "nested/failed.txt": "failed", "nested/delayed.txt": "finished" });
    const failure = new Error("copy failed");
    const failedCopyStarted = createDeferred<void>();
    const delayedCopyStarted = createDeferred<void>();
    const releaseCopy = createDeferred<void>();
    const originalCopyFile = fs.copyFile;
    const copyFile = vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      if (from === path.join(source, "nested", "failed.txt")) {
        failedCopyStarted.resolve();
        throw failure;
      }
      delayedCopyStarted.resolve();
      await releaseCopy.promise;
      await originalCopyFile(from, to, mode);
    });
    let settled = false;
    const replacement = replaceDirectoryContents({ sourceDir: source, targetDir: target }).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await Promise.all([failedCopyStarted.promise, delayedCopyStarted.promise]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      releaseCopy.resolve();
      expect(await replacement).toBe(failure);
      expect(await fs.readFile(path.join(target, "nested", "delayed.txt"), "utf8")).toBe(
        "finished",
      );
    } finally {
      releaseCopy.resolve();
      await replacement;
      copyFile.mockRestore();
    }
  });

  it("excludeDirs matching is case-insensitive", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    await writeFiles(source, { "Hooks/evil/handler.js": "// malicious", "data.txt": "ok" });

    await replaceDirectoryContents({
      sourceDir: source,
      targetDir: target,
      excludeDirs: ["hooks"],
    });

    expect(await fs.readFile(path.join(target, "data.txt"), "utf8")).toBe("ok");
    await expectPathMissing(path.join(target, "Hooks"));
  });

  it("preserves default excluded directories and repository metadata", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    await writeFiles(source, {
      "hooks/pre-commit": "malicious",
      "git-hooks/pre-commit": "malicious",
      ".git/hooks/post-checkout": "malicious",
      "safe.txt": "ok",
    });
    const protectedFiles = {
      "hooks/trusted": "trusted",
      "git-hooks/trusted": "trusted",
      ".git/HEAD": "ref: refs/heads/main\n",
    };
    await writeFiles(target, protectedFiles);

    await replaceDirectoryContents({
      sourceDir: source,
      targetDir: target,
      excludeDirs: DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS,
    });

    expect(await fs.readFile(path.join(target, "safe.txt"), "utf8")).toBe("ok");
    await expectFiles(target, protectedFiles);
    for (const [directory, expected] of [
      ["hooks", "trusted"],
      ["git-hooks", "trusted"],
      [".git", "HEAD"],
    ] as const) {
      expect(await fs.readdir(path.join(target, directory))).toEqual([expected]);
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves target-only special files and their ancestor directories",
    async () => {
      const source = await makeTmpDir();
      const target = await makeTmpDir();
      const nested = path.join(target, "nested");
      const fifoPath = path.join(nested, "host.fifo");
      const socketPath = path.join(nested, "host.sock");
      await fs.mkdir(nested);
      execFileSync("mkfifo", [fifoPath]);
      const server = net.createServer();
      server.listen(socketPath);
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });

      try {
        await replaceDirectoryContents({ sourceDir: source, targetDir: target });

        expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
        expect((await fs.lstat(socketPath)).isSocket()).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each(["directory", "symlink"] as const)(
    "preserves trusted host symlinks when their remote ancestor is %s",
    async (remoteAncestor) => {
      const source = await makeTmpDir();
      const target = await makeTmpDir();
      const outside = await makeTmpDir();
      await fs.writeFile(path.join(outside, "canary.txt"), "host-only");
      const linkTargets = {
        "file-link": path.join(outside, "canary.txt"),
        "directory-link": outside,
        "dangling-link": "missing-relative-target",
      };
      const nested = path.join(target, "nested", "deeper");
      await fs.mkdir(nested, { recursive: true });
      for (const [name, destination] of Object.entries(linkTargets)) {
        await fs.symlink(destination, path.join(nested, name));
      }
      await fs.writeFile(path.join(nested, "deleted.txt"), "stale");
      await fs.symlink(outside, path.join(target, "linked-entry"));
      await stageDirectoryContents({ sourceDir: target, targetDir: source });

      await fs.writeFile(path.join(source, "safe.txt"), "ok");
      await fs.writeFile(path.join(source, "linked-entry"), "remote-plain-file");
      await fs.rm(path.join(source, "nested"), { recursive: true });
      if (remoteAncestor === "directory") {
        await fs.mkdir(path.join(source, "nested", "deeper"), { recursive: true });
        await fs.writeFile(path.join(source, "nested", "deeper", "file-link"), "remote");
        await fs.mkdir(path.join(source, "nested", "deeper", "directory-link"));
        await fs.writeFile(
          path.join(source, "nested", "deeper", "directory-link", "new.txt"),
          "remote",
        );
        await fs.symlink(outside, path.join(source, "nested", "deeper", "dangling-link"));
      } else if (remoteAncestor === "symlink") {
        await fs.symlink(outside, path.join(source, "nested"));
      }

      await replaceDirectoryContents({ sourceDir: source, targetDir: target });

      expect(await fs.readFile(path.join(target, "safe.txt"), "utf8")).toBe("ok");
      expect(await fs.readlink(path.join(target, "linked-entry"))).toBe(outside);
      for (const [name, destination] of Object.entries(linkTargets)) {
        expect(await fs.readlink(path.join(nested, name))).toBe(destination);
      }
      await expectPathMissing(path.join(nested, "deleted.txt"));
      expect(await fs.readFile(path.join(outside, "canary.txt"), "utf8")).toBe("host-only");
      expect(await fs.readdir(outside)).toEqual(["canary.txt"]);
    },
  );
});

it.each([
  ["replace", replaceDirectoryContents],
  ["stage", stageDirectoryContents],
] as const)("%s copies content without symbolic links", async (_mode, copy) => {
  const source = await makeTmpDir();
  const staged = await makeTmpDir();

  const files = { "safe.txt": "ok", "nested/file.txt": "nested" };
  await writeFiles(source, files);
  await fs.symlink("/tmp/host-secret", path.join(source, "escaped-link"));
  await fs.symlink("/tmp/host-secret-dir", path.join(source, "nested", "escaped-dir"));

  await copy({ sourceDir: source, targetDir: staged });

  await expectFiles(staged, files);
  await expectPathMissing(path.join(staged, "escaped-link"));
  await expectPathMissing(path.join(staged, "nested", "escaped-dir"));
});
