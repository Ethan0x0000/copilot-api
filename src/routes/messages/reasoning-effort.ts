import type { AnthropicMessagesPayload } from "./anthropic-types"

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"

export type AnthropicEffort = "low" | "medium" | "high" | "max"

export const resolveRequestedReasoningEffort = (
  payload: AnthropicMessagesPayload,
): ReasoningEffort | undefined => {
  if (payload.reasoning?.effort) {
    return payload.reasoning.effort
  }

  if (payload.reasoning_effort) {
    return payload.reasoning_effort
  }

  const anthropicEffort = payload.output_config?.effort
  if (anthropicEffort === "max") {
    return "xhigh"
  }

  if (anthropicEffort) {
    return anthropicEffort
  }

  return undefined
}

export const mapReasoningEffortToAnthropic = (
  effort: ReasoningEffort,
): AnthropicEffort => {
  if (effort === "xhigh") return "max"
  if (effort === "none" || effort === "minimal") return "low"

  return effort
}
