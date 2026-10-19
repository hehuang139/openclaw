import path from "node:path";
import type { Message } from "grammy/types";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

type Action = ChannelMessageActionContext["action"];
type Context = Partial<ChannelMessageActionContext>;
type Params = Record<string, unknown>;

const fixture = useTelegramHttpFixture();
const { requests, endpoints, rejections } = fixture;
let state: OpenClawTestState;
let env = captureEnv([]);
let cfg: OpenClawConfig;
const trusted = {
  conversationReadOrigin: "delegated" as const,
  requesterAccountId: "default",
  toolContext: {
    currentChannelProvider: "telegram" as const,
    currentChannelId: "telegram:-1001:topic:77",
    currentMessageId: "456",
  },
};
const observed = (
  tool: Partial<NonNullable<ChannelMessageActionContext["toolContext"]>> = {},
  context: Context = {},
): Context => ({
  ...trusted,
  ...context,
  toolContext: { ...trusted.toolContext, ...tool },
});
const invoke = (action: Action, params: Params, context: Context = {}) =>
  telegramPlugin.actions!.handleAction!({
    channel: "telegram",
    action,
    params,
    cfg,
    conversationReadOrigin: "direct-operator",
    ...context,
  });
const poll = { question: "Ready?", answers: ["Yes", "No"] };
const react = (params: Params = {}) =>
  invoke("react", { chatId: "123", messageId: 456, emoji: "👍", ...params });
const customEmoji = (length: number) =>
  Array.from({ length }, (_, index) => ({
    type: "custom_emoji",
    custom_emoji_id: String(9000 + index),
  }));
const expectMethods = (methods: string[]) =>
  expect(requests.map(({ method }) => method)).toEqual(methods);

beforeEach(async () => {
  env = captureEnv(["TELEGRAM_BOT_TOKEN"]);
  delete process.env.TELEGRAM_BOT_TOKEN;
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "telegram-actions-http-",
  });
  cfg = {
    ...fixture.cfg,
    channels: { telegram: { ...fixture.cfg.channels.telegram, reactionLevel: "minimal" } },
    session: { store: path.join(state.stateDir, "{agentId}", "sessions.json") },
  };
  resetTelegramMessageCacheForTest();
  setTelegramPluginStateRuntimeForTests();
});
afterEach(async () => {
  clearTelegramRuntimeForTest();
  resetTelegramMessageCacheForTest();
  env.restore();
  await state.cleanup();
});

it.for([
  ["poll", poll, false],
  ["poll", poll, true],
  ["sticker", { fileId: "fixture-sticker" }, true],
  ["topic-create", { name: "Guarded topic" }, true],
  ["topic-edit", { threadId: 77, name: "Guarded topic" }, true],
  ["react", { messageId: 456, emoji: "👍" }, true],
] as const)(
  "retains host authority after chat lookup: %j",
  async ([action, params, revoke], { signal }) => {
    cfg.channels!.telegram!.actions = {
      sticker: true,
      createForumTopic: true,
      editForumTopic: true,
    };
    fixture.responseFor = (method) =>
      method === "getChat"
        ? { id: -1001, type: "supergroup", title: "Fixture forum", is_forum: true }
        : method === "createForumTopic"
          ? { message_thread_id: 77, name: "Guarded topic" }
          : undefined;
    const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
    fixture.requestHold = held;
    let current = true;
    const pending = invoke(
      action,
      { to: "@retirement_fixture", ...params },
      {
        assertDirectAdapterHandoff: () => {
          signal.throwIfAborted();
          if (!current) {
            throw new Error("Telegram action owner retired");
          }
        },
      },
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(held.arrived.promise, pending, "Action skipped chat lookup"),
        signal,
      );
      expect(requests).toEqual([{ method: "getChat", fields: { chat_id: "@retirement_fixture" } }]);
      current = !revoke;
      held.release.resolve();
      if (!revoke) {
        await expect(pending).resolves.toMatchObject({ details: { ok: true } });
        expectMethods(["getChat", "sendPoll"]);
      } else {
        await pending.catch(() => undefined);
        const requestDescription = `Observed Telegram endpoints: ${requests.map(({ method }) => method).join(", ")}`;
        if (action === "react") {
          await expect(pending, requestDescription).resolves.toMatchObject({
            details: { ok: false, reason: "error", hint: "Reaction failed. Do not retry." },
          });
        } else {
          await expect(pending, requestDescription).rejects.toThrow(
            "Telegram action owner retired",
          );
        }
        expectMethods(["getChat"]);
      }
    } finally {
      current = false;
      held.release.resolve();
      if (fixture.requestHold === held) {
        fixture.requestHold = undefined;
      }
      await pending.catch(() => undefined);
    }
  },
);

