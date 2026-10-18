import type { Chat, Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { buildTelegramApprovalCallbackData } from "./approval-callback-data.js";
import { resolveTelegramForumFlag } from "./bot/helpers.js";
import { getTelegramSequentialConstraints, getTelegramSequentialKey } from "./sequential-key.js";

const mockChat = (
  chat: Pick<Chat, "id"> & Partial<Pick<Chat, "type" | "is_forum" | "is_direct_messages">>,
): Chat => chat as Chat;
const mockMessage = (message: Pick<Message, "chat"> & Partial<Message>): Message =>
  ({
    message_id: 1,
    date: 0,
    ...message,
  }) as Message;
const forumMessage = (text: string) =>
  mockMessage({
    chat: mockChat({ id: -100, type: "supergroup", is_forum: true }),
    is_topic_message: true,
    message_thread_id: 5907,
    text,
  });
const groupMessage = (id: number, extra: Partial<Message> = {}) =>
  mockMessage({ chat: mockChat({ id, type: "supergroup" }), ...extra });
const callback = (id: number, data: string) => ({
  update: { callback_query: { message: mockMessage({ chat: mockChat({ id }) }), data } },
});

describe("getTelegramSequentialKey", () => {
  it.each([
    [
      {
        me: { has_topics_enabled: true } as never,
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123:topic:9",
    ],
    [
      {
        me: { username: "openclaw_bot" } as never,
        message: forumMessage("/stop@some_other_bot"),
      },
      "telegram:-100:topic:5907",
    ],
    [
      {
        me: { username: "openclaw_bot" } as never,
        message: forumMessage("/stop@openclaw_bot!"),
      },
      "telegram:-100:control",
    ],
    // Interrupt commands keep the chat-wide control lane. `/approve` in particular must
    // never queue behind the run that is blocked waiting on its own approval request.
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123 }),
          text: "/approve exec:def456 allow-once",
        }),
      },
      "telegram:123:control",
    ],
    [{ message: forumMessage("/new sync tars") }, "telegram:-100:topic:5907"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/btw what is the time?" }) },
      "telegram:123:btw:1",
    ],
    [
      callback(
        654,
        buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "plugin",
          approvalId: "signed-approval",
          decision: "allow-once",
        }),
      ),
      "telegram:654:approval",
    ],
    [callback(321, "tgq1:ask_0123456789abcdef0123456789abcdef:2"), "telegram:321:question"],
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toEqual(expected);
  });

  it("keeps malformed message updates on the unknown lane", () => {
    expect(getTelegramSequentialKey({ message: {} as Message })).toBe("telegram:unknown");
  });

  describe("forum flag cache fallback", () => {
    it("uses cached forum flag to assign topic:1 lane when payload lacks is_forum and is_topic_message", async () => {
      await resolveTelegramForumFlag({
        chatId: -9001,
        chatType: "supergroup",
        isGroup: true,
        isForum: true,
      });

      expect(getTelegramSequentialKey({ message: groupMessage(-9001) })).toBe(
        "telegram:-9001:topic:1",
      );
    });

    it("falls back to base lane when cache is empty and payload lacks is_forum hint", () => {
      expect(getTelegramSequentialKey({ message: groupMessage(-9002) })).toBe("telegram:-9002");
    });

    it("honors an explicit forum hint when the cached flag is stale", async () => {
      await resolveTelegramForumFlag({
        chatId: -9004,
        chatType: "supergroup",
        isGroup: true,
        isForum: false,
      });

      expect(
        getTelegramSequentialKey({
          message: groupMessage(-9004, { is_topic_message: true }),
        }),
      ).toBe("telegram:-9004:topic:1");
    });
  });
});

describe("getTelegramSequentialConstraints", () => {
  it("bridges a channel Direct Messages message with its reaction without coupling topics", () => {
    const message = mockMessage({
      chat: mockChat({
        id: -1002,
        type: "supergroup",
        is_direct_messages: true,
      } as Chat),
      message_id: 77,
      message_thread_id: 999,
      direct_messages_topic: { topic_id: 9, user: { id: 1 } as never },
      is_topic_message: true,
    });
    const expected = "telegram:-1002:message:77";
    const reaction = (message_id: number) => ({
      update: {
        message_reaction: {
          chat: { id: -1002, type: "supergroup", is_direct_messages: true },
          message_id,
        },
      },
    });

    expect(getTelegramSequentialConstraints({ message })).toEqual([
      "telegram:-1002:topic:9",
      expected,
    ]);
    expect(getTelegramSequentialConstraints(reaction(77))).toBe(expected);
    expect(getTelegramSequentialConstraints(reaction(78))).toBe("telegram:-1002:message:78");
  });

  it("does not add a bridge lane outside forum chats", () => {
    expect(
      getTelegramSequentialConstraints({
        message: mockMessage({ chat: mockChat({ id: 123, type: "private" }) }),
      }),
    ).toBe("telegram:123");
  });
});
