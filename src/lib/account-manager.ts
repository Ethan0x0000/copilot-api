import consola from "consola"

import {
  getModels,
  type Model,
  type ModelsResponse,
} from "~/services/copilot/get-models"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

import type { AccountContext } from "./account-context"
import type { AccountConfig } from "./config"
import type { TierRoutingContext } from "./routing"
import type { AccountStatus, AccountUsageSummary } from "./subscription"

import { runWithAccount } from "./account-context"
import { recordAccountRequest } from "./account-state"
import { setApiKeyResetDate } from "./api-key-usage"
import { getRoutingConfig } from "./config"
import { buildRoutingContext, filterAndSortByTier } from "./routing"
import { extractUsageSummary } from "./subscription"
import { fetchCopilotTokenForAccount, startAccountRefreshLoop } from "./token"

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes
const SESSION_PRUNE_INTERVAL_MS = 5 * 60 * 1000 // prune every 5 minutes

interface AccountState {
  name: string
  githubToken: string
  copilotToken: string
  accountType: string
  tier: string
  active: boolean
  priority?: number
  refreshController?: AbortController
  // Runtime status
  status: AccountStatus
  lastError?: string
  usageSummary?: AccountUsageSummary
  cooldownUntil?: number
  cooldownReason?: string
  // Last request tracking
  lastRequestTime?: number
  lastRequestModel?: string
  requestCount: number
  // Available models fetched from Copilot API
  modelCatalogKnown: boolean
  availableModels: Set<string>
  availableModelData: Array<Model>
  unsupportedModels: Set<string>
}

interface SessionEntry {
  accountName: string
  lastSeen: number
}

export interface AccountInfo {
  name: string
  accountType: string
  tier: string
  active: boolean
  activeSessions: number
  status: AccountStatus
  lastError?: string
  usageSummary?: AccountUsageSummary
  lastRequestTime?: number
  lastRequestModel?: string
  modelCatalogKnown: boolean
  availableModelCount: number
  availableModels: Array<string>
}

export class AccountManager {
  private accounts = new Map<string, AccountState>()
  private sessionMap = new Map<string, SessionEntry>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private routingCtx: TierRoutingContext

  constructor() {
    this.routingCtx = buildRoutingContext(getRoutingConfig())
  }

