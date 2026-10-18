/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createPage,
  mountPage,
  createAuthStatus,
  createHarness,
  drainPageUpdates,
  expandProvider,
  requestCount,
  waitForProviders,
  advanceUsageRetries,
  focusDocument,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage usage convergence", () => {
  it("keeps account quotas during config saves and refreshes them from the page", async () => {
    const { context, request, snapshot, runtimeConfig, notifyRuntimeConfig } =
      createHarness("main");
    snapshot.hello = {
      type: "hello-ok",
      protocol: 3,
      features: { methods: ["config.get", "config.patch", "codex.accountUsage"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
    const original = request.getMockImplementation()!;
    let usedPercent = 10;
    const accountRequests: unknown[] = [];
    request.mockImplementation(async (method, params?: unknown) => {
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            profiles: [
              { profileId: "openai:one", type: "oauth", status: "ok" },
              { profileId: "openai:two", type: "token", status: "static" },
              { profileId: "openai:key", type: "api_key", status: "static" },
            ],
          },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            profiles: [{ profileId: "anthropic:one", type: "oauth", status: "ok" }],
          },
        ]);
      }
      if (method === "codex.accountUsage") {
        accountRequests.push(params);
        return {
          updatedAt: 1,
          providers: [
            { provider: "openai", displayName: "OpenAI", windows: [{ label: "5h", usedPercent }] },
          ],
        };
      }
      return original(method);
    });
    const page = appendPage(context);
    await waitForProviders(page);
    const openai = await expandProvider(page, "openai");
    const anthropic = await expandProvider(page, "anthropic");
    const limitsText = () =>
      [...openai.querySelectorAll(".model-providers__account-limits")].map(
        (limits) => limits.textContent,
      );
    await vi.waitFor(() =>
      expect(limitsText()).toEqual([
        expect.stringContaining("90% left"),
        expect.stringContaining("90% left"),
      ]),
    );
    expect(accountRequests).toEqual([
      { agentId: "main", profileId: "openai:one" },
      { agentId: "main", profileId: "openai:two" },
    ]);
    expect(
      [...openai.querySelectorAll('.model-providers__account-limits [role="meter"]')].map((meter) =>
        meter.getAttribute("aria-valuenow"),
      ),
    ).toEqual(["90", "90"]);
    expect(
      anthropic.querySelector('[data-profile-id="anthropic:one"] .model-providers__account-limits'),
    ).toBeNull();
    expect(
      openai.querySelector('[data-profile-id="openai:key"] .model-providers__account-limits'),
    ).toBeNull();
    runtimeConfig.state.configSaving = true;
    notifyRuntimeConfig();
    await page.updateComplete;
    expect(limitsText()).toEqual([
      expect.stringContaining("90% left"),
      expect.stringContaining("90% left"),
    ]);
    runtimeConfig.state.configSaving = false;
    notifyRuntimeConfig();
    usedPercent = 90;
    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
    await vi.waitFor(() =>
      expect(limitsText()).toEqual([
        expect.stringContaining("10% left"),
        expect.stringContaining("10% left"),
      ]),
    );
    expect(accountRequests).toHaveLength(4);
  });

  it("waits for the route loader before starting provider requests, including after reconnect", async () => {
    const harness = createHarness("main");
    const page = createPage(harness.context);
    mountPage(page);
    await page.updateComplete;
    expect(harness.request.mock.calls.filter(([method]) => method !== "config.get")).toEqual([]);

    harness.publishPhase("offline");
    harness.publishPhase("connected");
    await page.updateComplete;
    expect(harness.request.mock.calls.filter(([method]) => method !== "config.get")).toEqual([]);

    page.routeData = {
      gateway: harness.context.gateway,
      gatewaySnapshot: harness.context.gateway.snapshot,
      selectionIntentRevision: harness.context.settingsAgentSelection.intentRevision,
      client: harness.context.gateway.snapshot.client,
      agentId: "main",
      data: { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: Date.now() },
    };
    await vi.waitFor(() => expect(requestCount(harness.request, "usage.status")).toBe(1));
    await drainPageUpdates(page);
    expect(requestCount(harness.request, "models.authStatus")).toBe(0);
    expect(requestCount(harness.request, "usage.status")).toBe(1);
    // Local session usage belongs to the Usage page.
    expect(requestCount(harness.request, "sessions.usage")).toBe(0);
  });

  it.each(["reconnect", "manual refresh"] as const)(
    "restarts an exhausted retry cycle on %s",
    async (trigger) => {
      vi.useFakeTimers();
      focusDocument();
      const harness = createHarness("main");
      harness.setUsageStatus({ updatedAt: 1, providers: [], refreshing: true });
      const page = appendPage(harness.context);
      await page.updateComplete;
      await advanceUsageRetries();
      await page.updateComplete;
      expect(page.renderRoot.textContent).toContain("did not finish loading");

      const usageCallsBeforeRestart = harness.request.mock.calls.filter(
        ([method]) => method === "usage.status",
      ).length;
      expect(usageCallsBeforeRestart).toBe(4);

      if (trigger === "manual refresh") {
        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
        await page.updateComplete;
        await advanceUsageRetries();
        expect(requestCount(harness.request, "usage.status")).toBeGreaterThan(
          usageCallsBeforeRestart + 1,
        );
        return;
      }

      harness.publishPhase("offline");
      await page.updateComplete;
      harness.publishPhase("connected");
      await page.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(
        harness.request.mock.calls.filter(([method]) => method === "usage.status").length,
      ).toBe(5);
    },
  );

  it("replaces a pending pre-disconnect load before it can publish", async () => {
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [] });
    const releaseOldLoad = harness.deferNextAuthStatus();
    const page = appendPage(harness.context);
    await page.updateComplete;

    harness.publishPhase("offline");
    await page.updateComplete;
    const replacementUsage = {
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "replacement", usedPercent: 25 }],
    };
    harness.setUsageStatus({ updatedAt: 2, providers: [replacementUsage] });
    harness.publishPhase("connected");
    await page.updateComplete;

    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(([method]) => method === "usage.status").length,
      ).toBe(1),
    );
    releaseOldLoad();
    await vi.waitFor(() =>
      expect(page.view.props.cards.find((card) => card.id === "openai")?.usage).toEqual(
        replacementUsage,
      ),
    );
  });

  it("cancels and replaces provider usage work on forced refresh", async () => {
    const harness = createHarness("main");
    const oldUsage = deferred<unknown>();
    const originalRequest = harness.request.getMockImplementation()!;
    let firstUsageSignal: AbortSignal | undefined;
    const replacementUsage = {
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "replacement", usedPercent: 25 }],
    };
    let usageCall = 0;
    harness.request.mockImplementation(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "usage.status") {
          usageCall += 1;
          if (usageCall === 1) {
            firstUsageSignal = options?.signal;
            return oldUsage.promise;
          }
          return { updatedAt: 2, providers: [replacementUsage] };
        }
        return originalRequest(method);
      },
    );
    const page = appendPage(harness.context);
    await vi.waitFor(() => expect(requestCount(harness.request, "usage.status")).toBe(1));

    const releaseCoreRefresh = harness.deferNextAuthStatus();
    page.view.props.onRefresh();
    expect(firstUsageSignal?.aborted).toBe(true);

    oldUsage.resolve({
      updatedAt: 1,
      providers: [{ ...replacementUsage, windows: [{ label: "stale", usedPercent: 1 }] }],
    });
    await Promise.resolve();
    expect(page.view.props.cards.every((card) => !card.usage)).toBe(true);

    releaseCoreRefresh();
    await drainPageUpdates(page);

    await vi.waitFor(() =>
      expect(page.view.props.cards.find((card) => card.id === "openai")?.usage).toEqual(
        replacementUsage,
      ),
    );
    await drainPageUpdates(page);
    expect(requestCount(harness.request, "usage.status")).toBe(2);
    expect(requestCount(harness.request, "sessions.usage")).toBe(0);
    expect(page.view.props.cards.find((card) => card.id === "openai")?.usage).toEqual(
      replacementUsage,
    );
  });
});
