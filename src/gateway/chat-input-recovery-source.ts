import type { GatewayClientInfo } from "../../packages/gateway-protocol/src/client-info.js";
import type { createOperatorInputRecoverySource } from "../agents/operator-run-recovery-source.js";
import { shouldComputeCommandAuthorized } from "../auto-reply/command-detection.js";
import type { NormalizedChatSendRequest } from "./server-methods/chat-send-request.js";

type ChatInputRecovery = {
  version: 1;
  source: NonNullable<ReturnType<typeof createOperatorInputRecoverySource>>;
  clientInfo?: GatewayClientInfo;
  suppressCommandInterpretation: boolean;
  request: Pick<
    NormalizedChatSendRequest["p"],
    | "thinking"
    | "fastMode"
    | "fastAutoOnSeconds"
    | "timeoutMs"
    | "deliver"
    | "queueMode"
    | "replyToId"
    | "originatingChannel"
    | "originatingTo"
    | "originatingAccountId"
    | "originatingThreadId"
    | "suppressCommandInterpretation"
    | "systemInputProvenance"
    | "systemProvenanceReceipt"
  >;
};

/** Keep only execution options; approved text and media live in the input itself. */
export function createChatInputRecovery(params: {
  request: NormalizedChatSendRequest;
  source: ReturnType<typeof createOperatorInputRecoverySource>;
}): ChatInputRecovery | undefined {
  const { request, source } = params;
  // Attached-client capabilities cannot be re-created after the connection ends.
  if (
    !source ||
    request.toolBindings ||
    request.goalOperation ||
    request.turnKind !== "main" ||
    (request.systemInputProvenance && request.systemInputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const p = request.p;
  return {
    version: 1,
    source,
    clientInfo: request.clientInfo,
    suppressCommandInterpretation:
      request.suppressCommandInterpretation ||
      !shouldComputeCommandAuthorized(request.inboundMessage),
    request: {
      thinking: p.thinking,
      fastMode: p.fastMode,
      fastAutoOnSeconds: p.fastAutoOnSeconds,
      timeoutMs: p.timeoutMs,
      deliver: p.deliver,
      queueMode: p.queueMode,
      replyToId: p.replyToId,
      originatingChannel: p.originatingChannel,
      originatingTo: p.originatingTo,
      originatingAccountId: p.originatingAccountId,
      originatingThreadId: p.originatingThreadId,
      suppressCommandInterpretation: p.suppressCommandInterpretation,
      systemInputProvenance: request.systemInputProvenance,
      systemProvenanceReceipt: request.systemProvenanceReceipt,
    },
  };
}
