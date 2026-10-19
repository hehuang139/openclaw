// Shares plugin runtime workspace state across module reloads.
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";

type GlobalRegistryWorkspaceState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    workspaceDir?: string | null;
  };
};

export function getActivePluginRegistryWorkspaceDirFromStateCore(): string | undefined {
  return (
    (globalThis as GlobalRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE]?.workspaceDir ?? undefined
  );
}
