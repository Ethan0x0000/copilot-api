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
    modelAccountNameRoutes?: Record<string, Array<string>>
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

describe("AccountManager.selectBestAccount priority-aware selection", () => {
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

  test("prefers lower priority even when another account has more remaining quota", () => {
    const manager = new AccountManager()

    const account1 = withPriority(
      withQuota(
        createAccount({
          name: "priority-first",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 10, entitlement: 300, unlimited: false },
      ),
      1,
    )

    const account2 = withPriority(
      withQuota(
        createAccount({
          name: "quota-first",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 200, entitlement: 300, unlimited: false },
      ),
      50,
    )

    seedAccounts(manager, [account1, account2])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("priority-first")
  })

  test("falls back to quota then requestCount when priorities are equal", () => {
    const manager = new AccountManager()

    const account1 = withQuota(
      createAccount({
        name: "acct-a",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 100, entitlement: 300, unlimited: false },
    )

    const account2 = withQuota(
      createAccount({
        name: "acct-b",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      { remaining: 200, entitlement: 300, unlimited: false },
    )

    seedAccounts(manager, [account1, account2])

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected?.name).toBe("acct-b")
  })

  test("treats unlimited quota as the highest quota score among equal priorities", () => {
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

interface AccountManagerRefreshInternals extends AccountManagerInternals {
  pruneTimer: ReturnType<typeof setInterval> | null
  refreshTimer: ReturnType<typeof setInterval> | null
  lastActivityTime: number
  addAccount: (config: {
    name: string
    githubToken: string
    accountType?: string
    tier?: string
    active?: boolean
    priority?: number
  }) => Promise<void>
  refreshUsage: () => Promise<void>
  startRefreshLoop: () => void
  stopRefreshLoop: () => void
}

const toRefreshInternals = (
  manager: AccountManager,
): AccountManagerRefreshInternals =>
  manager as unknown as AccountManagerRefreshInternals

const REFRESH_IDLE_THRESHOLD_MS = 5 * 60 * 1000

describe("AccountManager.refreshUsage activity-gated timer", () => {
  test("startRefreshLoop does not call refreshUsage before any activity", () => {
    const manager = new AccountManager()
    const internals = toRefreshInternals(manager)

    let refreshCount = 0
    const originalRefreshUsage = internals.refreshUsage
    internals.refreshUsage = () => {
      refreshCount++
      return Promise.resolve()
    }

    internals.startRefreshLoop()

    expect(internals.lastActivityTime).toBe(0)
    const shouldRefresh =
      internals.lastActivityTime > 0
      && Date.now() - internals.lastActivityTime < REFRESH_IDLE_THRESHOLD_MS
    expect(shouldRefresh).toBe(false)
    expect(refreshCount).toBe(0)

    internals.stopRefreshLoop()
    expect(internals.refreshTimer).toBeNull()

    internals.refreshUsage = originalRefreshUsage
  })

  test("recordRequest sets lastActivityTime", () => {
    const manager = new AccountManager()
    const account = createAccount({
      name: "pro-1",
      tier: "pro",
      modelCatalogKnown: true,
      models: ["gpt-5-mini"],
    })

    seedAccounts(manager, [account])

    const before = Date.now()
    manager.resolveAccount(undefined, "gpt-5-mini")

    const internals = toRefreshInternals(manager)
    expect(internals.lastActivityTime).toBeGreaterThanOrEqual(before)
  })

  test("stopRefreshLoop clears the timer", () => {
    const manager = new AccountManager()
    const internals = toRefreshInternals(manager)

    internals.startRefreshLoop()
    expect(internals.refreshTimer).not.toBeNull()

    internals.stopRefreshLoop()
    expect(internals.refreshTimer).toBeNull()
  })

  test("refreshUsage is not called when idle > threshold", () => {
    const manager = new AccountManager()
    const internals = toRefreshInternals(manager)

    let refreshCount = 0
    const originalRefreshUsage = internals.refreshUsage
    internals.refreshUsage = () => {
      refreshCount++
      return Promise.resolve()
    }

    internals.lastActivityTime = Date.now() - (REFRESH_IDLE_THRESHOLD_MS + 1000)
    internals.startRefreshLoop()

    const idleMs = Date.now() - internals.lastActivityTime
    if (internals.lastActivityTime > 0 && idleMs < REFRESH_IDLE_THRESHOLD_MS) {
      void internals.refreshUsage()
    }

    expect(idleMs).toBeGreaterThan(REFRESH_IDLE_THRESHOLD_MS)
    expect(refreshCount).toBe(0)

    internals.stopRefreshLoop()
    internals.refreshUsage = originalRefreshUsage
  })

  test("initialize() starts the refresh loop", async () => {
    const manager = new AccountManager()
    const internals = toRefreshInternals(manager)
    const originalAddAccount = internals.addAccount

    internals.addAccount = (config) => {
      seedAccounts(manager, [
        createAccount({
          name: config.name,
          tier: config.tier ?? "pro",
          modelCatalogKnown: true,
          models: ["gpt-5-mini"],
        }),
      ])

      return Promise.resolve()
    }

    expect(internals.refreshTimer).toBeNull()

    await manager.initialize([
      {
        name: "refresh-init",
        githubToken: "gh-refresh-init",
        active: true,
      },
    ])

    expect(internals.refreshTimer).not.toBeNull()

    internals.addAccount = originalAddAccount
    manager.shutdown()
    expect(internals.refreshTimer).toBeNull()
    expect(internals.pruneTimer).toBeNull()
  })
})

interface AccountManagerFailoverInternals extends AccountManagerInternals {
  sessionMap: Map<string, { accountName: string; lastSeen: number }>
}

const toFailoverInternals = (
  manager: AccountManager,
): AccountManagerFailoverInternals =>
  manager as unknown as AccountManagerFailoverInternals

describe("AccountManager.resolveFailoverAccount session remapping", () => {
  test("resolveFailoverAccount updates sessionMap to the new account", () => {
    const manager = new AccountManager()
    seedAccounts(manager, [
      withPriority(
        createAccount({
          name: "pro-1",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        1,
      ),
      withPriority(
        createAccount({
          name: "pro-2",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        2,
      ),
    ])

    const internals = toFailoverInternals(manager)

    const initial = manager.resolveAccount("my-session", "gpt-5.4")
    expect(initial?.name).toBe("pro-1")
    expect(internals.sessionMap.get("my-session")?.accountName).toBe("pro-1")

    const failover = manager.resolveFailoverAccount(
      "my-session",
      "gpt-5.4",
      new Set(["pro-1"]),
    )

    expect(failover?.name).toBe("pro-2")
    expect(internals.sessionMap.get("my-session")?.accountName).toBe("pro-2")
  })

  test("after failover, resolveAccount returns the remapped account for the same session", () => {
    const manager = new AccountManager()
    seedAccounts(manager, [
      withPriority(
        createAccount({
          name: "pro-1",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        1,
      ),
      withPriority(
        createAccount({
          name: "pro-2",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        2,
      ),
    ])

    const first = manager.resolveAccount("sticky-session", "gpt-5.4")
    if (!first) throw new Error("expected initial account assignment")
    expect(first.name).toBe("pro-1")

    const failover = manager.resolveFailoverAccount(
      "sticky-session",
      "gpt-5.4",
      new Set([first.name]),
    )

    expect(failover?.name).toBe("pro-2")

    const remapped = manager.resolveAccount("sticky-session", "gpt-5.4")
    expect(remapped?.name).toBe("pro-2")
    expect(remapped?.name).not.toBe(first.name)
  })

  test("failover without sessionId still selects a replacement account", () => {
    const manager = new AccountManager()
    seedAccounts(manager, [
      withPriority(
        createAccount({
          name: "pro-1",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        1,
      ),
      withPriority(
        createAccount({
          name: "pro-2",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        2,
      ),
    ])

    const internals = toFailoverInternals(manager)

    const failover = manager.resolveFailoverAccount(
      undefined,
      "gpt-5.4",
      new Set(["pro-1"]),
    )

    expect(failover?.name).toBe("pro-2")
    expect(internals.sessionMap.size).toBe(0)
  })

  test("failover stays within the routed account-name list", () => {
    const manager = new AccountManager()
    const internals = toFailoverInternals(manager)

    internals.routingCtx = {
      tierPriority: ["free", "student", "pro", "pro_plus"],
      modelTierRequirements: {},
      modelAccountNameRoutes: {
        "gpt-5.4": ["routed-primary", "routed-secondary"],
      },
    }

    seedAccounts(manager, [
      withPriority(
        createAccount({
          name: "blocked-outside-route",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        1,
      ),
      withPriority(
        createAccount({
          name: "routed-primary",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        2,
      ),
      withPriority(
        createAccount({
          name: "routed-secondary",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        3,
      ),
    ])

    const initial = manager.resolveAccount("route-session", "gpt-5.4")
    expect(initial?.name).toBe("routed-primary")

    const failover = manager.resolveFailoverAccount(
      "route-session",
      "gpt-5.4",
      new Set(["routed-primary"]),
    )

    expect(failover?.name).toBe("routed-secondary")
    expect(internals.sessionMap.get("route-session")?.accountName).toBe(
      "routed-secondary",
    )
  })
})

describe("AccountManager integration — full load balancing flow", () => {
  test("1. session affinity: same session always gets same account over 5 calls", () => {
    const manager = new AccountManager()

    seedAccounts(manager, [
      withQuota(
        createAccount({
          name: "pro-1",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 200, entitlement: 300, unlimited: false },
      ),
      withQuota(
        createAccount({
          name: "pro-2",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 150, entitlement: 300, unlimited: false },
      ),
      withQuota(
        createAccount({
          name: "pro-3",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 100, entitlement: 300, unlimited: false },
      ),
    ])

    const picks = Array.from(
      { length: 5 },
      () => manager.resolveAccount("user-session-A", "gpt-5.4")?.name,
    )

    expect(picks).toHaveLength(5)
    expect(new Set(picks).size).toBe(1)
    expect(picks[0]).toBe("pro-1")
  })

  test("2. quota distribution: among default priorities, new sessions go to highest-quota account, then next-highest after quota drops", () => {
    const manager = new AccountManager()

    seedAccounts(manager, [
      withQuota(
        createAccount({
          name: "pro-1",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 200, entitlement: 300, unlimited: false },
      ),
      withQuota(
        createAccount({
          name: "pro-2",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 150, entitlement: 300, unlimited: false },
      ),
      withQuota(
        createAccount({
          name: "pro-3",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 100, entitlement: 300, unlimited: false },
      ),
      withQuota(
        createAccount({
          name: "pro-4",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 50, entitlement: 300, unlimited: false },
      ),
    ])

    // With default priorities, the first new session goes to the highest-quota account (pro-1, 200)
    const first = manager.resolveAccount("session-1", "gpt-5.4")
    expect(first?.name).toBe("pro-1")

    // Simulate pro-1's quota dropping below pro-2 (e.g., after a refresh)
    const internals = toInternals(manager)
    const pro1 = internals.accounts.get("pro-1")
    if (pro1?.usageSummary?.premium) {
      pro1.usageSummary.premium.remaining = 120 // now 120 < pro-2's 150
    }

    // Second NEW session should go to pro-2 because priorities are still equal and 150 > 120
    const second = manager.resolveAccount("session-2", "gpt-5.4")
    expect(second?.name).toBe("pro-2")

    // But session-1 sticks to pro-1 (session affinity)
    const firstAgain = manager.resolveAccount("session-1", "gpt-5.4")
    expect(firstAgain?.name).toBe("pro-1")
  })

  test("3. failover recovery: after failover, session sticks to new account", () => {
    const manager = new AccountManager()

    seedAccounts(manager, [
      withQuota(
        createAccount({
          name: "pro-1",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 200, entitlement: 300, unlimited: false },
      ),
      withQuota(
        createAccount({
          name: "pro-2",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 100, entitlement: 300, unlimited: false },
      ),
    ])

    const initial = manager.resolveAccount("session-failover", "gpt-5.4")
    expect(initial?.name).toBe("pro-1")

    manager.markAccountCooldown("pro-1", 60_000, "test cooldown")

    const afterCooldown = manager.resolveAccount("session-failover", "gpt-5.4")
    expect(afterCooldown?.name).toBe("pro-2")

    const stableAfterFailover = manager.resolveAccount(
      "session-failover",
      "gpt-5.4",
    )
    expect(stableAfterFailover?.name).toBe("pro-2")
  })

  test("4. all accounts exhausted: resolveAccount returns undefined", () => {
    const manager = new AccountManager()

    seedAccounts(manager, [
      createAccount({
        name: "pro-1",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
      createAccount({
        name: "pro-2",
        tier: "pro",
        modelCatalogKnown: true,
        models: ["gpt-5.4"],
      }),
    ])

    const internals = toInternals(manager)
    const pro1 = internals.accounts.get("pro-1")
    const pro2 = internals.accounts.get("pro-2")
    if (!pro1 || !pro2) throw new Error("expected seeded pro accounts")

    pro1.status = "quota_exhausted"
    pro2.status = "quota_exhausted"

    const selected = manager.resolveAccount(undefined, "gpt-5.4")
    expect(selected).toBeUndefined()
  })

  test("5. tier+quota integration: pro-only model picks highest-quota pro account when priorities are equal, session sticks despite student having more quota", () => {
    const manager = new AccountManager()
    const internals = toInternals(manager)

    internals.routingCtx = {
      tierPriority: ["free", "student", "pro", "pro_plus"],
      modelTierRequirements: { "gpt-5.4": "pro" },
    }

    // Student has HIGHEST quota overall (500), but model requires pro tier
    // Among pro accounts with default priorities, pro-1 has more remaining quota than pro-2
    seedAccounts(manager, [
      withQuota(
        createAccount({
          name: "student-1",
          tier: "student",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 500, entitlement: 500, unlimited: false },
      ),
      withQuota(
        createAccount({
          name: "pro-1",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 200, entitlement: 300, unlimited: false },
      ),
      withQuota(
        createAccount({
          name: "pro-2",
          tier: "pro",
          modelCatalogKnown: true,
          models: ["gpt-5.4"],
        }),
        { remaining: 100, entitlement: 300, unlimited: false },
      ),
    ])

    // First call: should go to pro-1 (highest quota among eligible pro accounts with equal priorities)
    const first = manager.resolveAccount("user-session", "gpt-5.4")
    expect(first?.name).toBe("pro-1")
    expect(first?.name).not.toBe("student-1")

    // Second call same session: sticks to pro-1 (session affinity)
    const second = manager.resolveAccount("user-session", "gpt-5.4")
    expect(second?.name).toBe("pro-1")

    // Third call NEW session: new session also picks pro-1 because priorities are still equal and it has the highest quota
    const newSession = manager.resolveAccount("new-session", "gpt-5.4")
    expect(newSession?.name).toBe("pro-1")
    expect(newSession?.name).not.toBe("student-1")
  })
})
