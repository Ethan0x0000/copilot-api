import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { runWithAccount } from "~/lib/account-context"
import { AccountManager } from "~/lib/account-manager"
import { copilotFetchWithRetry } from "~/lib/copilot-fetch"
import { state } from "~/lib/state"

interface TestAccountState {
  name: string
  githubToken: string
  copilotToken: string
  accountType: string
  tier: string
  active: boolean
  status: "ready" | "error" | "rate_limited" | "disabled" | "quota_exhausted"
  modelCatalogKnown: boolean
  availableModels: Set<string>
  availableModelData: Array<unknown>
  unsupportedModels: Set<string>
  requestCount: number
  lastError?: string
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

describe("copilotFetchWithRetry account status handling", () => {
  test("marks paused trial accounts disabled and fails over", async () => {
    const manager = new AccountManager()
    seedAccounts(manager, [
      createAccount("account-1", "token-1"),
      createAccount("account-2", "token-2"),
    ])
    state.accountManager = manager

    mockFetchFn
      .mockResolvedValueOnce(
        new Response(
          "Copilot Pro trials have been temporarily paused. Please upgrade your account or revert to Copilot Free.",
          { status: 403 },
        ),
      )
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
          { sessionId: "sess-1", model: "gpt-5-mini" },
        ),
    )

    expect(response.status).toBe(200)
    expect(mockFetchFn).toHaveBeenCalledTimes(2)

    const internals = toInternals(manager)
    const disabledAccount = internals.accounts.get("account-1")

    expect(disabledAccount?.status).toBe("disabled")
    expect(disabledAccount?.lastError).toContain("paused")
    expect(manager.resolveAccount(undefined, "gpt-5-mini")?.name).toBe(
      "account-2",
    )
  })
})
