import { describe, expect, it } from "bun:test"

import {
  mapReasoningEffortToAnthropic,
  resolveRequestedReasoningEffort,
} from "~/routes/messages/reasoning-effort"

describe("resolveRequestedReasoningEffort", () => {
  it("prefers reasoning.effort", () => {
    const effort = resolveRequestedReasoningEffort({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "low" },
      reasoning_effort: "xhigh",
      output_config: { effort: "max" },
    })

    expect(effort).toBe("low")
  })

  it("falls back to compatibility reasoning_effort", () => {
    const effort = resolveRequestedReasoningEffort({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "minimal",
    })

    expect(effort).toBe("minimal")
  })

  it("maps anthropic output_config.effort max to xhigh", () => {
    const effort = resolveRequestedReasoningEffort({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    })

    expect(effort).toBe("xhigh")
  })

  it("returns undefined when no effort is provided", () => {
    const effort = resolveRequestedReasoningEffort({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    })

    expect(effort).toBeUndefined()
  })
})

describe("mapReasoningEffortToAnthropic", () => {
  it("maps xhigh to max", () => {
    expect(mapReasoningEffortToAnthropic("xhigh")).toBe("max")
  })

  it("maps none/minimal to low", () => {
    expect(mapReasoningEffortToAnthropic("none")).toBe("low")
    expect(mapReasoningEffortToAnthropic("minimal")).toBe("low")
  })

  it("passes through low/medium/high", () => {
    expect(mapReasoningEffortToAnthropic("low")).toBe("low")
    expect(mapReasoningEffortToAnthropic("medium")).toBe("medium")
    expect(mapReasoningEffortToAnthropic("high")).toBe("high")
  })
})
