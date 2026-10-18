import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createServer, type ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../src/config/sessions/session-accessor.ts";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.ts";
import { insertRepositoryGitHubPublicationFixture } from "../../../src/gateway/github-publication-store.test-support.ts";
import { repositoryGitHubPublicationDigest } from "../../../src/gateway/github-repository-publication.kernel.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { publicationRowDefaults } from "../../../src/state/github-publication-fixtures.test-support.ts";
import type { RepositoryGitHubPublicationRow } from "../../../src/state/github-publication-read.types.ts";
import { setUserProfileRole } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { cleanupSessionStateForTest } from "../../../src/test-utils/session-state-cleanup.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const parentKey = "agent:main:task-pr-parent";
const selectedKey = "agent:main:release-planning";
const viewerEmail = "task-pr-viewer@example.test";
const numbers = [176407, 176403, 176410];
const repository = "openclaw/openclaw";
const branch = "proof/coordination-no-published-pr";
const execFileAsync = promisify(execFile);
const live = process.env.OPENCLAW_TASK_PR_LIVE_GITHUB === "1";
const suite = createControlUiE2eSuite({
  name: "Delegated task PRs through a real Gateway",
  startServerBeforeBrowser: true,
});

async function seedTask(state: OpenClawTestState, profileId: string) {
  const createdActor = { type: "human", source: "profile", id: profileId } as const;
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: selectedKey },
    {
      sessionId: "00000000-0000-4000-8000-000000000099",
      label: "Release planning",
      updatedAt: Date.now(),
      createdActor,
    },
  );
  const root = state.path("coordination");
  await mkdir(root, { recursive: true });
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: root, env: state.env });
  await git("init", "--initial-branch=main");
  await writeFile(path.join(root, "README.md"), "# Synthetic task coordination\n");
  await git("add", "README.md");
  await git(
    "-c",
    "user.name=Task Proof",
    "-c",
    "user.email=proof@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test: seed isolated task",
  );
  await git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git("checkout", "-b", branch);
  await writeFile(
    path.join(root, "README.md"),
    "# Synthetic task coordination\nUnpublished parent change.\n",
  );
  await git("add", "README.md");
  await git(
    "-c",
    "user.name=Task Proof",
    "-c",
    "user.email=proof@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test: unpublished parent work",
  );
  // Only a local tracking ref: model an already pushed branch, never push to GitHub.
  await git("update-ref", "refs/remotes/origin/" + branch, "HEAD");
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: parentKey },
    {
      sessionId: "00000000-0000-4000-8000-000000000100",
      label: "Recovery improvements",
      createdActor,
      updatedAt: Date.now(),
      spawnedCwd: root,
      worktree: { id: "task-pr-parent-checkout", branch, repoRoot: root },
    },
  );
  for (const [index, number] of numbers.entries()) {
    const key = "agent:main:subagent:task-pr-child-" + index;
    const sessionId = "00000000-0000-4000-8000-00000000010" + (index + 1);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId,
        parentSessionKey: parentKey,
        createdActor,
        label: "Delegated repair " + (index + 1),
        updatedAt: Date.now(),
      },
    );
    const id = "task-pr-receipt-" + number;
    const row: RepositoryGitHubPublicationRow = {
      ...publicationRowDefaults(id),
      session_key: key,
      session_id: sessionId,
      session_lifecycle_revision: null,
      requester_authority_json: null,
      workspace_id: "workspace-" + id,
      owner_profile_id: null,
      connection_generation: null,
      identity_source: "system-configured",
      identity_profile_id: "fixture-profile",
      previous_head_commit: null,
      pushed_head_commit: null,
      claim_id: null,
      run_id: null,
      environment_id: null,
      owner_epoch: null,
      placement_generation: null,
      checkpoint_ref: null,
      checkpoint_digest: null,
      status: "published",
      repository,
      push_repository: repository,
      branch: "proof/repair-" + index,
      title: "Delegated repair " + (index + 1),
      pull_request_url: "https://github.com/" + repository + "/pull/" + number,
      created_at_ms: 1000 + index,
      updated_at_ms: 1000 + index,
    };
    row.request_digest = repositoryGitHubPublicationDigest(row);
    // Seed the canonical publication transaction before the Gateway takes custody.
    insertRepositoryGitHubPublicationFixture(row, () => {});
  }
}

