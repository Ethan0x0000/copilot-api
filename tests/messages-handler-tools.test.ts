import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { server } from "~/server"

const modelCatalog: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "4.5",
      model_picker_enabled: true,
      capabilities: {
        family: "claude",
        limits: {
          max_output_tokens: 16_384,
          max_prompt_tokens: 200_000,
        },
        object: "model_capabilities",
        supports: {
          streaming: true,
          tool_calls: true,
        },
        tokenizer: "claude",
        type: "chat",
      },
      supported_endpoints: ["/v1/messages"],
    },
  ],
}

const originalFetch = globalThis.fetch

let fetchMock: ReturnType<typeof mock>
let forwardedBody: unknown

describe("messages handler tool sanitization", () => {
  beforeEach(() => {
    forwardedBody = undefined
    fetchMock = mock((_url: string, init?: RequestInit) => {
      forwardedBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined

      return new Response(
        JSON.stringify({
          id: "msg_123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-haiku-4.5",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    })

    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.0.0"
    state.models = modelCatalog
    state.accountManager = undefined
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    state.copilotToken = undefined
    state.vsCodeVersion = undefined
    state.models = undefined
    state.accountManager = undefined
  })

  test("strips unsupported eager_input_streaming fields before forwarding Messages API tools", async () => {
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "write_file",
            description: "Write content to a file",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
            },
            eager_input_streaming: true,
            custom: {
              type: "text_editor_20250124",
              eager_input_streaming: true,
            },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const body = forwardedBody as {
      tools?: Array<{
        name: string
        description: string
        input_schema: Record<string, unknown>
        eager_input_streaming?: boolean
        custom?: {
          type?: string
          eager_input_streaming?: boolean
        }
      }>
    }

    expect(body.tools).toEqual([
      {
        name: "write_file",
        description: "Write content to a file",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
        custom: {
          type: "text_editor_20250124",
        },
      },
    ])
  })
})
