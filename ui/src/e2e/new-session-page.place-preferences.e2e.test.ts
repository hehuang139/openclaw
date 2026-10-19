import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { NewSessionPreference } from "../pages/new-session/preferences.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  WORKSPACE,
  captureUiProof,
  checkoutBaseRefInput,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  pollAttribute,
  pollValue,
  pollEnabled,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const GIT_BRANCHES = {
  branches: [{ kind: "local", name: "main" }],
  defaultBranch: "main",
  repositoryStatus: "git",
};
const REGISTERED_PROJECT = {
  id: "registered",
  displayName: "Registered",
  repoRoot: "/srv/registered",
  source: "registered",
};

const savedSetup = (setup: NewSessionPreference) => ({
  workspace: WORKSPACE,
  folder: WORKSPACE,
  ...setup,
});
const durablePreferences = (setup: NewSessionPreference) => ({
  status: "ok",
  entries: { "new-session.migration.v1": true, "new-session.v1:main": savedSetup(setup) },
});
async function seedLocalPreferences(page: Page, setup: NewSessionPreference) {
  const url = new URL(suite.server.baseUrl);
  const gateway = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: `openclaw.new-session.preferences.v1:${gatewayOriginScope(gateway)}`,
    value: { agents: { main: savedSetup(setup) } },
  });
}
async function tryBlockedSubmission(page: Page) {
  await page.getByRole("button", { name: "Start session", exact: true }).click({ force: true });
  const message = page.locator(".new-session-page__message");
  await message.press("Enter");
  await message.press("Control+Enter");
}
async function reconnect(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await gateway.setOnline(false);
  await waitForControlUiGatewayReconnecting(page);
  await gateway.setOnline(true);
  await waitForControlUiGatewayReady(page);
}

