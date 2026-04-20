import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { SubagentMarker } from "~/routes/messages/subagent-marker"

import { getAccountContext } from "~/lib/account-context"
import {
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { copilotFetchWithRetry } from "~/lib/copilot-fetch"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream
type AnthropicToolPayload = NonNullable<
  AnthropicMessagesPayload["tools"]
>[number]
interface CopilotMessagesTool extends AnthropicToolPayload {
  eager_input_streaming?: boolean
  custom?: Record<string, unknown>
}

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const allowedAnthropicBetas = new Set([
  INTERLEAVED_THINKING_BETA,
  "context-management-2025-06-27",
  "advanced-tool-use-2025-11-20",
])

const buildAnthropicBetaHeader = (
  anthropicBetaHeader: string | undefined,
  thinking: AnthropicMessagesPayload["thinking"],
): string | undefined => {
  const isAdaptiveThinking = thinking?.type === "adaptive"

  if (anthropicBetaHeader) {
    const filteredBeta = anthropicBetaHeader
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item) => allowedAnthropicBetas.has(item))
    const uniqueFilteredBetas = [...new Set(filteredBeta)]
    const finalFilteredBetas =
      isAdaptiveThinking ?
        uniqueFilteredBetas.filter((item) => item !== INTERLEAVED_THINKING_BETA)
      : uniqueFilteredBetas

    if (finalFilteredBetas.length > 0) {
      return finalFilteredBetas.join(",")
    }

    return undefined
  }

  if (thinking?.budget_tokens && !isAdaptiveThinking) {
    return INTERLEAVED_THINKING_BETA
  }

  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const sanitizeToolForCopilotMessages = (
  tool: AnthropicToolPayload,
): { tool: AnthropicToolPayload; changed: boolean } => {
  const candidate: CopilotMessagesTool = tool
  const sanitized: CopilotMessagesTool = { ...candidate }
  let changed = false

  if (sanitized.eager_input_streaming !== undefined) {
    delete sanitized.eager_input_streaming
    changed = true
  }

  const custom = sanitized.custom
  if (isRecord(custom) && "eager_input_streaming" in custom) {
    const sanitizedCustom = { ...custom }
    delete sanitizedCustom.eager_input_streaming
    sanitized.custom = sanitizedCustom
    changed = true
  }

  return {
    tool: changed ? (sanitized as AnthropicToolPayload) : tool,
    changed,
  }
}

const sanitizePayloadForCopilotMessages = (
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload => {
  if (!payload.tools?.length) {
    return payload
  }

  let changed = false
  const tools: Array<AnthropicToolPayload> = []
  for (const tool of payload.tools) {
    const result = sanitizeToolForCopilotMessages(tool)
    if (result.changed) {
      changed = true
    }

    tools.push(result.tool)
  }

  return changed ? { ...payload, tools } : payload
}

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
  options: {
    subagentMarker?: SubagentMarker | null
    requestId: string
    sessionId?: string
    isCompact?: boolean
  },
): Promise<CreateMessagesReturn> => {
  const sanitizedPayload = sanitizePayloadForCopilotMessages(payload)
  const account = getAccountContext()
  const copilotToken = account?.copilotToken ?? state.copilotToken
  if (!copilotToken) throw new Error("Copilot token not found")

  const enableVision = sanitizedPayload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === "image"),
  )

  let isInitiateRequest = false
  const lastMessage = sanitizedPayload.messages.at(-1)
  if (lastMessage?.role === "user") {
    isInitiateRequest =
      Array.isArray(lastMessage.content) ?
        lastMessage.content.some((block) => block.type !== "tool_result")
      : true
  }

  const headers: Record<string, string> = {
    ...copilotHeaders(state, options.requestId, enableVision),
    "x-initiator": isInitiateRequest ? "user" : "agent",
  }

  prepareInteractionHeaders(
    options.sessionId,
    Boolean(options.subagentMarker),
    headers,
  )

  prepareForCompact(headers, options.isCompact)

  // align with vscode copilot extension anthropic-beta
  const anthropicBeta = buildAnthropicBetaHeader(
    anthropicBetaHeader,
    sanitizedPayload.thinking,
  )
  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta
  }

  const response = await copilotFetchWithRetry(
    `${copilotBaseUrl(state)}/v1/messages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(sanitizedPayload),
    },
    { model: sanitizedPayload.model, sessionId: options.sessionId },
  )

  if (!response.ok) {
    consola.error("Failed to create messages", response)
    throw new HTTPError("Failed to create messages", response)
  }

  if (sanitizedPayload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicResponse
}