it("requires host-owned current-message authority for reactions, edits and deletes", async () => {
  const params = {
    chatId: "telegram:-1001:topic:77",
    messageId: 456,
    emoji: "👍",
    message: "updated",
  };
  for (const action of ["react", "edit", "delete"] as const) {
    const denied = invoke(
      action,
      {
        ...params,
        conversationReadOrigin: "direct-operator",
        requesterAccountId: "default",
        toolContext: trusted.toolContext,
      },
      observed({ currentMessageId: "999" }),
    );
    if (action === "react") {
      await expect(denied).resolves.toMatchObject({ details: { ok: false, reason: "error" } });
    } else {
      await expect(denied).rejects.toThrow(/provider-observed binding/);
    }
  }
  expect(requests).toEqual([]);
  for (const action of ["react", "edit", "delete"] as const) {
    await invoke(action, params, trusted);
  }
  expect(requests.map(({ method, fields }) => [method, fields.chat_id, fields.message_id])).toEqual(
    [
      ["setMessageReaction", "-1001", 456],
      ["editMessageText", "-1001", 456],
      ["deleteMessage", "-1001", 456],
    ],
  );
  rejections.push("Bad Request: message can't be deleted");
  const refused = await invoke("delete", params, trusted);
  expect(refused.details).toMatchObject({
    ok: false,
    deleted: false,
    warning: expect.stringContaining("message can't be deleted"),
  });
});

it("binds topicless reactions without borrowing another chat", async () => {
  const context = observed({ currentChannelId: "telegram:-1001", currentThreadTs: "77" });
  await expect(invoke("react", { chatId: "-1002", emoji: "👍" }, context)).resolves.toMatchObject({
    details: { ok: false, reason: "error" },
  });
  expect(requests).toEqual([]);
  await invoke("react", { chatId: "-1001", emoji: "👍" }, context);
  expect(requests).toEqual([
    {
      method: "setMessageReaction",
      fields: { chat_id: "-1001", message_id: 456, reaction: [{ type: "emoji", emoji: "👍" }] },
    },
  ]);
});

it("rejects conflicting host authority, including threadless and missing-origin invocations", async () => {
  const params = { chatId: "-1001:topic:77", messageId: 456 };
  const contexts: Context[] = [
    observed({}, { requesterAccountId: "other" }),
    observed({}, { requesterAccountId: " !!! " }),
    observed({ currentChannelProvider: "slack" }),
    observed({ currentThreadTs: "88" }),
    observed({ currentMessagingTarget: "-1002:topic:77" }),
    { conversationReadOrigin: undefined },
  ];
  for (const context of contexts) {
    await expect(invoke("delete", params, context)).rejects.toThrow(/provider-observed binding/);
  }
  await expect(
    invoke(
      "delete",
      { chatId: "-1002", messageId: 456 },
      observed({ currentChannelId: "telegram:-1001" }),
    ),
  ).rejects.toThrow(/provider-observed binding/);
  expect(requests).toEqual([]);
  await invoke("delete", params, trusted);
  expectMethods(["deleteMessage"]);
});

