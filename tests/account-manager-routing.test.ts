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

describe("AccountManager.resolveAccount model routing", () => {
  test("fails closed when all catalogs are unknown for model-bound request", () => {
    const manager = new AccountManager()

    seedAccounts(manager, [
      createAccount({
        name: "student-1",
        tier: "student",
        modelCatalogKnown: false,
        models: [],
      }),
      createAccount({
        name: "pro-1",
        tier: "pro",
        modelCatalogKnown: false,
        models: [],
      }),
    ])

    const selected = manager.resolveAccount("session-1", "gpt-5.4")
    expect(selected).toBeUndefined()
  })

  test("prefers lower tier among known accounts that support the model", () => {
    const manager = new AccountManager()

    seedAccounts(manager, [
      createAccount({
        name: "student-1",
        tier: "student",
        modelCatalogKnown: true,
        models: ["gpt-4.1", "gpt-5-mini"],
      }),
      createAccount({
        name: "pro-1",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-4.1", "gpt-5-mini", "gpt-5.4"],
      }),
    ])

    const selected = manager.resolveAccount(undefined, "gpt-5-mini")
    expect(selected?.name).toBe("student-1")
  })

  test("does not route to student when only pro supports the target model", () => {
    const manager = new AccountManager()

    seedAccounts(manager, [
      createAccount({
        name: "student-1",
        tier: "student",
        modelCatalogKnown: true,
        models: ["gpt-5-mini"],
      }),
      createAccount({
        name: "pro-1",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
    ])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("pro-1")
  })

  test("honors model minimum tier requirements after model availability filter", () => {
    const manager = new AccountManager()
    const internals = toInternals(manager)

    internals.routingCtx = {
      tierPriority: ["free", "student", "pro", "pro_plus"],
      modelTierRequirements: {
        "gpt-5.4": "pro",
      },
    }

    seedAccounts(manager, [
      createAccount({
        name: "student-1",
        tier: "student",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      createAccount({
        name: "pro-1",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
    ])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("pro-1")
  })

  test("remaps sticky sessions when the bound account does not support the routed model", () => {
    const manager = new AccountManager()

    seedAccounts(manager, [
      createAccount({
        name: "claude-only",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["claude-opus-4.6"],
      }),
      createAccount({
        name: "small-model",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5-mini"],
      }),
    ])

    const initial = manager.resolveAccount("sticky-session", "claude-opus-4.6")
    expect(initial?.name).toBe("claude-only")

    const remapped = manager.resolveAccount("sticky-session", "gpt-5-mini")
    expect(remapped?.name).toBe("small-model")
  })
})

describe("AccountManager.selectBestAccount usage-count balancing", () => {
  test("selects account with fewer requests among equal priority", () => {
    const manager = new AccountManager()

    const account1 = createAccount({
      name: "acct-1",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5-mini"],
    })
    ;(account1 as TestAccountState & { requestCount: number }).requestCount = 10

    const account2 = createAccount({
      name: "acct-2",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5-mini"],
    })
    ;(account2 as TestAccountState & { requestCount: number }).requestCount = 3

    seedAccounts(manager, [account1, account2])

    const selected = manager.resolveAccount(undefined, "gpt-5-mini")
    expect(selected?.name).toBe("acct-2")
  })

  test("priority takes precedence over request count", () => {
    const manager = new AccountManager()

    const account1 = createAccount({
      name: "high-priority",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5-mini"],
    })
    ;(account1 as unknown as { priority: number }).priority = 1
    ;(account1 as TestAccountState & { requestCount: number }).requestCount =
      100

    const account2 = createAccount({
      name: "low-priority",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5-mini"],
    })
    ;(account2 as unknown as { priority: number }).priority = 50
    ;(account2 as TestAccountState & { requestCount: number }).requestCount = 0

    seedAccounts(manager, [account1, account2])

    const selected = manager.resolveAccount(undefined, "gpt-5-mini")
    expect(selected?.name).toBe("high-priority")
  })

  test("recordRequest increments requestCount", () => {
    const manager = new AccountManager()

    const account = createAccount({
      name: "acct-1",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5-mini"],
    })
    seedAccounts(manager, [account])

    manager.resolveAccount(undefined, "gpt-5-mini")
    manager.resolveAccount(undefined, "gpt-5-mini")
    manager.resolveAccount(undefined, "gpt-5-mini")

    const internals = toInternals(manager)
    const updatedAccount = internals.accounts.get("acct-1")
    expect(
      (updatedAccount as unknown as { requestCount: number }).requestCount,
    ).toBe(3)
  })

  test("session affinity is preserved despite request-count difference", () => {
    const manager = new AccountManager()

    const account1 = createAccount({
      name: "acct-1",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5-mini"],
    })
    ;(account1 as TestAccountState & { requestCount: number }).requestCount = 50

    const account2 = createAccount({
      name: "acct-2",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5-mini"],
    })
    ;(account2 as TestAccountState & { requestCount: number }).requestCount = 0

    seedAccounts(manager, [account1, account2])

    // First call with session creates affinity
    const first = manager.resolveAccount("sticky-session", "gpt-5-mini")
    const assignedAccount = first?.name

    // Subsequent calls with same session must stick to the same account
    const second = manager.resolveAccount("sticky-session", "gpt-5-mini")
    const third = manager.resolveAccount("sticky-session", "gpt-5-mini")

    expect(second?.name).toBe(assignedAccount)
    expect(third?.name).toBe(assignedAccount)
  })
})
