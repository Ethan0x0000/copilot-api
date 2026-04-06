import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import {
  mergeToolResultForClaude,
  stripToolReferenceTurnBoundary,
} from "~/routes/messages/preprocess"

describe("mergeToolResultForClaude", () => {
  test("removes tool reference turn boundaries before merging", () => {
    const payload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    stripToolReferenceTurnBoundary(payload)
    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })

  test("keeps Tool loaded text when the message has no tool_reference", () => {
    const payload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    } as AnthropicMessagesPayload

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "Tool loaded.",
        },
      ],
    })
  })
})
