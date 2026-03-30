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
})
