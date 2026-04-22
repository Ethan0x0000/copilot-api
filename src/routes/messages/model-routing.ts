import type { Model } from "~/services/copilot/get-models"

import { getSmallModel } from "~/lib/config"
import { findEndpointModel } from "~/lib/models"

import type { AnthropicMessagesPayload } from "./anthropic-types"

import { isCompactRequest } from "./preprocess"

export function resolveAnthropicRequestModel(
  anthropicPayload: Pick<
    AnthropicMessagesPayload,
    "messages" | "model" | "system" | "tools"
  >,
  anthropicBetaHeader: string | undefined,
): { model: string; selectedModel?: Model } {
  let routedModel = anthropicPayload.model
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0

  if (
    anthropicBetaHeader
    && noTools
    && !isCompactRequest(anthropicPayload as AnthropicMessagesPayload)
  ) {
    // Only fallback to small model for Claude-family models.
    // This prevents explicitly requested non-Claude models (e.g., gemini-3.1-pro-preview)
    // from being incorrectly routed to the small model by Claude Code warmup logic.
    const originalModel = findEndpointModel(anthropicPayload.model)
    if (originalModel && originalModel.capabilities.family === "claude") {
      routedModel = getSmallModel()
    }
  }

  const selectedModel = findEndpointModel(routedModel)

  return {
    model: selectedModel?.id ?? routedModel,
    selectedModel,
  }
}
