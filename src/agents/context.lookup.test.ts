import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextWindowCatalog } from "./context-cache-projection.js";
import { replaceDiscoveredContextTokenCache } from "./context-cache.js";
import { CONTEXT_WINDOW_RUNTIME_STATE } from "./context-runtime-state.js";
import { resetContextWindowCacheForTest } from "./context.test-support.js";
type Owner = { config: OpenClawConfig; modelCatalog: ContextWindowCatalog };

const state = vi.hoisted(() => {
  const initialConfig: OpenClawConfig = {};
  const catalog: ContextWindowCatalog = { entries: [], staticEntries: [] };
  return {
    config: initialConfig,
    catalog,
    loadConfig: vi.fn<() => OpenClawConfig>(),
    loadOwner: vi.fn<(_params: unknown) => Promise<Pick<Owner, "modelCatalog">>>(),
    publishedOwner: vi.fn<(_params: unknown) => Owner | undefined>(),
  };
});

vi.mock("../config/config.js", () => ({ getRuntimeConfig: state.loadConfig }));
vi.mock("../config/runtime-source-projection.js", () => ({
  projectConfigOntoRuntimeSourceSnapshot: (snapshot: OpenClawConfig) => snapshot,
}));
vi.mock("./prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: state.loadOwner,
  getPublishedPreparedModelCatalogOwnerSnapshot: state.publishedOwner,
}));

function model(id: string, contextWindow: number, contextTokens?: number): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    contextTokens,
    maxTokens: 4096,
  };
}

function config(provider: string, ...models: ModelDefinitionConfig[]): OpenClawConfig {
  return { models: { providers: { [provider]: { baseUrl: "https://example.invalid", models } } } };
}
const discovered = (id: string, contextWindow: number, provider?: string) => ({
  id,
  contextWindow,
  provider,
});

let context: typeof import("./context.js");
function tokens(
  modelId: string,
  options: Omit<Parameters<typeof context.resolveContextTokensForModel>[0], "model"> = {},
) {
  return context.resolveContextTokensForModel({ model: modelId, ...options });
}

beforeAll(async () => {
  vi.resetModules();
  context = await import("./context.js");
});

beforeEach(() => {
  state.config = {};
  state.catalog = { entries: [], staticEntries: [] };
  state.loadConfig.mockReset().mockImplementation(() => state.config);
  state.loadOwner.mockReset().mockImplementation(async () => ({ modelCatalog: state.catalog }));
  state.publishedOwner.mockReset().mockImplementation(() => ({
    config: state.config,
    modelCatalog: state.catalog,
  }));
  resetContextWindowCacheForTest();
});

afterEach(async () => {
  await CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  resetContextWindowCacheForTest();
  vi.useRealTimers();
});

