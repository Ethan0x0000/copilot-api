import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ApiKeyConfig } from "~/lib/config"

import {
  createAuthMiddleware,
  extractRequestApiKey,
  normalizeApiKeys,
} from "~/lib/request-auth"

const createRequestApiKeyTestContext = () => {
  const app = new Hono()
  let capturedKey: string | null = null

  app.all("/test", (c) => {
    capturedKey = extractRequestApiKey(c)
    return c.text("ok")
  })

  return { app, getKey: () => capturedKey }
}

const createAuthTestApp = (keys: Array<ApiKeyConfig>) => {
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => keys,
      allowUnauthenticatedPaths: ["/"],
    }),
  )
  app.get("/", (c) => c.text("home"))
  app.get("/protected", (c) => c.text("ok"))
  app.post("/v1/messages", (c) => c.text("ok"))
  return app
}

// ── normalizeApiKeys ─────────────────────────────────────────────────

describe("normalizeApiKeys", () => {
  test("handles plain string entries (backward compat)", () => {
    const result = normalizeApiKeys(["key-a", "key-b"])
    expect(result).toEqual([
      { name: "key-1", key: "key-a" },
      { name: "key-2", key: "key-b" },
    ])
  })

  test("handles object entries with name and limit", () => {
    const result = normalizeApiKeys([
      { name: "personal", key: "sk-111", monthlyPremiumLimit: 50 },
      { name: "team", key: "sk-222" },
    ])
    expect(result).toEqual([
      { name: "personal", key: "sk-111", monthlyPremiumLimit: 50 },
      { name: "team", key: "sk-222" },
    ])
  })

  test("handles mixed string and object entries", () => {
    const result = normalizeApiKeys([
      "plain-key",
      { name: "named", key: "sk-obj", monthlyPremiumLimit: 100 },
    ])
    expect(result).toEqual([
      { name: "key-1", key: "plain-key" },
      { name: "named", key: "sk-obj", monthlyPremiumLimit: 100 },
    ])
  })

  test("deduplicates keys", () => {
    const result = normalizeApiKeys(["dup", "dup", "unique"])
    expect(result).toHaveLength(2)
    expect(result[0].key).toBe("dup")
    expect(result[1].key).toBe("unique")
  })

  test("trims whitespace from keys", () => {
    const result = normalizeApiKeys(["  spaced  "])
    expect(result[0].key).toBe("spaced")
  })

  test("skips empty strings", () => {
    const result = normalizeApiKeys(["", "  ", "valid"])
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe("valid")
  })

  test("returns empty array for undefined", () => {
    expect(normalizeApiKeys(undefined)).toEqual([])
  })

  test("returns empty array for non-array", () => {
    expect(normalizeApiKeys("not-an-array")).toEqual([])
  })

  test("auto-generates name for object without name", () => {
    const result = normalizeApiKeys([{ key: "sk-no-name" }])
    expect(result[0].name).toBe("key-1")
  })
})

// ── extractRequestApiKey ─────────────────────────────────────────────

describe("extractRequestApiKey", () => {
  test("extracts from x-api-key header", async () => {
    const { app, getKey } = createRequestApiKeyTestContext()
    await app.request("/test", { headers: { "x-api-key": "my-key" } })
    expect(getKey()).toBe("my-key")
  })

  test("extracts from Authorization Bearer header", async () => {
    const { app, getKey } = createRequestApiKeyTestContext()
    await app.request("/test", {
      headers: { authorization: "Bearer my-token" },
    })
    expect(getKey()).toBe("my-token")
  })

  test("returns null when no auth header", async () => {
    const { app, getKey } = createRequestApiKeyTestContext()
    await app.request("/test")
    expect(getKey()).toBeNull()
  })

  test("ignores non-Bearer schemes", async () => {
    const { app, getKey } = createRequestApiKeyTestContext()
    await app.request("/test", {
      headers: { authorization: "Basic abc123" },
    })
    expect(getKey()).toBeNull()
  })
})

// ── createAuthMiddleware ─────────────────────────────────────────────

describe("createAuthMiddleware", () => {
  test("allows unauthenticated path", async () => {
    const app = createAuthTestApp([{ name: "test", key: "sk-123" }])
    const res = await app.request("/")
    expect(res.status).toBe(200)
  })

  test("allows request with valid key", async () => {
    const app = createAuthTestApp([{ name: "test", key: "sk-123" }])
    const res = await app.request("/protected", {
      headers: { "x-api-key": "sk-123" },
    })
    expect(res.status).toBe(200)
  })

  test("rejects request with invalid key", async () => {
    const app = createAuthTestApp([{ name: "test", key: "sk-123" }])
    const res = await app.request("/protected", {
      headers: { "x-api-key": "wrong-key" },
    })
    expect(res.status).toBe(401)
  })

  test("rejects request with no key when keys are configured", async () => {
    const app = createAuthTestApp([{ name: "test", key: "sk-123" }])
    const res = await app.request("/protected")
    expect(res.status).toBe(401)
  })

  test("allows all requests when no keys are configured", async () => {
    const app = createAuthTestApp([])
    const res = await app.request("/protected")
    expect(res.status).toBe(200)
  })

  test("allows OPTIONS bypass", async () => {
    const app = createAuthTestApp([{ name: "test", key: "sk-123" }])
    const res = await app.request("/protected", { method: "OPTIONS" })
    expect(res.status).toBe(404) // OPTIONS not explicitly handled, but middleware passes
  })

  test("works with multiple keys", async () => {
    const app = createAuthTestApp([
      { name: "alice", key: "sk-alice" },
      { name: "bob", key: "sk-bob" },
    ])

    const res1 = await app.request("/protected", {
      headers: { "x-api-key": "sk-alice" },
    })
    expect(res1.status).toBe(200)

    const res2 = await app.request("/protected", {
      headers: { "x-api-key": "sk-bob" },
    })
    expect(res2.status).toBe(200)
  })
})