suite.define(() => {
  it("shows three persisted descendant PRs while keeping the parent branch unpublished", async (test) => {
    let state: OpenClawTestState | undefined;
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    let restoreFetch: (() => void) | undefined;
    await suite.runScenario(test, {
      retainedState: () => state?.root,
      async run() {
        state = await createOpenClawTestState({
          label: "task-pr-live",
          layout: "home",
          env: {
            GH_TOKEN: undefined,
            GITHUB_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
            VITEST: "1",
          },
        });
        const port = await getFreePort();
        const viewer = ensureProfileForEmail(viewerEmail);
        setUserProfileRole(viewer.id, "reader");
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [viewerEmail],
          deviceAutoApprove: { enabled: true, scopes: ["operator.read"] },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            defaults: { workspace: state.workspaceDir, model: { primary: "openai/gpt-4.1" } },
            entries: { main: {} },
          },
          gateway: {
            port,
            trustedProxies: ["127.0.0.1", "::1"],
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  agents: ["main"],
                  sessions: { others: "view" },
                  scopes: ["operator.read"],
                },
              },
            },
            auth: { mode: "trusted-proxy", trustedProxy },
            controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
          },
        });
        await seedTask(state, viewer.id);
        const githubRequests: string[] = [];
        {
          const realFetch = globalThis.fetch;
          const transport = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input, init) => {
              const url = new URL(
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
              );
              if (url.hostname !== "api.github.com") {
                return realFetch(input, init);
              }
              githubRequests.push(url.pathname + url.search);
              if (live) {
                return realFetch(input, init);
              }
              if (url.pathname === "/repos/" + repository) {
                return Response.json({ fork: false, default_branch: "main" });
              }
              if (url.pathname.endsWith("/check-runs")) {
                return Response.json({ total_count: 0, check_runs: [] });
              }
              const number = Number(url.pathname.split("/").at(-1));
              if (
                url.pathname === "/repos/" + repository + "/pulls" &&
                url.searchParams.get("head") === "openclaw:" + branch
              ) {
                return Response.json([]);
              }
              if (!numbers.includes(number)) {
                throw new Error("Unexpected GitHub request: " + url.href);
              }
              return Response.json({
                number,
                title: "Delegated repair " + (numbers.indexOf(number) + 1),
                html_url: "https://github.com/" + repository + "/pull/" + number,
                state: "open",
                draft: false,
                merged_at: null,
                head: { ref: "proof/repair-" + numbers.indexOf(number), sha: "a".repeat(40) },
                base: { ref: "main", repo: { name: "openclaw", owner: { login: "openclaw" } } },
                additions: 12,
                deletions: 3,
                changed_files: 2,
              });
            });
          restoreFetch = () => transport.mockRestore();
        }
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        const start = () =>
          startGatewayServer(port, {
            auth: { mode: "trusted-proxy", trustedProxy },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          });
        gateway = await start();
        proxy = await createServer({
          configFile: false,
          envFile: false,
          root: state.workspaceDir,
          appType: "custom",
          logLevel: "error",
          server: {
            host: "127.0.0.1",
            port: 0,
            proxy: {
              "/": {
                target: "http://127.0.0.1:" + port,
                ws: true,
                headers: {
                  "x-forwarded-for": "192.0.2.10",
                  "x-forwarded-proto": "http",
                  "x-forwarded-user": viewerEmail,
                },
              },
            },
          },
        });
        await proxy.listen();
        const proxyUrl = proxy.resolvedUrls?.local[0];
        if (!proxyUrl) {
          throw new Error("Task PR fixture proxy has no loopback URL");
        }
        const browserGatewayUrl = new URL(proxyUrl);
        browserGatewayUrl.protocol = "ws:";
        // Browser WebSocket traffic is never replaced: only external GitHub HTTP is fixture-backed.
        for (const stage of ["initial", "restarted"] as const) {
          const requestsBeforeStage = githubRequests.length;
          await suite.withPage(
            {
              viewport: { width: 1280, height: 900 },
              colorScheme: "dark",
              locale: "en-US",
              serviceWorkers: "block",
            },
            async ({ page }) => {
              await page.addInitScript(() => {
                localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
                localStorage.setItem(
                  "openclaw:control-ui:community-invite:v2",
                  JSON.stringify({ dismissedAtMs: 1770000000000 }),
                );
              });
              const snapshots: Record<string, unknown>[] = [];
              page.on("websocket", (socket) =>
                socket.on("framereceived", ({ payload }) => {
                  const frame: unknown = JSON.parse(String(payload));
                  if (
                    !isRecord(frame) ||
                    frame.event !== CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT ||
                    !isRecord(frame.payload) ||
                    !isRecord(frame.payload.sessions)
                  ) {
                    return;
                  }
                  const snapshot = frame.payload.sessions[parentKey];
                  if (isRecord(snapshot)) {
                    snapshots.push(snapshot);
                  }
                }),
              );
              const url = new URL(controlUiSessionUrl(suite.server.baseUrl, selectedKey));
              url.hash = new URLSearchParams({ gatewayUrl: browserGatewayUrl.href }).toString();
              await page.goto(url.href);
              await page
                .locator("openclaw-gateway-url-confirmation")
                .getByRole("button", { name: "Switch to " + browserGatewayUrl.host, exact: true })
                .click();
              const row = page.locator(
                '.sidebar-recent-session[data-session-key="' + parentKey + '"]',
              );
              await row.waitFor();
              const card = page.locator(".session-progress-hovercard");
              let activated = false;
              const activate = async () => {
                if (activated) {
                  return;
                }
                await row.locator(".sidebar-recent-session__link").focus();
                await card.waitFor();
                await expect.poll(() => snapshots.at(-1)?.status).toBeTruthy();
                activated = true;
              };
              try {
                // The selected session has no worktree: a parent hover must not be needed to hydrate its badge.
                await expect
                  .poll(() => row.locator(".session-row-badge--pull-request").isVisible())
                  .toBe(true);
                await expect.poll(() => snapshots.at(-1)?.taskPullRequestCount).toBe(3);
                expect(githubRequests.length).toBe(requestsBeforeStage);
                await activate();
                await expect.poll(() => snapshots.at(-1)?.taskPullRequestCount).toBe(3);
                await expect
                  .poll(() => snapshots.at(-1)?.taskPullRequests)
                  .toEqual(
                    expect.arrayContaining(
                      numbers.map((number, index) =>
                        expect.objectContaining({
                          number,
                          sourceSessionKey: "agent:main:subagent:task-pr-child-" + index,
                          sourceAgentId: "main",
                          pullRequest: expect.objectContaining({
                            number,
                            title: expect.any(String),
                          }),
                        }),
                      ),
                    ),
                  );
                expect(snapshots.at(-1)?.pullRequests).toEqual([]);
                expect(snapshots.at(-1)?.branch).toMatchObject({ branch });
                await expect.poll(() => card.locator(".session-hovercard__pr-row").count()).toBe(3);
                await expect
                  .poll(() => row.locator(".session-row-badge--pull-request").count())
                  .toBe(1);
                expect(
                  await card
                    .getByRole("link", { name: "Create a pull request for " + branch })
                    .count(),
                ).toBe(1);
                for (const number of numbers) {
                  expect(
                    await card
                      .locator(
                        'a[href="https://github.com/' + repository + "/pull/" + number + '"]',
                      )
                      .count(),
                  ).toBe(1);
                }
              } finally {
                // On red, show the same parent hovercard rather than a transient loading shell.
                await activate();
                if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
                  const frame = await takeControlUiScreenshotFrame(
                    page,
                    card,
                    [card.locator(".session-hovercard__title")],
                    { animations: "disabled", elements: [row] },
                  );
                  await writeFile(path.join(suite.artifactDir, stage + ".png"), frame.png);
                }
                await writeFile(
                  path.join(suite.artifactDir, stage + "-snapshots.json"),
                  JSON.stringify({ live, snapshots, githubRequests }, null, 2),
                );
              }
            },
          );
          if (stage === "initial") {
            await gateway.close({ reason: "task PR persistence proof restart" });
            // Reopen persisted rows, not this process's retained projection/database handles.
            await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
            gateway = await start();
          }
        }
      },
      close: () =>
        runQaGatewayFixture(
          async () => {
            await proxy?.close();
          },
          async () => {
            await gateway?.close({ reason: "task PR proof cleanup" });
          },
          () => restoreFetch?.(),
        ),
      release: async () => state?.cleanup(),
    });
  });
});
