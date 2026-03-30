import { describe, expect, test } from "bun:test"

import {
  isUpstreamQuotaOrRateLimit,
  isUpstreamModelUnavailable,
  parseRetryAfterMs,
} from "~/lib/upstream-error"

describe("isUpstreamQuotaOrRateLimit", () => {
  test("returns true for 429 status", async () => {
    const response = new Response("Too Many Requests", { status: 429 })
    expect(await isUpstreamQuotaOrRateLimit(response)).toBe(true)
  })

  test("returns true for 403 with rate limit text", async () => {
    const response = new Response(
      JSON.stringify({ error: "rate limit exceeded" }),
      { status: 403 },
    )
    expect(await isUpstreamQuotaOrRateLimit(response)).toBe(true)
  })

  test("returns true for 403 with quota exhausted text", async () => {
    const response = new Response(
      JSON.stringify({ error: "quota exhausted" }),
      { status: 403 },
    )
    expect(await isUpstreamQuotaOrRateLimit(response)).toBe(true)
  })

  test("returns false for 403 without quota text", async () => {
    const response = new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
    })
    expect(await isUpstreamQuotaOrRateLimit(response)).toBe(false)
  })

  test("returns false for 500", async () => {
    const response = new Response("Server Error", { status: 500 })
    expect(await isUpstreamQuotaOrRateLimit(response)).toBe(false)
  })

  test("returns false for 200", async () => {
    const response = new Response("OK", { status: 200 })
    expect(await isUpstreamQuotaOrRateLimit(response)).toBe(false)
  })
})

describe("isUpstreamModelUnavailable", () => {
  test("returns true for 404 with model not found", async () => {
    const response = new Response(
      JSON.stringify({ error: "model not found" }),
      { status: 404 },
    )
    expect(await isUpstreamModelUnavailable(response)).toBe(true)
  })

  test("returns false for 404 without model text", async () => {
    const response = new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
    })
    expect(await isUpstreamModelUnavailable(response)).toBe(false)
  })
})

describe("parseRetryAfterMs", () => {
  test("parses numeric retry-after header", () => {
    const headers = new Headers({ "retry-after": "90" })
    expect(parseRetryAfterMs(headers, 60_000)).toBe(90_000)
  })

  test("uses fallback when header is missing", () => {
    const headers = new Headers()
    expect(parseRetryAfterMs(headers, 60_000)).toBe(60_000)
  })

  test("uses fallback for invalid header", () => {
    const headers = new Headers({ "retry-after": "invalid" })
    expect(parseRetryAfterMs(headers, 60_000)).toBe(60_000)
  })
})
