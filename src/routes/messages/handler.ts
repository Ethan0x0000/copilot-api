import type { Context } from "hono"

import { type SSEStreamingApi, streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  getSmallModel,
  getReasoningEffortForModel,
  isMessagesApiEnabled,
} from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  consumeWithKeepAlive,
  getStreamKeepAliveOptions,
} from "~/lib/stream-keepalive"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import type { SubagentMarker } from "./subagent-marker"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  isCompactRequest,
  mergeToolResultForClaude,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import {
  mapReasoningEffortToAnthropic,
  resolveRequestedReasoningEffort,
  type ReasoningEffort,
} from "./reasoning-effort"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

/** SSE keepalive ping — same format as Anthropic's native ping event. */
const KEEPALIVE_SSE_PING = {
  event: "ping",
  data: '{"type":"ping"}',
} as const

/** SSE error event emitted when upstream is silent beyond the idle timeout. */
const IDLE_TIMEOUT_SSE_ERROR = {
  event: "error",
  data: JSON.stringify({
    type: "error",
    error: {
      type: "api_error",
      message:
        "Upstream stream idle timeout: no events received within the configured timeout period.",
    },
  }),
} as const

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    logger.debug("Detected Subagent marker:", JSON.stringify(subagentMarker))
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isCompact) {
    anthropicPayload.model = getSmallModel()
  }

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
  } else {
    stripToolReferenceTurnBoundary(anthropicPayload)

    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests are excluded from this processing
    mergeToolResultForClaude(anthropicPayload)
  }

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact,
    })
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
  })
}

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: {
    subagentMarker?: SubagentMarker | null
    requestId: string
    sessionId?: string
    isCompact?: boolean
  },
) => {
  const { subagentMarker, requestId, sessionId, isCompact } = options
  const openAIPayload = translateToOpenAI(anthropicPayload)
  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const response = await createChatCompletions(openAIPayload, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
  })

  if (isNonStreaming(response)) {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response),
    )
    const anthropicResponse = translateToAnthropic(response)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    await consumeWithKeepAlive(response, getStreamKeepAliveOptions(), {
      onEvent: async (rawEvent) => {
        logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
        if (rawEvent.data === "[DONE]") {
          return false
        }

        if (!rawEvent.data) {
          return true
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          logger.debug("Translated Anthropic event:", JSON.stringify(event))
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
        return true
      },
      onHeartbeat: async () => {
        logger.debug("Sending keepalive ping (Chat Completions)")
        await stream.writeSSE(KEEPALIVE_SSE_PING)
      },
      onIdleTimeout: async () => {
        logger.warn("Upstream idle timeout (Chat Completions)")
        await stream.writeSSE(IDLE_TIMEOUT_SSE_ERROR)
      },
    })
  })
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: {
    subagentMarker?: SubagentMarker | null
    selectedModel?: Model
    requestId: string
    sessionId?: string
    isCompact?: boolean
  },
) => {
  const { subagentMarker, selectedModel, requestId, sessionId, isCompact } =
    options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  compactInputByLatestCompaction(responsesPayload)

  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator: initiator,
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, (stream) =>
      streamResponsesWithKeepAlive(stream, response),
    )
  }

  logger.debug(
    "Non-streaming Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
  )
  logger.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: {
    anthropicBetaHeader?: string
    subagentMarker?: SubagentMarker | null
    selectedModel?: Model
    requestId: string
    sessionId?: string
    isCompact?: boolean
  },
) => {
  const {
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    isCompact,
  } = options
  // Pre-request processing: filter thinking blocks for Claude models so only
  // valid thinking blocks are sent to the Copilot Messages API.
  for (const msg of anthropicPayload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })
    }
  }

  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking#extended-thinking-with-tool-use
  // Using tool_choice: {"type": "any"} or tool_choice: {"type": "tool", "name": "..."} will result in an error because these options force tool use, which is incompatible with extended thinking.
  const toolChoice = anthropicPayload.tool_choice
  const disableThink = toolChoice?.type === "any" || toolChoice?.type === "tool"
  const requestEffort = resolveRequestedReasoningEffort(anthropicPayload)

  // Clean non-standard fields before forwarding to upstream Messages API
  delete anthropicPayload.reasoning
  delete anthropicPayload.reasoning_effort

  if (selectedModel?.capabilities.supports.adaptive_thinking && !disableThink) {
    anthropicPayload.thinking = {
      type: "adaptive",
    }
    anthropicPayload.output_config = {
      effort: getAnthropicEffortForModel(anthropicPayload.model, requestEffort),
    }
  }

  logger.debug("Translated Messages payload:", JSON.stringify(anthropicPayload))

  const response = await createMessages(anthropicPayload, anthropicBetaHeader, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
  })

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, async (stream) => {
      await consumeWithKeepAlive(response, getStreamKeepAliveOptions(), {
        onEvent: async (event) => {
          const eventName = event.event
          const data = event.data ?? ""
          logger.debug("Messages raw stream event:", data)
          await stream.writeSSE({
            event: eventName,
            data,
          })
          return true
        },
        onHeartbeat: async () => {
          logger.debug("Sending keepalive ping (Messages API)")
          await stream.writeSSE(KEEPALIVE_SSE_PING)
        },
        onIdleTimeout: async () => {
          logger.warn("Upstream idle timeout (Messages API)")
          await stream.writeSSE(IDLE_TIMEOUT_SSE_ERROR)
        },
      })
    })
  }

  logger.debug(
    "Non-streaming Messages result:",
    JSON.stringify(response).slice(-400),
  )
  return c.json(response)
}

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

