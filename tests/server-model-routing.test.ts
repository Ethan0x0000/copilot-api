import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AccountManager } from "~/lib/account-manager"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { server } from "~/server"

describe("server middleware model routing", () => {
  const modelCatalog: ModelsResponse = {
    object: "list",
    data: [
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "4.6",
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
      {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "5-mini",
        model_picker_enabled: true,
        capabilities: {
          family: "gpt-5",
          limits: {
            max_output_tokens: 16_384,
            max_prompt_tokens: 128_000,
          },
          object: "model_capabilities",
          supports: {
            streaming: true,
            tool_calls: true,
          },
          tokenizer: "o200k_base",
          type: "chat",
        },
        supported_endpoints: ["/v1/messages", "/responses"],
      },
    ],
  }

  let capturedModels: Array<string | undefined>

  beforeEach(() => {
    capturedModels = []
    state.models = modelCatalog
    state.accountManager = {
      hasAccounts: () => true,
      resolveAccount: (_sessionId?: string, model?: string) => {
        capturedModels.push(model)
        return undefined
      },
    } as unknown as AccountManager
  })

  afterEach(() => {
    state.accountManager = undefined
    state.models = undefined
  })

  test("normalizes the requested Claude alias before account selection", async () => {
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(503)
    expect(capturedModels).toEqual(["claude-opus-4.6"])
  })

  test("applies warmup small-model routing before account selection", async () => {
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(503)
    expect(capturedModels).toEqual(["gpt-5-mini"])
  })
})
