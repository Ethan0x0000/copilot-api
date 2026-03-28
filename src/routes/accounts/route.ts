import { Hono } from "hono"

import { state } from "~/lib/state"
import { extractUsageSummary, getPlanDisplayName } from "~/lib/subscription"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const accountsRoute = new Hono()

/**
 * GET /accounts
 * Returns the list of all configured accounts with basic info.
 * In single-account mode, returns the single account derived from global state.
 */
accountsRoute.get("/", async (c) => {
  try {
    const accountManager = state.accountManager
    if (accountManager?.hasAccounts()) {
      const accounts = accountManager.listAccounts()
      return c.json({
        mode: "multi",
        accounts: accounts.map((a) => ({
          name: a.name,
          accountType: a.accountType,
          tier: a.tier,
          active: a.active,
          status: a.status,
          plan: a.usageSummary?.planDisplay ?? null,
          activeSessions: a.activeSessions,
          modelCatalogKnown: a.modelCatalogKnown,
          availableModelCount: a.availableModelCount,
          availableModels: a.availableModels,
          lastError: a.lastError ?? null,
        })),
      })
    }

    // Single-account mode
    const account = await buildSingleAccountInfo()
    return c.json({
      mode: "single",
      accounts: [account],
    })
  } catch (error) {
    console.error("Error listing accounts:", error)
    return c.json({ error: "Failed to list accounts" }, 500)
  }
})

/**
 * GET /accounts/status
 * Returns detailed status for all accounts including live quota data.
 * In multi-account mode, refreshes usage data before responding.
 */
accountsRoute.get("/status", async (c) => {
  try {
    const accountManager = state.accountManager
    if (accountManager?.hasAccounts()) {
      // Refresh usage data from GitHub
      await accountManager.refreshUsage()
      const accounts = accountManager.listAccounts()

      return c.json({
        mode: "multi",
        accounts: accounts.map((a) => ({
          name: a.name,
          accountType: a.accountType,
          tier: a.tier,
          active: a.active,
          status: a.status,
          lastError: a.lastError ?? null,
          activeSessions: a.activeSessions,
          modelCatalogKnown: a.modelCatalogKnown,
          availableModelCount: a.availableModelCount,
          availableModels: a.availableModels,
          plan:
            a.usageSummary ?
              {
                name: a.usageSummary.planDisplay,
                raw: a.usageSummary.plan,
              }
            : null,
          quota:
            a.usageSummary ?
              {
                premium: formatQuota(a.usageSummary.premium),
                chat: formatQuota(a.usageSummary.chat),
                completions: formatQuota(a.usageSummary.completions),
              }
            : null,
          quotaResetDate: a.usageSummary?.resetDate ?? null,
        })),
      })
    }

    // Single-account mode: fetch live usage
    const detail = await buildSingleAccountStatus()
    return c.json({
      mode: "single",
      accounts: [detail],
    })
  } catch (error) {
    console.error("Error fetching account status:", error)
    return c.json({ error: "Failed to fetch account status" }, 500)
  }
})

function formatQuota(quota: {
  entitlement: number
  remaining: number
  unlimited: boolean
}) {
  if (quota.unlimited) {
    return { used: 0, total: 0, remaining: 0, unlimited: true }
  }
  const used = quota.entitlement - quota.remaining
  return {
    used,
    total: quota.entitlement,
    remaining: quota.remaining,
    unlimited: false,
  }
}

async function buildSingleAccountInfo() {
  const availableModels = state.models?.data.map((m) => m.id) ?? []
  const modelCatalogKnown = Boolean(state.models)

  try {
    const usage = await getCopilotUsage()
    return {
      name: "default",
      accountType: state.accountType,
      active: true,
      status: "ready",
      plan: getPlanDisplayName(usage.copilot_plan),
      activeSessions: 0,
      modelCatalogKnown,
      availableModelCount: availableModels.length,
      availableModels,
      lastError: null,
    }
  } catch {
    return {
      name: "default",
      accountType: state.accountType,
      active: Boolean(state.copilotToken),
      status: state.copilotToken ? "ready" : "error",
      plan: null,
      activeSessions: 0,
      modelCatalogKnown,
      availableModelCount: availableModels.length,
      availableModels,
      lastError: state.copilotToken ? null : "No token configured",
    }
  }
}

async function buildSingleAccountStatus() {
  const availableModels = state.models?.data.map((m) => m.id) ?? []
  const modelCatalogKnown = Boolean(state.models)

  try {
    const usage = await getCopilotUsage()
    const summary = extractUsageSummary(usage)
    return {
      name: "default",
      accountType: state.accountType,
      active: true,
      status: "ready",
      lastError: null,
      activeSessions: 0,
      modelCatalogKnown,
      availableModelCount: availableModels.length,
      availableModels,
      plan: { name: summary.planDisplay, raw: summary.plan },
      quota: {
        premium: formatQuota(summary.premium),
        chat: formatQuota(summary.chat),
        completions: formatQuota(summary.completions),
      },
      quotaResetDate: summary.resetDate,
    }
  } catch (error) {
    return {
      name: "default",
      accountType: state.accountType,
      active: Boolean(state.copilotToken),
      status: "error",
      lastError:
        error instanceof Error ? error.message : "Failed to fetch usage",
      activeSessions: 0,
      modelCatalogKnown,
      availableModelCount: availableModels.length,
      availableModels,
      plan: null,
      quota: null,
      quotaResetDate: null,
    }
  }
}