describe("context cache lifecycle", () => {
  it("rehydrates configured entries after module reload without rereading config", async () => {
    state.config = config("openrouter", model("openrouter/claude-sonnet", 321_000));
    expect(tokens("openrouter/claude-sonnet", { allowAsyncLoad: false })).toBe(321_000);
    expect(state.loadConfig).toHaveBeenCalledTimes(1);

    vi.resetModules();
    state.loadConfig.mockReset().mockImplementation(() => {
      throw new Error("config should come from shared runtime state");
    });
    const reloaded = await import("./context.js");
    expect(
      reloaded.resolveContextTokensForModel({
        model: "openrouter/claude-sonnet",
        allowAsyncLoad: false,
      }),
    ).toBe(321_000);
    expect(state.loadConfig).not.toHaveBeenCalled();
  });

  it("retries config loading only after backoff", async () => {
    vi.useFakeTimers();
    state.config = config("openrouter", model("openrouter/claude-sonnet", 654_321));
    state.loadConfig.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    expect(tokens("openrouter/claude-sonnet")).toBeUndefined();
    expect(state.loadConfig).toHaveBeenCalledTimes(1);
    expect(tokens("openrouter/claude-sonnet")).toBeUndefined();
    expect(state.loadConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tokens("openrouter/claude-sonnet")).toBe(654_321);
    expect(state.loadConfig).toHaveBeenCalledTimes(2);
    await context.ensureContextWindowCacheLoaded();
  });

  it("replaces configured token overrides before refreshing discovery", async () => {
    state.config = config("openrouter", model("claude-sonnet", 321_000, 111_000));
    expect(tokens("claude-sonnet", { allowAsyncLoad: false })).toBe(111_000);
    state.catalog.entries = [discovered("claude-sonnet", 654_321, "openrouter")];
    const pending = context.refreshContextWindowCache(
      config("openrouter", model("claude-sonnet", 222_000)),
    );
    expect(tokens("claude-sonnet", { allowAsyncLoad: false })).toBe(222_000);
    await pending;
    expect(tokens("claude-sonnet", { allowAsyncLoad: false })).toBe(222_000);
  });

  it("loads exact read-only metadata rather than the Gateway-published owner", async () => {
    const cfg = config("anthropic", model("claude-opus-4.7-20260219", 200_000));
    state.catalog.entries = [
      discovered("anthropic/claude-opus-4.7-20260219", 200_000, "anthropic"),
    ];
    await context.ensureContextWindowCacheLoaded(cfg);
    expect(state.loadOwner).toHaveBeenCalledWith({ config: cfg, readOnly: true });
    expect(state.publishedOwner).not.toHaveBeenCalled();
    expect(tokens("anthropic/claude-opus-4.7-20260219", { allowAsyncLoad: false })).toBe(1_000_000);
  });

  it.each(["success", "failure"])(
    "keeps refreshed discovery when an older load finishes with %s",
    async (outcome) => {
      const started = Promise.withResolvers<void>();
      const older = Promise.withResolvers<{ modelCatalog: ContextWindowCatalog }>();
      state.loadOwner.mockImplementationOnce(() => {
        started.resolve();
        return older.promise;
      });
      const pending = context.ensureContextWindowCacheLoaded();
      await started.promise;

      state.catalog.entries = [discovered("new-model", 222_000, "synthetic")];
      await context.refreshContextWindowCache({});
      const options = { provider: "synthetic", allowAsyncLoad: false };
      expect(tokens("new-model", options)).toBe(222_000);

      if (outcome === "failure") {
        older.reject(new Error("old catalog unavailable"));
      } else {
        older.resolve({
          modelCatalog: {
            entries: [discovered("old-model", 111_000, "synthetic")],
          },
        });
      }
      await pending;

      expect(tokens("new-model", options)).toBe(222_000);
      expect(tokens("old-model", options)).toBeUndefined();
    },
  );

  it("warms configured, discovered, and static windows from the published owner", async () => {
    const requested = config("synthetic", model("stale-model", 111_000));
    state.config = config("synthetic", model("current-model", 222_000));
    state.catalog = {
      entries: [discovered("discovered-model", 64_000, "synthetic")],
      staticEntries: [discovered("static-model", 1_048_576, "google")],
    };
    await context.prewarmContextWindowCacheAfterReady({ config: requested });
    expect(state.publishedOwner).toHaveBeenCalledWith({
      config: requested,
      allowGatewaySubagentBinding: true,
    });
    expect(state.loadOwner).not.toHaveBeenCalled();
    const options = { allowAsyncLoad: false, cfg: {} };
    expect(tokens("current-model", options)).toBe(222_000);
    expect(tokens("discovered-model", options)).toBe(64_000);
    expect(tokens("static-model", options)).toBe(1_048_576);
    expect(tokens("stale-model", options)).toBeUndefined();
  });

  it("retires failed prewarm so exact request-time loading can recover", async () => {
    state.publishedOwner.mockReturnValueOnce(undefined);
    state.config = config("synthetic", model("recovered-model", 96_000));
    await context.prewarmContextWindowCacheAfterReady({ config: state.config });
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig).toBeUndefined();
    await context.ensureContextWindowCacheLoaded();
    expect(state.loadOwner).toHaveBeenCalledWith({ config: state.config, readOnly: true });
    expect(tokens("recovered-model", { allowAsyncLoad: false })).toBe(96_000);
  });

  it("retires stale discovery when exact catalog loading fails", async () => {
    replaceDiscoveredContextTokenCache(new Map([["stale-model", 999_000]]));
    state.loadOwner.mockRejectedValueOnce(new Error("catalog unavailable"));
    await context.ensureContextWindowCacheLoaded(
      config("synthetic", model("current-model", 96_000)),
    );
    expect(tokens("stale-model", { cfg: {} })).toBeUndefined();
  });

  it("does not publish prewarm cancelled during cooperative projection", async () => {
    let cancelled = false;
    state.catalog.entries = Array.from({ length: 600 }, (_, index) =>
      discovered(`cancelled-${index}`, 64_000),
    );
    state.publishedOwner.mockImplementationOnce(() => {
      queueMicrotask(() => {
        cancelled = true;
      });
      return { config: state.config, modelCatalog: state.catalog };
    });

    await context.prewarmContextWindowCacheAfterReady({
      config: state.config,
      isCancelled: () => cancelled,
    });

    expect(cancelled).toBe(true);
    expect(tokens("cancelled-599", { cfg: {} })).toBeUndefined();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
  });
});

describe("provider-owned context lookup", () => {
  it("uses self-prefixed provider discovery ahead of the bare cross-provider minimum", async () => {
    state.catalog.entries = [
      discovered("gemini-3.1-pro-preview", 128_000, "github-copilot"),
      discovered("gemini-3.1-pro-preview", 128_000),
      discovered("google-gemini-cli/gemini-3.1-pro-preview", 1_048_576, "google-gemini-cli"),
    ];
    await context.ensureContextWindowCacheLoaded();
    expect(tokens("gemini-3.1-pro-preview", { provider: "google-gemini-cli" })).toBe(1_048_576);
    expect(tokens("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("falls back to a bare configured row", () => {
    expect(
      tokens("kilocode/kilo-auto/balanced", {
        cfg: config("kilocode", model("kilo-auto/balanced", 900_000, 900_000)),
        provider: "kilocode",
      }),
    ).toBe(900_000);
  });

  it("treats explicit config as authoritative for read-only misses", () => {
    state.loadConfig.mockImplementation(() => {
      throw new Error("runtime config should not load");
    });
    expect(
      tokens("unknown-test-model", {
        cfg: { agents: { defaults: {} } },
        provider: "openai",
        fallbackContextTokens: 123_000,
        allowAsyncLoad: false,
      }),
    ).toBe(123_000);
    expect(state.loadConfig).not.toHaveBeenCalled();
  });

  it("does not confuse raw slash model ids with verified provider identity", async () => {
    state.catalog.entries = [discovered("google/gemini-2.5-pro", 999_000, "openrouter")];
    await context.ensureContextWindowCacheLoaded();
    const cfg = config("google", model("gemini-2.5-pro", 2_000_000));
    expect(tokens("gemini-2.5-pro", { cfg, provider: "google" })).toBe(2_000_000);
    expect(tokens("google/gemini-2.5-pro", { provider: "openrouter" })).toBe(999_000);
    expect(tokens("gemini-2.5-pro", { provider: "google" })).toBeUndefined();
    expect(tokens("google/gemini-2.5-pro", { cfg })).toBe(999_000);
  });
});