it("retains account- and topic-bound historical authority after the cache restarts", async () => {
  cfg.channels!.telegram!.accounts = { work: { botToken: "654321:other-account" } };
  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(cfg.session?.store, { agentId: "main" }),
    ),
  });
  const message = (id: number, thread: number) =>
    ({
      message_id: id,
      message_thread_id: thread,
      is_topic_message: true,
      date: 1_736_380_700,
      chat: { id: -1001, type: "supergroup", title: "QA", is_forum: true },
      text: "historical context",
      from: { id: 1, is_bot: false, first_name: "QA" },
    }) satisfies Message.TextMessage;
  for (const [id, thread, providerObserved] of [
    [900, 77, true],
    [898, 77, false],
    [897, 88, true],
  ] as const) {
    const msg = {
      ...message(id, thread),
      ...(id === 900 ? { reply_to_message: message(899, 77) } : {}),
    };
    await cache.record({
      accountId: "default",
      chatId: -1001,
      msg,
      threadId: thread,
      ...(providerObserved
        ? { providerObservedThread: { scope: "forum" as const, id: thread } }
        : {}),
    });
  }
  resetTelegramMessageCacheForTest();
  const mutate = (messageId: number, accountId = "default") =>
    invoke(
      "delete",
      { chatId: "-1001:topic:77", messageId },
      observed({}, { accountId, requesterAccountId: accountId }),
    );
  await mutate(900);
  await mutate(899);
  await expect(mutate(898)).rejects.toThrow(/provider-observed binding/);
  await expect(mutate(897)).rejects.toThrow(/provider-observed binding/);
  await expect(mutate(900, "work")).rejects.toThrow(/provider-observed binding/);
  expect(requests.map(({ fields }) => fields.message_id)).toEqual([900, 899]);
});

it("reads a routed account owner's persisted send observation after restart", async () => {
  cfg.agents = { ownership: "explicit", entries: { main: {}, ops: {}, research: {} } };
  cfg.channels!.telegram!.accounts = { alerts: { botToken: "654321:routed-alerts" } };
  cfg.bindings = [{ agentId: "ops", match: { channel: "telegram", accountId: "alerts" } }];
  await recordOutboundMessageForPromptContext({
    cfg,
    account: { accountId: "alerts", name: "Alerts" },
    chatId: -1001,
    messageId: 902,
    message: {
      message_id: 902,
      message_thread_id: 77,
      date: 1_736_380_700,
      chat: { id: -1001, type: "supergroup", title: "QA" },
      text: "earlier reply",
    },
    successfulSendThread: { scope: "forum", id: 77 },
  });
  resetTelegramMessageCacheForTest();
  await invoke(
    "delete",
    { chatId: "-1001:topic:77", messageId: 902 },
    observed({}, { accountId: "alerts", requesterAccountId: "alerts" }),
  );
  expect(endpoints).toEqual(["/bot654321:routed-alerts/deleteMessage"]);
  expect(requests[0]!.fields).toEqual({ chat_id: "-1001", message_id: 902 });
});

it("keeps direct operator bypass local to its concurrent operation", async () => {
  const params = { chatId: "-1001:topic:77", messageId: 800 };
  const outcomes = await Promise.allSettled([
    invoke("delete", params),
    invoke("delete", params, trusted),
  ]);
  expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
  expect(requests.map(({ fields }) => fields.message_id)).toEqual([800]);
});

it("uses the configured default account for reaction permission and the actual endpoint", async () => {
  cfg.channels!.telegram = {
    ...fixture.cfg.channels.telegram,
    defaultAccount: "kitt",
    reactionLevel: "minimal",
    actions: { reactions: false },
    accounts: { kitt: { botToken: "654321:default-kitt", actions: { reactions: true } } },
  };
  await react();
  expect(endpoints).toEqual(["/bot654321:default-kitt/setMessageReaction"]);
});

it("bounds rejected-reaction guidance while preferring portable alternatives", async () => {
  rejections.push("Bad Request: REACTION_INVALID");
  fixture.responseFor = (method) =>
    method === "getChat"
      ? {
          available_reactions: [...customEmoji(25), { type: "emoji", emoji: "👍" }],
        }
      : undefined;
  const result = await react({ emoji: "✅" });
  expect(result.details).toMatchObject({ ok: false });
  const details = JSON.stringify(result.details);
  expect(details).toContain("👍");
  expect(details).toContain("9018");
  expect(details).not.toContain("9019");
  expectMethods(["setMessageReaction", "getChat"]);
});

it.each([false, true])(
  "distinguishes unrestricted reactions from failed discovery (failed: %s)",
  async (failed) => {
    rejections.push(
      "Bad Request: REACTION_INVALID",
      ...(failed ? ["Bad Request: chat not found"] : []),
    );
    const result = await react({ emoji: "✅" });
    expect(result.details).toMatchObject({ ok: false });
    expect(JSON.stringify(result.details).includes("This chat allows:")).toBe(!failed);
  },
);

