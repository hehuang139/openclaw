import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqliteDir } from "../../state/openclaw-state-db.paths.js";
import { expectMessages, expectNoCalls } from "./update-boundary.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import {
  deferUpdateCommandTerminalResult,
  publishUpdateCommandTerminalResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const mocks = vi.hoisted(() => ({
  action: vi.fn<typeof import("./update-command-report.js").runInteractiveUpdateFailureAction>(),
  diagnose: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("../../commands/triage-failure.js", () => ({ triageAfterFailure: mocks.repair }));
vi.mock("./update-command-report.js", () => ({ runInteractiveUpdateFailureAction: mocks.action }));
vi.mock("../terminal-interactivity.js", () => ({ isTerminalInteractive: () => true }));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => mocks.diagnose,
}));

import { resultFixture } from "./update-command-fixtures.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
function createRun(target?: Parameters<typeof createUpdateRun>[0]["target"]) {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-terminal-") };
  const options = { env };
  const recorded = createUpdateRun({ trigger: "cli", target }, options);
  const run = { runId: recorded.runId, env };
  const read = () => getUpdateRun(run.runId, options);
  const terminal = (
    operation: () => Promise<void>,
    opts: Parameters<typeof withUpdateCommandTerminalResult>[1] = {},
  ) =>
    withUpdateFailureTriage({ run, json: opts?.json }, { env }, () =>
      withUpdateCommandTerminalResult(async (registerRun) => {
        registerRun(run);
        await operation();
      }, opts),
    );
  return { env, options, recorded, run, read, terminal };
}

beforeEach(() => {
  mocks.action.mockReset();
  mocks.diagnose.mockReset();
  mocks.repair.mockReset();
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(["new-error", "pending-aggregate"] as const)(
  "preserves the primary failed result when publication fails with %s",
  async (publication) => {
    const { env, recorded, run, read, terminal } = createRun();
    const result = resultFixture(undefined, {
      status: "error",
      reason: "global-install-failed",
      steps: [
        {
          name: "global install",
          command: "npm install",
          cwd: env.OPENCLAW_STATE_DIR,
          durationMs: 1,
          exitCode: 1,
          failureFacts: [{ check: "npm", code: "EACCES", message: "Permission denied" }],
        },
      ],
      durationMs: 1,
    });
    const primary = new UpdateCommandFailure(result, 1, "Package installation failed");
    const pending = new UpdateCommandPendingRecoveryFailure(result);
    const settlementFailure = new AggregateError([pending], "Update executor cleanup failed", {
      cause: pending,
    });
    const publish = vi.fn(async (failure?: unknown) => {
      if (publication === "pending-aggregate") {
        // Recovery publication preserves a changed settlement exception from its executor.
        throw failure;
      }
      throw new Error("Update result publication failed");
    });
    const json = publication === "new-error";
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await expect(
      terminal(
        async () => {
          deferUpdateCommandTerminalResult(run, publish);
          throw publication === "pending-aggregate" ? settlementFailure : primary;
        },
        { json },
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(publish).toHaveBeenCalledOnce();
    if (json) {
      expect(output).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(result));
    } else {
      expect(output).not.toHaveBeenCalled();
      const summary = vi
        .mocked(defaultRuntime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(summary).toContain("EACCES");
      expect(summary).toContain("Permission denied");
      expectMessages(
        defaultRuntime.error,
        "Update recovery remains pending (global-install-failed)",
      );
    }
    expect(read()).toEqual(recorded);
    expectNoCalls(mocks.action, mocks.diagnose, mocks.repair);
  },
);

it.each([false, true])(
  "preserves the committed outcome when its observer throws (pending=%s)",
  async (pending) => {
    const { run, read, terminal } = createRun();
    const onResult = vi.fn(() => {
      throw new TypeError("Observer could not finish");
    });
    const result = resultFixture(undefined, { status: pending ? "error" : "ok" });
    const update = terminal(
      async () => {
        deferUpdateCommandTerminalResult(run, () =>
          publishUpdateCommandTerminalResult({ opts: { run } }, result, { rolledBack: false }),
        );
        if (pending) {
          throw new UpdateCommandPendingRecoveryFailure(result);
        }
      },
      { onResult },
    );
    if (pending) {
      await expect(update).rejects.toMatchObject({ code: 1 });
    } else {
      await expect(update).resolves.toBeUndefined();
    }
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: result.status }),
    );
    expect(read()).toMatchObject({ status: pending ? "failed" : "succeeded" });
    expectNoCalls(mocks.action, mocks.diagnose);
    expect(defaultRuntime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Update recovery remains pending"),
    );
    expectMessages(defaultRuntime.error, "Warning: Update result observer failed:");
  },
);

it.each([
  { phase: "requested", publisher: false },
  { phase: "verifying", publisher: true },
] as const)(
  "records an unreported $phase exception before offering the interactive report",
  async ({ phase, publisher }) => {
    const { options, run, terminal } = createRun({
      kind: "package",
      installationMethod: "npm-global",
      version: "2026.9.6",
    });
    recordUpdateRunPhase(run.runId, phase, {}, options);
    const failure = new TypeError("Cannot complete update publication");
    const onResult = vi.fn();
    let reportBody: string | undefined;
    mocks.action.mockImplementation(async ({ result, attemptId }) => {
      const recordedRun = getUpdateRun(attemptId, options);
      expect(recordedRun).toMatchObject({
        status: "failed",
        reason: "update-failed",
        verification: {
          rollbackOutcome: { status: phase === "requested" ? "not-needed" : "not-attempted" },
        },
      });
      expect(result).toMatchObject({
        status: "error",
        reason: "update-failed",
        failedStep: {
          name: phase,
          failureFacts: [expect.objectContaining({ check: phase, errorName: "TypeError" })],
        },
      });
      reportBody = (
        await prepareUpdateFailureReport({ attemptId, result: result!, recordedRun }, options)
      ).body;
      return "handled";
    });
    await expect(
      terminal(
        async () => {
          if (publisher) {
            deferUpdateCommandTerminalResult(run, async () => {
              throw failure;
            });
            return;
          }
          throw failure;
        },
        { onResult },
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(mocks.action).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: run.runId, status: "error", reason: "update-failed" }),
    );
    expect(mocks.diagnose).not.toHaveBeenCalled();
    expect(reportBody).toContain(`Failed phase: ${phase}`);
    expect(reportBody).toContain("Reason code: update-failed");
    expect(reportBody).toContain("Rollback outcome:");
    expect(reportBody).not.toContain("not-recorded");
    expect(reportBody).not.toContain("not recorded");
  },
);

