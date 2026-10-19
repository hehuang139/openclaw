import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import type { Agent } from "../../runtime/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  createDefaultEmbeddedSession,
  type EmbeddedAttemptSession,
} from "./attempt-spawn-workspace.test-support.js";

export function streamAttemptAssistant(model: Model, content: AssistantMessage["content"]) {
  const reason = content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop";
  const message = makeAgentAssistantMessage({
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    timestamp: Date.now(),
    content,
    stopReason: reason,
  });
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason, message });
    stream.end();
  });
  return stream;
}

export function createAgentBackedAttemptSession(agent: Agent): EmbeddedAttemptSession {
  const session: EmbeddedAttemptSession = createDefaultEmbeddedSession();
  const tools = agent.state.tools;
  session.agent = agent;
  Object.defineProperty(session, "messages", {
    get: () => agent.state.messages,
    set: (messages) => {
      agent.state.messages = messages;
    },
  });
  session.setActiveToolsByName = (names) => {
    agent.state.tools = tools.filter((tool) => names.includes(tool.name));
  };
  session.getActiveToolNames = () => agent.state.tools.map((tool) => tool.name);
  session.prompt = async (prompt, options) => {
    options?.preflightResult?.(true);
    await agent.prompt(prompt);
  };
  return session;
}
