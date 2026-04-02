import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Hono } from "hono"

import type { AccountManager } from "~/lib/account-manager"

import { state } from "~/lib/state"

// ── Test Setup ───────────────────────────────────────────────────────────

/**
 * Create a minimal Hono server with the session extraction middleware.
 * This mimics the actual server.ts middleware behavior.
 */
const createTestServer = () => {
  const app = new Hono()

  // Middleware that extracts session ID (mimics server.ts:57-99)
  app.use("*", async (c, next) => {
    const accountManager = state.accountManager
    if (!accountManager?.hasAccounts()) {
      return next()
    }

    // CURRENT BEHAVIOR: Only extracts from header (line 63 in server.ts)
    const sessionId = c.req.header("x-session-id")

    // Extract model from request body
    let model: string | undefined
    if (c.req.method === "POST") {
      try {
        const cloned = c.req.raw.clone()
        const body = (await cloned.json()) as { model?: string }
        model = body.model
      } catch {
        // Not JSON or no model field — fine
      }
    }

    const account = accountManager.resolveAccount(sessionId, model)
    if (!account) {
      return c.json({ error: "No active account" }, 503)
    }

    return next()
  })

  // Test route
  app.post("/v1/messages", (c) => c.json({ ok: true }))

  return app
}

// ── Test Cases ───────────────────────────────────────────────────────────

describe("server middleware session extraction", () => {
  let mockAccountManager: AccountManager
  let capturedArgs: Array<{ sessionId?: string; model?: string }>

  beforeEach(() => {
    capturedArgs = []

    // Mock AccountManager that captures resolveAccount calls
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

  // ── Test 1: Header extraction (existing behavior) ──────────────────────

  test("extracts session from x-session-id header", async () => {
    const app = createTestServer()

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "header-session-123",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).toBe("header-session-123")
  })

  // ── Test 2: Body metadata extraction (WILL FAIL — missing feature) ──────

  test("extracts session from metadata.user_id in body (no header)", async () => {
    const app = createTestServer()

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        metadata: { user_id: "user_abc_account_session_my-body-session" },
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(capturedArgs).toHaveLength(1)
    // WILL FAIL: sessionId will be undefined because middleware doesn't read body
    expect(capturedArgs[0].sessionId).not.toBeUndefined()
  })

  // ── Test 3: Header precedence over body ──────────────────────────────

  test("header takes precedence over body metadata.user_id", async () => {
    const app = createTestServer()

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "header-wins",
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        metadata: { user_id: "user_abc_account_session_body-session" },
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).toBe("header-wins")
  })

  // ── Test 4: No session in either source ──────────────────────────────

  test("no session in either header or body → sessionId is undefined", async () => {
    const app = createTestServer()

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0].sessionId).toBeUndefined()
  })

  // ── Test 5: Legacy format metadata.user_id (WILL FAIL) ──────────────

  test("parses legacy format metadata.user_id correctly", async () => {
    const app = createTestServer()

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        metadata: { user_id: "user_myuser_account_session_legacy-sess-42" },
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(capturedArgs).toHaveLength(1)
    // WILL FAIL: sessionId will be undefined because middleware doesn't read body
    // When fixed, should be getUUID("legacy-sess-42")
    expect(capturedArgs[0].sessionId).not.toBeUndefined()
  })

  // ── Test 6: JSON format metadata.user_id (WILL FAIL) ──────────────────

  test("parses JSON format metadata.user_id correctly", async () => {
    const app = createTestServer()

    const jsonUserId = JSON.stringify({
      session_id: "json-format-session",
      device_id: "device-123",
    })

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        metadata: { user_id: jsonUserId },
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(capturedArgs).toHaveLength(1)
    // WILL FAIL: sessionId will be undefined because middleware doesn't read body
    // When fixed, should be getUUID("json-format-session")
    expect(capturedArgs[0].sessionId).not.toBeUndefined()
  })
})