/** Extracted from handleWithResponsesApi to stay within max-lines-per-function. */
async function streamResponsesWithKeepAlive(
  stream: SSEStreamingApi,
  response: AsyncIterable<{ event?: string; data?: string }>,
): Promise<void> {
  const streamState = createResponsesStreamState()
  // Track whether the stream ended due to idle timeout (mutated in onIdleTimeout closure).
  // Using an object to satisfy @typescript-eslint/no-unnecessary-condition which cannot
  // track mutations across async closures on plain `let` bindings.
  const flags = { idleTimedOut: false }

  await consumeWithKeepAlive(response, getStreamKeepAliveOptions(), {
    onEvent: async (chunk) => {
      const eventName = chunk.event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        return true
      }

      const data = chunk.data
      if (!data) {
        return true
      }

      logger.debug("Responses raw stream event:", data)

      const events = translateResponsesStreamEvent(
        JSON.parse(data) as ResponseStreamEvent,
        streamState,
      )
      for (const event of events) {
        const eventData = JSON.stringify(event)
        logger.debug("Translated Anthropic event:", eventData)
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }

      if (streamState.messageCompleted) {
        logger.debug("Message completed, ending stream")
        return false
      }
      return true
    },
    onHeartbeat: async () => {
      logger.debug("Sending keepalive ping (Responses API)")
      await stream.writeSSE(KEEPALIVE_SSE_PING)
    },
    onIdleTimeout: async () => {
      logger.warn("Upstream idle timeout (Responses API)")
      flags.idleTimedOut = true
      await stream.writeSSE(IDLE_TIMEOUT_SSE_ERROR)
    },
  })

  if (!flags.idleTimedOut && !streamState.messageCompleted) {
    logger.warn(
      "Responses stream ended without completion; sending error event",
    )
    const errorEvent = buildErrorEvent(
      "Responses stream ended without completion",
    )
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  }
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const getAnthropicEffortForModel = (
  model: string,
  requestedEffort?: ReasoningEffort,
): "low" | "medium" | "high" | "max" => {
  const reasoningEffort = requestedEffort ?? getReasoningEffortForModel(model)

  return mapReasoningEffortToAnthropic(reasoningEffort)
}
