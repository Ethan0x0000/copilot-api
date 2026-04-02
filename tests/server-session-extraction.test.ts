import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AccountManager } from "~/lib/account-manager"

import { state } from "~/lib/state"
import { server } from "~/server"

describe("server middleware session extraction", () => {
  let mockAccountManager: AccountManager
  let capturedArgs: Array<{ sessionId?: string; model?: string }>

  beforeEach(() => {
    capturedArgs = []

    mockAccountManager = {
      hasAccounts: () => true,
      resolveAccount: (sessionId?: string, model?: string) => {
        capturedArgs.push({ sessionId, model })
        return {
          name: "test-acct",
          copilotToken: "tok",
          githubToken: "gh",
          accountType: "individual",
        }
      },
    } as unknown as AccountManager

    state.accountManager = mockAccountManager
  })

  afterEach(() => {
    state.accountManager = undefined
  })

  test("extracts session from x-session-id header", async () => {
    await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "header-session-123",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).toBe("header-session-123")
  })

  test("extracts session from metadata.user_id in body (no header)", async () => {
    await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 16,
        metadata: { user_id: "user_abc_account_session_my-body-session" },
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).not.toBeUndefined()
  })

  test("header takes precedence over body metadata.user_id", async () => {
    await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "header-wins",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 16,
        metadata: { user_id: "user_abc_account_session_body-session" },
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).toBe("header-wins")
  })

  test("no session in either header or body → sessionId is undefined", async () => {
    await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).toBeUndefined()
  })

  test("parses legacy format metadata.user_id correctly", async () => {
    await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 16,
        metadata: { user_id: "user_myuser_account_session_legacy-sess-42" },
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).not.toBeUndefined()
  })

  test("parses JSON format metadata.user_id correctly", async () => {
    const jsonUserId = JSON.stringify({
      session_id: "json-format-session",
      device_id: "device-123",
    })

    await server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 16,
        metadata: { user_id: jsonUserId },
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).not.toBeUndefined()
  })
})
