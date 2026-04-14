import consola from "consola"

import type { AccountManager } from "./account-manager"

import { getAccountContext } from "./account-context"
import { state } from "./state"
import {
  classifyUpstreamAccountFailure,
  type UpstreamAccountFailure,
  isUpstreamModelUnavailable,
  isUpstreamServerError,
  parseRetryAfterMs,
} from "./upstream-error"

const DEFAULT_COOLDOWN_MS = 90_000
const SERVER_ERROR_COOLDOWN_MS = 30_000
const MAX_RETRY_ATTEMPTS = 5

export interface CopilotFetchRetryContext {
  /** Model being requested, for model-unavailability tracking */
  model?: string
  /** Session ID for session mapping updates on failover */
  sessionId?: string
}

interface FailoverResult {
  requestInit: RequestInit
  accountName: string
}

interface FailoverOptions {
  accountManager: AccountManager
  currentInit: RequestInit
  ctx: CopilotFetchRetryContext
  excludedAccounts: Set<string>
  accountName: string
  reason: string
}

interface AccountFailureOptions {
  accountManager: AccountManager
  accountName: string
  response: Response
  failure: UpstreamAccountFailure
}

/**
 * Resolve a failover account after an error, swapping the Authorization header.
 * Returns the new requestInit + accountName, or undefined if no failover available.
 */
function resolveFailover(opts: FailoverOptions): FailoverResult | undefined {
  const {
    accountManager,
    currentInit,
    ctx,
    excludedAccounts,
    accountName,
    reason,
  } = opts
  excludedAccounts.add(accountName)
  consola.warn(`[copilot-fetch] ${reason}, trying failover...`)

  const nextAccount = accountManager.resolveFailoverAccount(
    ctx.sessionId,
    ctx.model,
    excludedAccounts,
  )
  if (!nextAccount) {
    consola.warn("[copilot-fetch] No more accounts for failover")
    return undefined
  }

  const headers = new Headers(currentInit.headers)
  headers.set("Authorization", `Bearer ${nextAccount.copilotToken}`)
  return {
    requestInit: { ...currentInit, headers },
    accountName: nextAccount.name,
  }
}

function applyAccountFailure(opts: AccountFailureOptions): void {
  const { accountManager, accountName, response, failure } = opts

  if (failure.status === "rate_limited") {
    accountManager.markAccountRateLimited(
      accountName,
      parseRetryAfterMs(response.headers, DEFAULT_COOLDOWN_MS),
      failure.reason,
    )
    return
  }

  if (failure.status === "quota_exhausted") {
    accountManager.markAccountQuotaExhausted(accountName, failure.reason)
    return
  }

  accountManager.markAccountDisabled(accountName, failure.reason)
}

/**
 * Fetch wrapper for upstream Copilot API calls with automatic
 * account failover on rate-limit / model-unavailable / server errors.
 *
 * On success or non-retryable error, returns the Response directly.
 * On retryable error with no more accounts, returns the last error response.
 */
export async function copilotFetchWithRetry(
  url: string,
  init: RequestInit,
  ctx: CopilotFetchRetryContext = {},
): Promise<Response> {
  const accountManager = state.accountManager
  const currentName = getAccountContext()?.name
  if (!accountManager || !currentName) return fetch(url, init)

  let requestInit = init
  let currentAccountName = currentName
  const excludedAccounts = new Set<string>()

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    const tag = `attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS + 1}`
    let response: Response

    try {
      response = await fetch(url, requestInit)
    } catch (error) {
      accountManager.markAccountCooldown(
        currentAccountName,
        SERVER_ERROR_COOLDOWN_MS,
        `Network error: ${String(error)}`,
      )
      const failover = resolveFailover({
        accountManager,
        currentInit: requestInit,
        ctx,
        excludedAccounts,
        accountName: currentAccountName,
        reason: `Account ${currentAccountName} network error (${tag})`,
      })
      if (!failover) throw error
      ;({ requestInit, accountName: currentAccountName } = failover)
      continue
    }

    if (response.ok) return response

    const accountFailure = await classifyUpstreamAccountFailure(response)
    if (accountFailure) {
      applyAccountFailure({
        accountManager,
        accountName: currentAccountName,
        response,
        failure: accountFailure,
      })

      const failover = resolveFailover({
        accountManager,
        currentInit: requestInit,
        ctx,
        excludedAccounts,
        accountName: currentAccountName,
        reason: `Account ${currentAccountName} ${accountFailure.status.replaceAll("_", " ")} (${tag})`,
      })
      if (!failover) return response
      ;({ requestInit, accountName: currentAccountName } = failover)
      continue
    }

    // Model-unavailable error
    if (ctx.model && (await isUpstreamModelUnavailable(response))) {
      accountManager.markModelUnavailable(currentAccountName, ctx.model)
      const failover = resolveFailover({
        accountManager,
        currentInit: requestInit,
        ctx,
        excludedAccounts,
        accountName: currentAccountName,
        reason: `Model ${ctx.model} unavailable for ${currentAccountName} (${tag})`,
      })
      if (!failover) return response
      ;({ requestInit, accountName: currentAccountName } = failover)
      continue
    }

    // Server error (5xx) — transient, retry with short cooldown
    if (isUpstreamServerError(response)) {
      accountManager.markAccountCooldown(
        currentAccountName,
        SERVER_ERROR_COOLDOWN_MS,
        `Upstream server error (HTTP ${response.status})`,
      )
      const failover = resolveFailover({
        accountManager,
        currentInit: requestInit,
        ctx,
        excludedAccounts,
        accountName: currentAccountName,
        reason: `Account ${currentAccountName} server error (HTTP ${response.status}, ${tag})`,
      })
      if (!failover) return response
      ;({ requestInit, accountName: currentAccountName } = failover)
      continue
    }

    // Non-retryable error — return as-is (caller will throw HTTPError)
    return response
  }

  // Exhausted all retries — make one last attempt
  return fetch(url, requestInit)
}