  async initialize(configs: Array<AccountConfig>): Promise<void> {
    const activeConfigs = configs.filter((c) => c.active !== false)

    if (activeConfigs.length === 0) {
      consola.warn("No active accounts configured")
      return
    }

    consola.info(`Initializing ${activeConfigs.length} account(s)...`)

    const results = await Promise.allSettled(
      activeConfigs.map((config) => this.addAccount(config)),
    )

    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        consola.error(
          `Failed to initialize account ${activeConfigs[i].name}:`,
          result.reason,
        )
      }
    }

    const successCount = results.filter((r) => r.status === "fulfilled").length
    consola.info(
      `${successCount}/${activeConfigs.length} account(s) initialized successfully`,
    )

    // Start session pruning
    this.pruneTimer = setInterval(() => {
      this.pruneExpiredSessions()
    }, SESSION_PRUNE_INTERVAL_MS)
  }

  async addAccount(config: AccountConfig): Promise<void> {
    const accountType = config.accountType ?? "individual"
    const tier = config.tier ?? "pro"

    consola.info(`Setting up account: ${config.name} (${tier})`)

    const accountState = await this.buildAccountState(config, accountType, tier)

    this.accounts.set(config.name, accountState)

    if (accountState.status === "ready") {
      const planLabel = accountState.usageSummary?.planDisplay ?? accountType
      consola.success(
        `Account ${config.name} ready (${planLabel}) [${accountState.availableModels.size} models]`,
      )
    } else {
      consola.warn(
        `Account ${config.name} added with status: ${accountState.status}`,
      )
    }
  }

  private async buildAccountState(
    config: AccountConfig,
    accountType: string,
    tier: string,
  ): Promise<AccountState> {
    try {
      const { token, refreshIn } = await fetchCopilotTokenForAccount(
        config.githubToken,
      )

      const accountContext: AccountContext = {
        name: config.name,
        githubToken: config.githubToken,
        copilotToken: token,
        accountType,
      }

      let availableModelData: Array<Model> = []
      let modelCatalogKnown = false
      try {
        const models = await runWithAccount(accountContext, () => getModels())
        availableModelData = models.data.filter(
          (m) => m.model_picker_enabled || m.capabilities.type === "embeddings",
        )
        modelCatalogKnown = true
        consola.debug(
          `Account ${config.name}: ${availableModelData.length} models available`,
        )
      } catch {
        consola.debug(`Could not fetch models for account ${config.name}`)
      }

      let usageSummary: AccountUsageSummary | undefined
      let status: AccountStatus = "ready"
      try {
        const usage = await getCopilotUsage(config.githubToken)
        usageSummary = extractUsageSummary(usage)

        const premium = usage.quota_snapshots?.premium_interactions
        if (premium && !premium.unlimited && premium.remaining <= 0) {
          status = "quota_exhausted"
        }
      } catch {
        consola.debug(`Could not fetch usage info for account ${config.name}`)
      }

      const accountState: AccountState = {
        name: config.name,
        githubToken: config.githubToken,
        copilotToken: token,
        accountType,
        tier,
        active: config.active !== false,
        priority: config.priority,
        status,
        usageSummary,
        requestCount: 0,
        modelCatalogKnown,
        availableModels: new Set(availableModelData.map((m) => m.id)),
        availableModelData,
        unsupportedModels: new Set<string>(),
      }

      if (refreshIn > 0) {
        accountState.refreshController = startAccountRefreshLoop({
          accountName: config.name,
          githubToken: config.githubToken,
          refreshIn,
          onTokenRefreshed: (newToken) => {
            const current = this.accounts.get(config.name)
            if (current) {
              current.copilotToken = newToken
            }
          },
        })
      }

      return accountState
    } catch (error) {
      return {
        name: config.name,
        githubToken: config.githubToken,
        copilotToken: "",
        accountType,
        tier,
        active: false,
        priority: config.priority,
        status: "error",
        lastError:
          error instanceof Error ? error.message : "Failed to get token",
        requestCount: 0,
        modelCatalogKnown: false,
        availableModels: new Set<string>(),
        availableModelData: [],
        unsupportedModels: new Set<string>(),
      }
    }
  }

  removeAccount(name: string): boolean {
    const account = this.accounts.get(name)
    if (!account) return false

    // Stop refresh loop
    account.refreshController?.abort()

    // Remove sessions pointing to this account
    for (const [sessionId, entry] of this.sessionMap.entries()) {
      if (entry.accountName === name) {
        this.sessionMap.delete(sessionId)
      }
    }

    this.accounts.delete(name)
    consola.info(`Account ${name} removed`)
    return true
  }

  /** Filter eligible accounts by model support and tier routing. */
  private filterByModel(
    accounts: Array<AccountState>,
    model: string,
  ): Array<AccountState> {
    const withCatalog = accounts.filter((a) => a.modelCatalogKnown)
    if (withCatalog.length === 0) return []

    const withModel = withCatalog.filter((a) => a.availableModels.has(model))
    if (withModel.length === 0) return []

    const withoutUnsupported = withModel.filter(
      (a) => !a.unsupportedModels.has(model),
    )
    if (withoutUnsupported.length === 0) return []

    return filterAndSortByTier(withoutUnsupported, model, this.routingCtx)
  }

  resolveAccount(
    sessionId?: string,
    model?: string,
    record = true,
  ): AccountContext | undefined {
    let eligibleAccounts = this.getActiveAccounts()
    if (eligibleAccounts.length === 0) return undefined

    if (model) {
      eligibleAccounts = this.filterByModel(eligibleAccounts, model)
      if (eligibleAccounts.length === 0) return undefined
    }

    // Session affinity: reuse the same account if it's still operational
    if (sessionId) {
      const session = this.sessionMap.get(sessionId)
      if (session) {
        const account = this.accounts.get(session.accountName)
        const now = Date.now()
        const isUsable =
          account?.active
          && account.status === "ready"
          && (!account.cooldownUntil || account.cooldownUntil <= now)

        if (isUsable) {
          session.lastSeen = now
          if (record) this.recordRequest(account, model)
          return this.toContext(account)
        }

        // Account is truly down — remove stale session
        this.sessionMap.delete(sessionId)
      }

      // Assign new account from eligible pool
      const selectedAccount = this.selectBestAccount(eligibleAccounts)
      this.sessionMap.set(sessionId, {
        accountName: selectedAccount.name,
        lastSeen: Date.now(),
      })
      if (record) this.recordRequest(selectedAccount, model)
      return this.toContext(selectedAccount)
    }

    // No session ID: use best available (priority-first)
    const selected = this.selectBestAccount(eligibleAccounts)
    if (record) this.recordRequest(selected, model)
    return this.toContext(selected)
  }

  markAccountCooldown(
    accountName: string,
    durationMs: number,
    reason: string,
  ): void {
    const account = this.accounts.get(accountName)
    if (!account) return
    account.cooldownUntil = Date.now() + durationMs
    account.cooldownReason = reason
    consola.warn(
      `Account ${accountName} cooled down for ${Math.round(durationMs / 1000)}s: ${reason}`,
    )
  }

  markModelUnavailable(accountName: string, model: string): void {
    const account = this.accounts.get(accountName)
    if (!account) return
    account.unsupportedModels.add(model)
    consola.warn(`Model ${model} marked unavailable for account ${accountName}`)
  }

  resolveFailoverAccount(
    sessionId: string | undefined,
    model: string | undefined,
    excludeNames: Set<string>,
  ): AccountContext | undefined {
    let eligible = this.getActiveAccounts().filter(
      (a) => !excludeNames.has(a.name),
    )
    if (eligible.length === 0) return undefined

    if (model) {
      const withCatalog = eligible.filter((a) => a.modelCatalogKnown)
      if (withCatalog.length === 0) return undefined
      const withModel = withCatalog.filter(
        (a) => a.availableModels.has(model) && !a.unsupportedModels.has(model),
      )
      if (withModel.length === 0) return undefined
      eligible = filterAndSortByTier(withModel, model, this.routingCtx)
      if (eligible.length === 0) return undefined
    }

    const selected = this.selectBestAccount(eligible)

    if (sessionId) {
      this.sessionMap.set(sessionId, {
        accountName: selected.name,
        lastSeen: Date.now(),
      })
    }

    this.recordRequest(selected, model)
    return this.toContext(selected)
  }

  hasAccounts(): boolean {
    return this.accounts.size > 0
  }

  /** Get the union of all models across all active accounts. */
  getAllAvailableModels(): Set<string> {
    const allModels = new Set<string>()
    for (const account of this.accounts.values()) {
      if (account.active && account.status === "ready") {
        for (const model of account.availableModels) {
          allModels.add(model)
        }
      }
    }
    return allModels
  }

  /** Get full model metadata union across all active accounts. */
  getAllAvailableModelData(): ModelsResponse | undefined {
    const modelMap = new Map<string, Model>()

    for (const account of this.accounts.values()) {
      if (!account.active || account.status !== "ready") {
        continue
      }

      for (const model of account.availableModelData) {
        if (!modelMap.has(model.id)) {
          modelMap.set(model.id, model)
        }
      }
    }

    if (modelMap.size === 0) {
      return undefined
    }

    const data = [...modelMap.values()].sort((a, b) => a.id.localeCompare(b.id))

    return {
      object: "list",
      data,
    }
  }

  listAccounts(): Array<AccountInfo> {
    const result: Array<AccountInfo> = []

    for (const account of this.accounts.values()) {
      let activeSessions = 0
      for (const entry of this.sessionMap.values()) {
        if (entry.accountName === account.name) activeSessions++
      }

      result.push({
        name: account.name,
        accountType: account.accountType,
        tier: account.tier,
        active: account.active,
        activeSessions,
        status: account.status,
        lastError: account.lastError,
        usageSummary: account.usageSummary,
        lastRequestTime: account.lastRequestTime,
        lastRequestModel: account.lastRequestModel,
        modelCatalogKnown: account.modelCatalogKnown,
        availableModelCount: account.availableModels.size,
        availableModels: [...account.availableModels].sort(),
      })
    }

    return result
  }

  /** Refresh usage/quota info for all accounts. */
  async refreshUsage(): Promise<void> {
    const tasks = [...this.accounts.entries()].map(async ([name, account]) => {
      try {
        const usage = await getCopilotUsage(account.githubToken)
        // eslint-disable-next-line require-atomic-updates
        account.usageSummary = extractUsageSummary(usage)

        const premium = usage.quota_snapshots?.premium_interactions
        if (premium) {
          if (
            !premium.unlimited
            && premium.remaining <= 0
            && account.status === "ready"
          ) {
            account.status = "quota_exhausted"
          } else if (
            account.status === "quota_exhausted"
            && premium.remaining > 0
          ) {
            account.status = "ready"
          }
        }
      } catch (error) {
        consola.debug(`Failed to refresh usage for ${name}:`, error)
      }
    })

    await Promise.allSettled(tasks)

    // Sync Copilot quota reset date for API key usage tracking.
    // Use the first account that has a known reset date.
    for (const account of this.accounts.values()) {
      if (account.usageSummary?.resetDate) {
        setApiKeyResetDate(account.usageSummary.resetDate)
        break
      }
    }
  }

  shutdown(): void {
    for (const account of this.accounts.values()) {
      account.refreshController?.abort()
    }
    this.accounts.clear()
    this.sessionMap.clear()

    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
  }

  private getActiveAccounts(): Array<AccountState> {
    const now = Date.now()
    return [...this.accounts.values()].filter(
      (a) =>
        a.active
        && a.status === "ready"
        && (!a.cooldownUntil || a.cooldownUntil <= now),
    )
  }

  /**
   * Select the best available account from candidates.
   * Strategy: priority-first (lower number = higher priority).
   * Among equal priorities, prefer the account with fewer requests.
   */
  private selectBestAccount(candidates: Array<AccountState>): AccountState {
    const getRemainingScore = (acct: AccountState): number => {
      if (acct.usageSummary?.premium?.unlimited) return Infinity
      return acct.usageSummary?.premium?.remaining ?? -Infinity
    }

    const sorted = [...candidates].sort((a, b) => {
      const ra = getRemainingScore(a)
      const rb = getRemainingScore(b)
      if (ra !== rb) return rb - ra

      const pa = a.priority ?? 100
      const pb = b.priority ?? 100
      if (pa !== pb) return pa - pb

      return a.requestCount - b.requestCount
    })

    return sorted[0]
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    let pruned = 0

    for (const [sessionId, entry] of this.sessionMap.entries()) {
      if (now - entry.lastSeen > SESSION_TTL_MS) {
        this.sessionMap.delete(sessionId)
        pruned++
      }
    }

    if (pruned > 0) {
      consola.debug(`Pruned ${pruned} expired session(s)`)
    }
  }

  private recordRequest(account: AccountState, model?: string): void {
    account.requestCount++
    account.lastRequestTime = Date.now()
    if (model) {
      account.lastRequestModel = model
    }
    recordAccountRequest(account.name, model)
  }

  private toContext(account: AccountState): AccountContext {
    return {
      name: account.name,
      copilotToken: account.copilotToken,
      githubToken: account.githubToken,
      accountType: account.accountType,
    }
  }
}