it.each(["lost-authority", "pending-publication", "completed-publication"] as const)(
  "preserves history and skips interactive triage for %s",
  async (condition) => {
    const fixture = createRun();
    const { env, run, read, terminal } = fixture;
    let { recorded } = fixture;
    const onResult = vi.fn();
    if (condition === "pending-publication") {
      await fs.mkdir(path.join(resolveOpenClawStateSqliteDir(env), ".openclaw-restore-fixture"));
    }
    const failure =
      condition === "lost-authority"
        ? new UpdateCommandRecoveryPendingError("Update executor release could not be confirmed.")
        : new Error("Update publication failed");
    await expect(
      terminal(
        async () => {
          if (condition !== "pending-publication") {
            deferUpdateCommandTerminalResult(run, async () => {
              if (condition === "completed-publication") {
                recorded = finishUpdateRun(run.runId, { status: "succeeded" }, { env });
              }
              throw new Error("Update publication failed");
            });
          }
          if (condition === "completed-publication") {
            return;
          }
          throw failure;
        },
        { onResult },
      ),
    ).rejects.toMatchObject({ code: condition === "completed-publication" ? 0 : 1 });
    expect(read()).toEqual(recorded);
    expectNoCalls(onResult, mocks.action, mocks.diagnose);
    if (condition === "completed-publication") {
      expectMessages(
        defaultRuntime.error,
        "Warning: Update succeeded, but result publication failed:",
      );
      expect(defaultRuntime.error).not.toHaveBeenCalledWith(
        expect.stringContaining("Update recovery remains pending"),
      );
    }
  },
);
