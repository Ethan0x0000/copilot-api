import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { parseSubagentMarkerFromFirstUser } from "~/routes/messages/subagent-marker"

describe("parseSubagentMarkerFromFirstUser", () => {
  test("skips string-only first user messages and finds the first array user message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-4.1",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: "plain first user",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"session-1","agent_id":"agent-1","agent_type":"explore"}</system-reminder>',
            },
          ],
        },
      ],
    }

    expect(parseSubagentMarkerFromFirstUser(payload)).toEqual({
      session_id: "session-1",
      agent_id: "agent-1",
      agent_type: "explore",
    })
  })
})
