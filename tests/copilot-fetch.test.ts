import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { runWithAccount } from "~/lib/account-context"
import { AccountManager } from "~/lib/account-manager"
import { copilotFetchWithRetry } from "~/lib/copilot-fetch"
import { state } from "~/lib/state"

// --- Test helpers ---

interface TestAccountState {
  name: string
  githubToken: string
  copilotToken: string
  accountType: string
  tier: string
  active: boolean
  priority?: number
  status: "ready" | "error" | "rate_limited" | "disabled" | "quota_exhausted"
  modelCatalogKnown: boolean
  availableModels: Set<string>
  availableModelData: Array<unknown>
  unsupportedModels: Set<string>
  requestCount: number
  cooldownUntil?: number
  cooldownReason?: string
}

interface AccountManagerInternals {
  accounts: Map<string, TestAccountState>
}

const toInternals = (manager: AccountManager): AccountManagerInternals =>
  manager as unknown as AccountManagerInternals

const createAccount = (
  name: string,
  copilotToken: string,
): TestAccountState => ({
  name,
  githubToken: `${name}-gh`,
  copilotToken,
  accountType: "individual",
  tier: "pro",
  active: true,
  status: "ready",
  modelCatalogKnown: true,
  availableModels: new Set(["gpt-5-mini"]),
  availableModelData: [],
  unsupportedModels: new Set<string>(),
  requestCount: 0,
})

const seedAccounts = (
  manager: AccountManager,
  accounts: Array<TestAccountState>,
): void => {
  const internals = toInternals(manager)
  for (const account of accounts) {
    internals.accounts.set(account.name, account)
  }
}

// --- Mocking ---

const originalFetch = globalThis.fetch
let mockFetchFn: ReturnType<typeof mock>

beforeEach(() => {
  mockFetchFn = mock()
  globalThis.fetch = mockFetchFn as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.accountManager = undefined
})

// --- Tests ---

describe("copilotFetchWithRetry", () => {
  describe("5xx server error retry", () => {
    test("retries on 502 and fails over to next account", async () => {
      const manager = new AccountManager()
      seedAccounts(manager, [
        createAccount("account-1", "token-1"),
        createAccount("account-2", "token-2"),
      ])
      state.accountManager = manager

      mockFetchFn
        .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
        .mockResolvedValueOnce(new Response("OK", { status: 200 }))

      const headers = new Headers({
        Authorization: "Bearer token-1",
      })

      const response = await runWithAccount(
        {
          name: "account-1",
          copilotToken: "token-1",
          githubToken: "account-1-gh",
          accountType: "individual",
        },
        () =>
          copilotFetchWithRetry(
            "https://api.github.com/test",
            { headers },
            { sessionId: "sess-1" },
          ),
      )

      expect(response.status).toBe(200)
      expect(mockFetchFn).toHaveBeenCalledTimes(2)

      // Verify the second call used a different token
      const secondCallInit = (
        mockFetchFn.mock.calls[1] as [string, RequestInit]
      )[1]
      const secondCallHeaders = new Headers(secondCallInit.headers)
      expect(secondCallHeaders.get("Authorization")).toBe("Bearer token-2")
    })

    test("returns 5xx response when all accounts exhausted", async () => {
      const manager = new AccountManager()
      seedAccounts(manager, [createAccount("account-1", "token-1")])
      state.accountManager = manager

      mockFetchFn.mockResolvedValue(
        new Response("Bad Gateway", { status: 502 }),
      )

      const headers = new Headers({
        Authorization: "Bearer token-1",
      })

      const response = await runWithAccount(
        {
          name: "account-1",
          copilotToken: "token-1",
          githubToken: "account-1-gh",
          accountType: "individual",
        },
        () =>
          copilotFetchWithRetry(
            "https://api.github.com/test",
            { headers },
            { sessionId: "sess-1" },
          ),
      )

      expect(response.status).toBe(502)
    })

    test("applies short cooldown for 5xx (not the 90s rate-limit default)", async () => {
      const manager = new AccountManager()
      const accounts = [
        createAccount("account-1", "token-1"),
        createAccount("account-2", "token-2"),
      ]
      seedAccounts(manager, accounts)
      state.accountManager = manager

      mockFetchFn
        .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504 }))
        .mockResolvedValueOnce(new Response("OK", { status: 200 }))

      const headers = new Headers({
        Authorization: "Bearer token-1",
      })

      await runWithAccount(
        {
          name: "account-1",
          copilotToken: "token-1",
          githubToken: "account-1-gh",
          accountType: "individual",
        },
        () =>
          copilotFetchWithRetry(
            "https://api.github.com/test",
            { headers },
            { sessionId: "sess-1" },
          ),
      )

      const internals = toInternals(manager)
      const account1 = internals.accounts.get("account-1")
      expect(account1?.cooldownUntil).toBeDefined()
      // Cooldown should be ~30s (SERVER_ERROR_COOLDOWN_MS), not 90s
      const cooldownDuration = (account1?.cooldownUntil ?? 0) - Date.now()
      expect(cooldownDuration).toBeLessThanOrEqual(30_000)
      expect(cooldownDuration).toBeGreaterThan(0)
    })
  })

  describe("network error retry", () => {
    test("retries on network error and fails over to next account", async () => {
      const manager = new AccountManager()
      seedAccounts(manager, [
        createAccount("account-1", "token-1"),
        createAccount("account-2", "token-2"),
      ])
      state.accountManager = manager

      mockFetchFn
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce(new Response("OK", { status: 200 }))

      const headers = new Headers({
        Authorization: "Bearer token-1",
      })

      const response = await runWithAccount(
        {
          name: "account-1",
          copilotToken: "token-1",
          githubToken: "account-1-gh",
          accountType: "individual",
        },
        () =>
          copilotFetchWithRetry(
            "https://api.github.com/test",
            { headers },
            { sessionId: "sess-1" },
          ),
      )

      expect(response.status).toBe(200)
      expect(mockFetchFn).toHaveBeenCalledTimes(2)
    })

    test("throws network error when no failover available", () => {
      const manager = new AccountManager()
      seedAccounts(manager, [createAccount("account-1", "token-1")])
      state.accountManager = manager

      mockFetchFn.mockRejectedValue(new Error("fetch failed"))

      const headers = new Headers({
        Authorization: "Bearer token-1",
      })

      expect(
        runWithAccount(
          {
            name: "account-1",
            copilotToken: "token-1",
            githubToken: "account-1-gh",
            accountType: "individual",
          },
          () =>
            copilotFetchWithRetry(
              "https://api.github.com/test",
              { headers },
              { sessionId: "sess-1" },
            ),
        ),
      ).rejects.toThrow("fetch failed")
    })
  })

  describe("single-account mode (no accountManager)", () => {
    test("does not retry on 5xx without accountManager", async () => {
      state.accountManager = undefined

      mockFetchFn.mockResolvedValueOnce(
        new Response("Bad Gateway", { status: 502 }),
      )

      const response = await copilotFetchWithRetry(
        "https://api.github.com/test",
        {},
      )

      expect(response.status).toBe(502)
      expect(mockFetchFn).toHaveBeenCalledTimes(1)
    })
  })
})
