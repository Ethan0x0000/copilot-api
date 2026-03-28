import consola from "consola"

import { getCopilotUsage } from "~/services/github/get-copilot-usage"

import type { AccountContext } from "./account-context"
import type { AccountConfig } from "./config"
import type { AccountStatus, AccountUsageSummary } from "./subscription"

import { extractUsageSummary } from "./subscription"
import { fetchCopilotTokenForAccount, startAccountRefreshLoop } from "./token"

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes
const SESSION_PRUNE_INTERVAL_MS = 5 * 60 * 1000 // prune every 5 minutes

interface AccountState {
  name: string
  githubToken: string
  copilotToken: string
  accountType: string
  active: boolean
  refreshController?: AbortController
  // Runtime status
  status: AccountStatus
  lastError?: string
  usageSummary?: AccountUsageSummary
}

interface SessionEntry {
  accountName: string
  lastSeen: number
}

export interface AccountInfo {
  name: string
  accountType: string
  active: boolean
  activeSessions: number
  status: AccountStatus
  lastError?: string
  usageSummary?: AccountUsageSummary
}

export class AccountManager {
  private accounts = new Map<string, AccountState>()
  private sessionMap = new Map<string, SessionEntry>()
  private roundRobinIndex = 0
  private pruneTimer: ReturnType<typeof setInterval> | null = null

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

    consola.info(`Setting up account: ${config.name} (${accountType})`)

    let accountState: AccountState

    try {
      const { token, refreshIn } = await fetchCopilotTokenForAccount(
        config.githubToken,
      )

      accountState = {
        name: config.name,
        githubToken: config.githubToken,
        copilotToken: token,
        accountType,
        active: config.active !== false,
        status: "ready",
      }

      // Start refresh loop
      if (refreshIn > 0) {
        accountState.refreshController = startAccountRefreshLoop({
          accountName: config.name,
          githubToken: config.githubToken,
          refreshIn,
          onTokenRefreshed: (newToken) => {
            accountState.copilotToken = newToken
          },
        })
      }

      // Fetch usage/plan info (best-effort, don't fail if this errors)
      try {
        const usage = await getCopilotUsage(config.githubToken)
        accountState.usageSummary = extractUsageSummary(usage)

        // Check if quota is exhausted
        const premium = usage.quota_snapshots.premium_interactions
        if (!premium.unlimited && premium.remaining <= 0) {
          accountState.status = "quota_exhausted"
        }
      } catch {
        consola.debug(`Could not fetch usage info for account ${config.name}`)
      }
    } catch (error) {
      // Token fetch failed — still add the account but mark as error
      accountState = {
        name: config.name,
        githubToken: config.githubToken,
        copilotToken: "",
        accountType,
        active: false,
        status: "error",
        lastError:
          error instanceof Error ? error.message : "Failed to get token",
      }
    }

    this.accounts.set(config.name, accountState)

    if (accountState.status === "ready") {
      const planLabel = accountState.usageSummary?.planDisplay ?? accountType
      consola.success(`Account ${config.name} ready (${planLabel})`)
    } else {
      consola.warn(
        `Account ${config.name} added with status: ${accountState.status}`,
      )
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

  resolveAccount(sessionId?: string): AccountContext | undefined {
    const activeAccounts = this.getActiveAccounts()
    if (activeAccounts.length === 0) return undefined

    // Session affinity: if we have a session ID, try to reuse the same account
    if (sessionId) {
      const session = this.sessionMap.get(sessionId)
      if (session) {
        const account = this.accounts.get(session.accountName)
        if (account?.active && account.status === "ready") {
          session.lastSeen = Date.now()
          return this.toContext(account)
        }
        // Account no longer usable, remove stale session
        this.sessionMap.delete(sessionId)
      }

      // Assign a new account for this session
      const selectedAccount = this.selectNextAccount(activeAccounts)
      this.sessionMap.set(sessionId, {
        accountName: selectedAccount.name,
        lastSeen: Date.now(),
      })
      return this.toContext(selectedAccount)
    }

    // No session ID: round-robin
    return this.toContext(this.selectNextAccount(activeAccounts))
  }

  hasAccounts(): boolean {
    return this.accounts.size > 0
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
        active: account.active,
        activeSessions,
        status: account.status,
        lastError: account.lastError,
        usageSummary: account.usageSummary,
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

        const premium = usage.quota_snapshots.premium_interactions
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
      } catch (error) {
        consola.debug(`Failed to refresh usage for ${name}:`, error)
      }
    })

    await Promise.allSettled(tasks)
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
    return [...this.accounts.values()].filter(
      (a) => a.active && a.status === "ready",
    )
  }

  private selectNextAccount(activeAccounts: Array<AccountState>): AccountState {
    const index = this.roundRobinIndex % activeAccounts.length
    this.roundRobinIndex = (this.roundRobinIndex + 1) % activeAccounts.length
    return activeAccounts[index]
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

  private toContext(account: AccountState): AccountContext {
    return {
      name: account.name,
      copilotToken: account.copilotToken,
      githubToken: account.githubToken,
      accountType: account.accountType,
    }
  }
}