suite.define(() => {
  it.each(["rejected", "unavailable"] as const)(
    "preserves saved worktree intent after %s discovery until retry or explicit opt-out",
    async (result) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          workspace: WORKSPACE,
          workspaceGit: true,
          presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
          featureMethods: [
            "users.prefs.get",
            "users.prefs.set",
            "sessions.create",
            "worktrees.branches",
          ],
          deferredMethods: ["worktrees.branches"],
          methodResponses: {
            "users.prefs.get": durablePreferences({ worktree: true }),
            "users.prefs.set": { status: "ok" },
            "worktrees.branches": GIT_BRANCHES,
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("worktrees.branches");
        const message = page.locator(".new-session-page__message");
        const start = page.getByRole("button", { name: "Start session", exact: true });
        await message.fill("keep this task isolated");
        // Reasoned blocks intentionally accept clicks to explain why Start is gated.
        await tryBlockedSubmission(page);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        const restoring = page
          .locator(".agent-chat__composer-status-text")
          .filter({ hasText: /^Restoring your last session setup…$/ });
        await restoring.waitFor();

        if (result === "rejected") {
          await gateway.rejectDeferred("worktrees.branches", {
            code: "UNAVAILABLE",
            message: "branch lookup unavailable",
          });
        } else {
          await gateway.resolveDeferred("worktrees.branches", {
            repositoryStatus: "unavailable",
            branches: [],
          });
        }
        await restoring.waitFor({ state: "hidden" });
        await captureUiProof(suite, page, `saved-worktree-${result}.png`);
        expect(await start.getAttribute("aria-disabled")).toBe("true");
        const checkout = page.locator("#new-session-checkout-trigger");
        expect(await checkout.getAttribute("data-worktree")).toBe("true");
        await tryBlockedSubmission(page);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

        if (result === "rejected") {
          await reconnect(page, gateway);
          await pollAttribute(start, "aria-disabled").toBe("false");
        } else {
          await checkout.click();
          await page.getByRole("button", { name: "Current checkout", exact: true }).click();
          await page.keyboard.press("Escape");
          await pollAttribute(start, "aria-disabled").toBe("false");
        }
        await start.click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({
          agentId: "main",
          message: "keep this task isolated",
        });
        if (result === "rejected") {
          expect(create.params).toHaveProperty("worktree", true);
        } else {
          expect(create.params).not.toHaveProperty("worktree");
        }
      });
    },
  );

  it("ignores a restored cloud preference for a write-scoped caller", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await seedLocalPreferences(page, { where: { kind: "cloud", id: "aws" } });
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "environments.list": {
            environments: [
              {
                id: "node:writer-runner",
                type: "node",
                label: "Writer runner",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 1, available: 1 },
              },
            ],
            profiles: [{ id: "aws", providerId: "crabbox" }],
          },
          "worktrees.branches": GIT_BRANCHES,
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const where = page.locator("#new-session-where-trigger");
      await pollAttribute(where, "data-cloud-profile").toBeNull();
      await where.click();
      const picker = page.locator(".oc-popover.new-session-page__where-popover");
      await picker.locator('[data-value="device:writer-runner"]').waitFor();
      expect(await picker.locator('[data-value="cloud:aws"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("start locally");
      await pollEnabled(page.getByRole("button", { name: "Start session" })).toBe(true);
    });
  });

  it("restores three-chip defaults from local storage without a durable identity", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await seedLocalPreferences(page, {
        where: { kind: "local" },
        projectId: "registered",
        worktree: true,
        baseRef: "release/local",
        worktreeName: "browser-task",
      });
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        featureMethods: ["projects.list", "sessions.create", "worktrees.branches"],
        methodResponses: {
          "projects.list": { projects: [REGISTERED_PROJECT], recents: [] },
          "worktrees.branches": GIT_BRANCHES,
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      const project = page.locator("#new-session-project-trigger");
      const checkout = page.locator("#new-session-checkout-trigger");
      await pollAttribute(project, "data-project-id").toBe("registered");
      await pollLocatorText(project.locator(".new-session-page__trigger-label")).toBe("Registered");
      await pollAttribute(checkout, "data-worktree").toBe("true");
      await checkout.click();
      await pollValue(checkoutBaseRefInput(page)).toBe("release/local");
      await pollValue(page.getByLabel("Name", { exact: true })).toBe("browser-task");
      expect(await gateway.getRequests("users.prefs.get")).toHaveLength(0);
      expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
    });
  });

  it("keeps saved project submission gated after discovery fails until reconnect restores it", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
        featureMethods: ["users.prefs.get", "users.prefs.set", "sessions.create", "projects.list"],
        deferredMethods: ["projects.list"],
        methodResponses: {
          "users.prefs.get": durablePreferences({ projectId: REGISTERED_PROJECT.id }),
          "users.prefs.set": { status: "ok" },
          "projects.list": { projects: [REGISTERED_PROJECT], recents: [] },
          "worktrees.branches": GIT_BRANCHES,
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const message = page.locator(".new-session-page__message");
      const start = page.getByRole("button", { name: "Start session", exact: true });
      await message.fill("work in the saved project");
      await start.click({ force: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      await gateway.rejectDeferred("projects.list", {
        code: "UNAVAILABLE",
        message: "project lookup unavailable",
      });
      await captureUiProof(suite, page, "saved-project-rejected.png");
      expect(await start.getAttribute("aria-disabled")).toBe("true");
      await tryBlockedSubmission(page);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      await reconnect(page, gateway);
      await page.locator('#new-session-project-trigger[data-project-id="registered"]').waitFor();
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        projectId: "registered",
        message: "work in the saved project",
      });
    });
  });

  it("restores identity-scoped Where, What, and Checkout defaults after discovery", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "environments.list",
          "projects.list",
          "sessions.create",
          "users.prefs.get",
          "users.prefs.set",
          "worktrees.branches",
        ],
        methodResponses: {
          "environments.list": {
            environments: [{ id: "gateway", type: "local", status: "available" }],
            profiles: [{ id: "aws", providerId: "crabbox" }],
          },
          "projects.list": { projects: [REGISTERED_PROJECT], recents: [] },
          "users.prefs.get": durablePreferences({
            where: { kind: "cloud", id: "aws" },
            projectId: "registered",
            worktree: true,
            baseRef: "release/next",
            worktreeName: "identity-task",
          }),
          "users.prefs.set": { status: "ok" },
          "worktrees.branches": GIT_BRANCHES,
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("users.prefs.get");
      const where = page.locator("#new-session-where-trigger");
      const project = page.locator("#new-session-project-trigger");
      const checkout = page.locator("#new-session-checkout-trigger");
      await pollAttribute(where, "data-cloud-profile").toBe("aws");
      await pollLocatorText(where.locator(".new-session-page__trigger-label")).toBe("aws");
      await pollAttribute(project, "data-project-id").toBe("registered");
      await pollLocatorText(project.locator(".new-session-page__trigger-label")).toBe("Registered");
      await pollAttribute(checkout, "data-worktree").toBe("true");
      await checkout.click();
      const checkoutPopover = page.locator(".oc-popover.new-session-page__checkout-popover");
      await pollValue(checkoutBaseRefInput(checkoutPopover)).toBe("release/next");
      await pollValue(checkoutPopover.getByLabel("Name", { exact: true })).toBe("identity-task");
    });
  });
});
