import { describe, expect, test } from "bun:test"

import { AccountManager } from "~/lib/account-manager"

interface TestAccountState {
  name: string
  githubToken: string
  copilotToken: string
  accountType: string
  tier: string
  active: boolean
  status: "ready" | "error" | "rate_limited" | "disabled" | "quota_exhausted"
  requestCount: number
  modelCatalogKnown: boolean
  availableModels: Set<string>
  availableModelData: Array<unknown>
  unsupportedModels: Set<string>
  usageSummary?: {
    premium?: {
      remaining: number
      entitlement: number
      unlimited: boolean
    }
    plan?: string
    planDisplay?: string
    resetDate?: string
  }
  priority?: number
}

interface AccountManagerInternals {
  accounts: Map<string, TestAccountState>
  routingCtx: {
    tierPriority: Array<string>
    modelTierRequirements: Record<string, string>
  }
}

const toInternals = (manager: AccountManager): AccountManagerInternals =>
  manager as unknown as AccountManagerInternals

const createAccount = (options: {
  name: string
  tier: string
  modelCatalogKnown: boolean
  models: Array<string>
}): TestAccountState => ({
  name: options.name,
  githubToken: `${options.name}-gh`,
  copilotToken: `${options.name}-cp`,
  accountType: "individual",
  tier: options.tier,
  active: true,
  status: "ready",
  requestCount: 0,
  modelCatalogKnown: options.modelCatalogKnown,
  availableModels: new Set(options.models),
  availableModelData: [],
  unsupportedModels: new Set<string>(),
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

const withQuota = (
  account: TestAccountState,
  options: { remaining: number; entitlement: number; unlimited: boolean },
): TestAccountState => {
  ;(
    account as unknown as { usageSummary: TestAccountState["usageSummary"] }
  ).usageSummary = {
    premium: {
      remaining: options.remaining,
      entitlement: options.entitlement,
      unlimited: options.unlimited,
    },
    plan: "pro",
    planDisplay: "Pro",
    resetDate: "2026-05-02",
  }
  return account
}

const withPriority = (
  account: TestAccountState,
  priority: number,
): TestAccountState => {
  ;(account as unknown as { priority: number }).priority = priority
  return account
}

describe("AccountManager.selectBestAccount quota-aware selection", () => {
  test("selects account with highest quota remaining among same-tier", () => {
    const manager = new AccountManager()

    const account1 = withQuota(
      createAccount({
        name: "pro-1",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 50, entitlement: 300, unlimited: false },
    )

    const account2 = withQuota(
      createAccount({
        name: "pro-2",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 200, entitlement: 300, unlimited: false },
    )

    const account3 = withQuota(
      createAccount({
        name: "pro-3",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 100, entitlement: 300, unlimited: false },
    )

    seedAccounts(manager, [account1, account2, account3])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("pro-2")
  })

  test("deprioritizes accounts without usageSummary (no quota data)", () => {
    const manager = new AccountManager()

    const account1 = withQuota(
      createAccount({
        name: "pro-with-quota",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 100, entitlement: 300, unlimited: false },
    )

    const account2 = createAccount({
      name: "pro-no-quota",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5.4"],
    })

    seedAccounts(manager, [account1, account2])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("pro-with-quota")
  })

  test("falls back to priority then requestCount when all quotas are equal", () => {
    const manager = new AccountManager()

    const account1 = withPriority(
      withQuota(
        createAccount({
          name: "acct-a",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 100, entitlement: 300, unlimited: false },
      ),
      1,
    )

    const account2 = withPriority(
      withQuota(
        createAccount({
          name: "acct-b",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 100, entitlement: 300, unlimited: false },
      ),
      2,
    )

    seedAccounts(manager, [account1, account2])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("acct-a")
  })

  test("handles unlimited=true as highest priority", () => {
    const manager = new AccountManager()

    const account1 = withQuota(
      createAccount({
        name: "pro-unlimited",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 9999, entitlement: 9999, unlimited: true },
    )

    const account2 = withQuota(
      createAccount({
        name: "pro-limited",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 9999, entitlement: 10000, unlimited: false },
    )

    seedAccounts(manager, [account1, account2])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("pro-unlimited")
  })

  test("preserves cross-tier isolation (pro model only selects pro accounts)", () => {
    const manager = new AccountManager()
    const internals = toInternals(manager)

    internals.routingCtx = {
      tierPriority: ["free", "student", "pro", "pro_plus"],
      modelTierRequirements: { "gpt-5.4": "pro" },
    }

    const studentAccount = withQuota(
      createAccount({
        name: "student-1",
        tier: "student",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 500, entitlement: 500, unlimited: false },
    )

    const pro1 = withQuota(
      createAccount({
        name: "pro-1",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 100, entitlement: 300, unlimited: false },
    )

    const pro2 = withQuota(
      createAccount({
        name: "pro-2",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 200, entitlement: 300, unlimited: false },
    )

    seedAccounts(manager, [studentAccount, pro1, pro2])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("pro-2")
  })
})