it("discovers only the delegated current chat and bounds provider reaction lists", async () => {
  fixture.responseFor = () => ({
    available_reactions: [{ type: "emoji", emoji: "👍" }, ...customEmoji(120)],
  });
  for (const context of [
    observed({}, { requesterAccountId: "other" }),
    observed({ currentChannelProvider: "discord" }),
  ]) {
    await expect(invoke("emoji-list", {}, context)).rejects.toThrow(
      /exact current chat and account/,
    );
  }
  await expect(invoke("emoji-list", { chatId: "-1002" }, trusted)).rejects.toThrow(
    /exact current chat and account/,
  );
  expect(requests).toEqual([]);
  await expect(invoke("emoji-list", { limit: 2 }, trusted)).resolves.toMatchObject({
    details: {
      ok: true,
      emojis: [
        { name: "👍", identifier: "👍" },
        { identifier: "9000", type: "custom_emoji" },
      ],
    },
  });
  const capped = await invoke("emoji-list", { chatId: "-1002", limit: 200 });
  expect(capped.details).toMatchObject({
    emojis: expect.arrayContaining([{ identifier: "9098", type: "custom_emoji" }]),
  });
  expect(JSON.stringify(capped.details)).not.toContain("9099");
  expect(requests.map(({ fields }) => fields.chat_id)).toEqual(["-1001", "-1002"]);
});

const send = { to: "123", message: "hello" };
const target = { chatId: "123", messageId: 456 };
const reaction = { chatId: "123", messageId: 456, emoji: "👍" };
const sticker = { to: "123", fileId: "sticker" };
const stickerEnabled = { actions: { sticker: true } };
const badPoll = { to: "123", ...poll, pollAnonymous: true, pollPublic: true };
const mixedContent = {
  to: "123",
  location: { latitude: 1, longitude: 2 },
  presentation: { blocks: [{ type: "text", text: "caption" }] },
};
const nativeButtons = {
  to: "123",
  message: "choose",
  buttons: '[[{"text":"Yes","callback_data":"yes"}]]',
};
const disabled = /disabled/i;
const gate = (name: "sendMessage" | "poll" | "deleteMessage" | "reactions" | "sticker") => ({
  actions: { [name]: false },
});
const groupButtons = {
  to: "-1001",
  message: "Choose",
  presentation: { blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "env|prod" }] }] },
};
it.each([
  ["send", { to: "123" }, stickerEnabled, /content required/i],
  ["poll", badPoll, stickerEnabled, /mutually exclusive/i],
  ["send", mixedContent, stickerEnabled, /cannot be combined/],
  ["send", nativeButtons, stickerEnabled, /native "buttons" is unsupported/],
  [
    "topic-create",
    { chatId: "123" },
    { actions: { createForumTopic: true } },
    { name: "ToolInputError", status: 400 },
  ],
  ["react", { ...reaction, messageId: undefined }, undefined, "missing_message_id"],
  ["react", { ...reaction, messageId: 456.5 }, undefined, "missing_message_id"],
  ["react", reaction, { reactionLevel: "off", actions: { reactions: true } }, "disabled"],
  ["react", reaction, { reactionLevel: "minimal", actions: { reactions: false } }, "disabled"],
  ["send", send, gate("sendMessage"), disabled],
  ["poll", { to: "123", ...poll }, gate("poll"), disabled],
  ["delete", target, gate("deleteMessage"), disabled],
  ["emoji-list", { chatId: "123" }, gate("reactions"), disabled],
  ["sticker", sticker, gate("sticker"), disabled],
  ["send", groupButtons, { capabilities: { inlineButtons: "off" } }, /inline buttons/],
  ["send", groupButtons, { capabilities: { inlineButtons: "dm" } }, /inline buttons/],
  ["send", send, "missing-token", /bot token missing/],
] as const)(
  "rejects %s before network delivery: %j %j %j",
  async (action, params, telegram, expected) => {
    if (telegram === "missing-token") {
      cfg = {};
    } else if (telegram) {
      Object.assign(cfg.channels!.telegram!, telegram);
    }
    const result = invoke(action, params);
    if (typeof expected === "string") {
      await expect(result).resolves.toMatchObject({ details: { ok: false, reason: expected } });
    } else if (expected instanceof RegExp) {
      await expect(result).rejects.toThrow(expected);
    } else {
      await expect(result).rejects.toMatchObject(expected);
    }
    expect(requests).toEqual([]);
  },
);
