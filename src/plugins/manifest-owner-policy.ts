/** Applies manifest owner policy for plugin availability and activation decisions. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveEffectivePluginActivationState,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

type OwnerPlugin = Pick<
  PluginManifestRecord,
  "id" | "origin" | "enabledByDefault" | "enabledByDefaultOnPlatforms"
> &
  Partial<Pick<PluginManifestRecord, "channels">>;

export type ManifestOwnerBasePolicyBlockReason =
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "plugin-disabled"
  | "not-in-allowlist";

export function isBundledManifestOwner(plugin: Pick<PluginManifestRecord, "origin">): boolean {
  return plugin.origin === "bundled";
}

/** True when config explicitly trusts a plugin as a manifest owner. */
export function hasExplicitManifestOwnerTrust(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
}): boolean {
  const policyId = normalizePluginPolicyId(params.plugin.id);
  return (
    params.normalizedConfig.allow.includes(policyId) ||
    params.normalizedConfig.entries[policyId]?.enabled === true
  );
}

/** True when a plugin passes global enablement, allowlist, denylist, and disabled checks. */
export function passesManifestOwnerBasePolicy(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
  allowRestrictiveAllowlistBypass?: boolean;
}): boolean {
  return resolveManifestOwnerBasePolicyBlock(params) === null;
}

export function resolveManifestOwnerBasePolicyBlock(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
  allowRestrictiveAllowlistBypass?: boolean;
}): ManifestOwnerBasePolicyBlockReason | null {
  if (!params.normalizedConfig.enabled) {
    return "plugins-disabled";
  }
  const policyId = normalizePluginPolicyId(params.plugin.id);
  if (params.normalizedConfig.deny.includes(policyId)) {
    return "blocked-by-denylist";
  }
  if (params.normalizedConfig.entries[policyId]?.enabled === false) {
    return "plugin-disabled";
  }
  if (
    params.allowRestrictiveAllowlistBypass !== true &&
    params.normalizedConfig.allow.length > 0 &&
    !params.normalizedConfig.allow.includes(policyId)
  ) {
    return "not-in-allowlist";
  }
  return null;
}

export function isActivatedManifestOwner(params: {
  plugin: OwnerPlugin;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): boolean {
  return resolveEffectivePluginActivationState({
    id: params.plugin.id,
    origin: params.plugin.origin,
    channelIds: params.plugin.channels,
    config: params.normalizedConfig,
    rootConfig: params.rootConfig,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin),
  }).activated;
}
