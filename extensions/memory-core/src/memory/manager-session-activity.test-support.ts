import { vi } from "vitest";

export const activity = vi.hoisted(() => ({
  listener: undefined as ((busy: boolean) => void) | undefined,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")
  >()),
  observeAgentRunActivity: (_agentId: string, listener: (busy: boolean) => void) => {
    activity.listener = listener;
    listener(false);
    return () => {
      activity.listener = undefined;
    };
  },
}));
