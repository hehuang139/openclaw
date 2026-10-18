import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import { describe, expect, it } from "vitest";
import type { TelegramChatDetails, TelegramGetChat } from "./bot/types.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import {
  buildTelegramStatusReactionVariants,
  resolveTelegramAllowedReactions,
  resolveTelegramReactionVariant,
} from "./status-reaction-variants.js";

function expectIssueMessageContains(
  issues: ReturnType<typeof collectTelegramStatusIssues>,
  text: string,
): void {
  expect(issues.map((issue) => issue.message).join("\n")).toContain(text);
}

function collectIssues(overrides: Partial<ChannelAccountSnapshot>) {
  return collectTelegramStatusIssues([
    { accountId: "main", enabled: true, configured: true, ...overrides },
  ]);
}

function expectRuntimeIssue(issues: ReturnType<typeof collectIssues>) {
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ channel: "telegram", accountId: "main", kind: "runtime" });
}

describe("collectTelegramStatusIssues", () => {
  it("reports privacy-mode and wildcard unmentioned-group configuration risks", () => {
    const issues = collectIssues({
      allowUnmentionedGroups: true,
      audit: {
        hasWildcardUnmentionedGroups: true,
        unresolvedGroups: 2,
      },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "telegram", accountId: "main", kind: "config" }),
      ]),
    );
    expectIssueMessageContains(issues, "privacy mode");
    expectIssueMessageContains(issues, 'uses "*"');
    expectIssueMessageContains(issues, "unresolvedGroups=2");
  });

  it("reports unreachable groups with match metadata", () => {
    const issues = collectIssues({
      audit: {
        groups: [
          {
            chatId: "-100123",
            ok: false,
            status: "left",
            error: "403",
            matchKey: "alerts",
            matchSource: "channels.telegram.groups",
          },
        ],
      },
    });

    expectRuntimeIssue(issues);
    expect(issues[0]?.message).toContain("Group -100123 not reachable");
    expect(issues[0]?.message).toContain("alerts");
    expect(issues[0]?.message).toContain("channels.telegram.groups");
  });

  it("reports polling runtime state that never completed getUpdates after startup grace", () => {
    const issues = collectIssues({
      running: true,
      mode: "polling",
      connected: false,
      lastStartAt: Date.now() - 121_000,
      lastError: "network timeout",
    });

    expectRuntimeIssue(issues);
    expect(issues[0]?.message).toContain("has not completed a successful getUpdates call");
    expect(issues[0]?.message).toContain("network timeout");
    expect(issues[0]?.fix).toContain("channels status --probe");
  });

  it("reports isolated polling spool handler timeouts distinctly from startup failures", () => {
    const issues = collectIssues({
      running: true,
      mode: "polling",
      connected: false,
      lastStartAt: Date.now() - 121_000,
      lastError:
        "Telegram isolated polling spool handler timed out behind update 42 on lane telegram:123 after 1500100ms; marking the update failed and restarting isolated ingress so later updates can drain.",
    });

    expectRuntimeIssue(issues);
    expect(issues[0]?.message).toContain("spool backlog is stalled");
    expect(issues[0]?.message).not.toContain("has not completed a successful getUpdates call");
  });

  it("reports stale polling transport activity after successful getUpdates stops refreshing", () => {
    const issues = collectIssues({
      running: true,
      mode: "polling",
      connected: true,
      lastStartAt: Date.now() - 60 * 60_000,
      lastTransportActivityAt: Date.now() - 31 * 60_000,
    });

    expectRuntimeIssue(issues);
    expect(issues[0]?.message).toContain("polling transport is stale");
  });

  it("does not report inherited stale transport activity during a fresh polling lifecycle", () => {
    const issues = collectIssues({
      running: true,
      mode: "polling",
      connected: true,
      lastStartAt: Date.now() - 60_000,
      lastTransportActivityAt: Date.now() - 2 * 60 * 60_000,
    });

    expect(issues).toStrictEqual([]);
  });

  it("reports webhook runtime state that never completed setWebhook after startup grace", () => {
    const issues = collectIssues({
      running: true,
      mode: "webhook",
      connected: false,
      lastStartAt: Date.now() - 10 * 60_000,
      lastError: "fetch failed",
    });

    expectRuntimeIssue(issues);
    expect(issues[0]?.message).toContain("setWebhook has not completed");
    expect(issues[0]?.message).toContain("fetch failed");
    expect(issues[0]?.fix).toContain("webhook URL");
  });

  it("does not report an advertised webhook just because no user updates arrived", () => {
    const issues = collectIssues({
      running: true,
      mode: "webhook",
      connected: true,
      lastStartAt: Date.now() - 60 * 60_000,
    });

    expect(issues).toStrictEqual([]);
  });
});

describe("resolveTelegramAllowedReactions", () => {
  const allowed = (chat: TelegramChatDetails, getChat?: TelegramGetChat) =>
    resolveTelegramAllowedReactions({ chat, chatId: 1, getChat });
  it("assumes no restriction when chat does not include available_reactions", async () => {
    expect(await allowed({ id: 1 })).toBeNull();
  });

  it("preserves standard and custom reactions while omitting paid reactions", async () => {
    const result = await allowed({
      available_reactions: [
        { type: "emoji", emoji: "👍" },
        { type: "custom_emoji", custom_emoji_id: "abc" },
        { type: "emoji", emoji: "🔥" },
        { type: "paid" },
      ],
    });
    expect(result).toEqual([
      { type: "emoji", emoji: "👍" },
      { type: "custom_emoji", custom_emoji_id: "abc" },
      { type: "emoji", emoji: "🔥" },
    ]);
  });

  it("normalizes emoji presentation selectors while retaining custom reactions", async () => {
    const result = await allowed({
      available_reactions: [
        { type: "emoji", emoji: "❤️" },
        { type: "custom_emoji", custom_emoji_id: "❤️" },
      ],
    } as never);

    expect(result).toEqual([
      { type: "emoji", emoji: "❤" },
      { type: "custom_emoji", custom_emoji_id: "❤️" },
    ]);
  });

  it("treats malformed available_reactions payloads as an empty allowlist instead of throwing", async () => {
    await expect(
      allowed({ available_reactions: { type: "emoji", emoji: "👍" } } as never),
    ).resolves.toEqual([]);
  });

  it("uses getChat lookup when message chat does not include available_reactions", async () => {
    const getChat: TelegramGetChat = async () => ({
      available_reactions: [{ type: "emoji", emoji: "👍" }],
    });

    const result = await allowed({ id: 1 }, getChat);

    expect(result).toEqual([{ type: "emoji", emoji: "👍" }]);
  });
});

describe("resolveTelegramReactionVariant", () => {
  it("returns undefined when no candidate is chat-allowed", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "👨‍💻",
    });

    const result = resolveTelegramReactionVariant({
      requestedEmoji: "👨‍💻",
      variantsByRequestedEmoji: variantsByEmoji,
      allowedEmojiReactions: new Set(["🎉"]),
    });

    expect(result).toBeUndefined();
  });
});
