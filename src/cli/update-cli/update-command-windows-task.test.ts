import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  withCliCommandCleanup,
  withCliProcessScope,
  type CliHarnessCleanup,
} from "../runtime-cleanup-scope.js";
import { waitForCliSignalExit } from "../signal-exit-barrier.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

vi.mock("../../daemon/schtasks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks.js")>()),
  resumeScheduledTaskAutoStartAfterUpdate: vi.fn(),
  suspendScheduledTaskAutoStartForUpdate: vi.fn(),
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: { error: vi.fn() } }));

function recovery(
  options: Parameters<typeof createWindowsTaskAutoStartRecovery>[0] = { serviceEnv: {} },
) {
  return createWindowsTaskAutoStartRecovery({ alreadySuspended: true, ...options });
}

function mockEnable(afterDispatch: () => void | Promise<void> = () => {}) {
  vi.mocked(resumeScheduledTaskAutoStartAfterUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      const pending = afterDispatch();
      if (pending) {
        await pending;
      }
      return true;
    },
  );
}

function isolatedRoot(prefix: string) {
  const root = dirs.make(prefix);
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    path.join(root, "private-tmp"),
  );
  return root;
}

async function rebindExecutor(
  store: ReturnType<typeof createManagedHandoffLeaseStore>,
  root: string,
) {
  const original = store.read(root);
  if (original.kind !== "current") {
    throw new Error("missing actual executor");
  }
  await Promise.resolve();
  expect(store.bind(original.lease, process.pid)).not.toBeNull();
}

it("revokes restoration while its ownership inspection is pending", async () => {
  const inspected = createDeferred();
  const releaseInspection = createDeferred();
  const dispatched: string[] = [];
  mockEnable(() => {
    dispatched.push("enable");
  });
  const task = recovery({
    serviceEnv: {},
    assertCurrentService: async () => {
      inspected.resolve();
      await releaseInspection.promise;
    },
  });
  const restored = expect(task.restore(true)).rejects.toThrow("restoration authority has closed");
  await inspected.promise;
  const settled = task.complete(false);
  releaseInspection.resolve();
  await restored;
  await settled;
  await task.restore(true);
  expect(() => task.assertRecoveryCurrent()).toThrow("authority has closed or transferred");
  expect(dispatched).toEqual([]);
  expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
});

it("drains a dispatched enable before compensating failed verification", async () => {
  const dispatched = createDeferred();
  const finishEnable = createDeferred();
  const actions: string[] = [];
  mockEnable(async () => {
    actions.push("enable");
    dispatched.resolve();
    await finishEnable.promise;
  });
  vi.mocked(suspendScheduledTaskAutoStartForUpdate).mockImplementationOnce(
    async (_env, options) => {
      expect(options?.restoreOnFailure).toBe(false);
      await options?.beforeMutation?.();
      actions.push("disable");
      return true;
    },
  );
  const task = recovery();
  const restored = task.restore(true);
  await dispatched.promise;
  const settled = task.complete(false);
  await Promise.resolve();
  expect(actions).toEqual(["enable"]);
  finishEnable.resolve();
  await restored;
  await settled;
  expect(actions).toEqual(["enable", "disable"]);
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

it("refuses caller recovery after transferring native task ownership", async () => {
  vi.mocked(suspendScheduledTaskAutoStartForUpdate).mockClear();
  const task = recovery();
  try {
    task.assertRecoveryCurrent();
    task.handoff(async () => {});
    expect(() => task.assertRecoveryCurrent()).toThrow("authority has closed or transferred");
  } finally {
    await task.complete(true);
  }
  expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
});

it("refuses native compensation after its original live executor changes during inspection", async () => {
  const root = isolatedRoot("windows-compensation-owner-");
  const actions: string[] = [];
  const store = createManagedHandoffLeaseStore();
  mockEnable(() => {
    actions.push("enable");
  });
  vi.mocked(suspendScheduledTaskAutoStartForUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      actions.push("disable");
      return true;
    },
  );
  let failure: unknown;
  await expect(
    withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      let compensating = false;
      const task = recovery({
        serviceEnv: {},
        assertCurrent: fence.assertCurrent,
        assertCurrentService: async () => {
          if (!compensating) {
            return;
          }
          await rebindExecutor(store, root);
        },
      });
      try {
        await task.restore(true);
        compensating = true;
        try {
          await task.complete(false);
        } catch (error) {
          failure = error;
        }
        expect(() => task.assertRecoveryCurrent()).toThrow(/executor/);
      } finally {
        await task.complete(false);
      }
    }),
  ).rejects.toThrow(/executor/);
  expect(String(failure)).toMatch(/executor/);
  expect(actions).toEqual(["enable"]);
});

it("retains the native failure when interrupted cleanup also loses its executor", async () => {
  const root = isolatedRoot("windows-interrupted-owner-");
  const exited = vi.fn<typeof process.exit>();
  vi.spyOn(process, "exit").mockImplementation(exited);
  const listeners = process.listeners("SIGINT");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  const store = createManagedHandoffLeaseStore();
  const nativeFailure = new Error("native disable failed after dispatch");
  mockEnable();
  vi.mocked(suspendScheduledTaskAutoStartForUpdate).mockImplementationOnce(
    async (_env, options) => {
      await options?.beforeMutation?.();
      await rebindExecutor(store, root);
      throw nativeFailure;
    },
  );
  let failure: unknown;
  let resources: CliHarnessCleanup["pluginResources"];
  await expect(
    withCliProcessScope(() =>
      withCliCommandCleanup(false, (cleanup) => {
        resources = cleanup?.pluginResources;
        return withUpdateCommandExecutor(run.runId, async (executor) => {
          const executorFence = await executor.enter(root);
          const recoveryListeners = process.listeners("SIGINT");
          const task = recovery({
            serviceEnv: env,
            assertCurrent: executorFence.assertCurrent,
            updateRun: { runId: run.runId, env, executorFence },
          });
          try {
            await task.restore(true);
            const onSignal = process
              .listeners("SIGINT")
              .find((listener) => !recoveryListeners.includes(listener));
            if (!onSignal) {
              throw new Error("missing owned signal handler");
            }
            onSignal("SIGINT");
            expect(process.exitCode).toBe(previousExitCode);
            expect(exited).not.toHaveBeenCalled();
            try {
              await task.complete(false);
            } catch (error) {
              failure = error;
            }
          } finally {
            await task.complete(false);
          }
        });
      }),
    ),
  ).rejects.toThrow(/executor/);
  expect(await waitForCliSignalExit()).toBe(130);
  await resources?.release();
  expect(process.exitCode).toBe(130);
  expect(exited).not.toHaveBeenCalled();
  expect(failure).toMatchObject({ errors: expect.arrayContaining([nativeFailure]) });
  expect(getUpdateRun(run.runId, { env })).toEqual(run);
  expect(process.listeners("SIGINT")).toEqual(listeners);
});
