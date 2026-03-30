import consola from "consola"

import { getAccountContext } from "./account-context"
import { state } from "./state"
import {
  isUpstreamModelUnavailable,
  isUpstreamQuotaOrRateLimit,
  parseRetryAfterMs,
} from "./upstream-error"

const DEFAULT_COOLDOWN_MS = 90_000
const MAX_RETRY_ATTEMPTS = 5

export interface CopilotFetchRetryContext {
  /** Model being requested, for model-unavailability tracking */
  model?: string
  /** Session ID for session mapping updates on failover */
  sessionId?: string
}

/**
 * Fetch wrapper for upstream Copilot API calls with automatic
 * account failover on rate-limit / model-unavailable errors.
 *
 * On success or non-retryable error, returns the Response directly.
 * On retryable error with no more accounts, returns the last error response.
 *
 * The caller provides headers that include the current account's Authorization
 * token (via copilotHeaders()). On retry, this function swaps the Authorization
 * header to the failover account's copilot token.
 */
export async function copilotFetchWithRetry(
  url: string,
  init: RequestInit,
  ctx: CopilotFetchRetryContext = {},
): Promise<Response> {
  const accountManager = state.accountManager
  if (!accountManager) {
    // Single-account mode — no retry logic needed
    return fetch(url, init)
  }

  let requestInit = init
  const excludedAccounts = new Set<string>()
  let currentAccountName = getAccountContext()?.name

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    const response = await fetch(url, requestInit)

    // Success or non-error — return immediately
    if (response.ok) {
      return response
    }

    // Check rate-limit / quota error
    const isRateLimit = await isUpstreamQuotaOrRateLimit(response)
    if (isRateLimit && currentAccountName) {
      const cooldownMs = parseRetryAfterMs(
        response.headers,
        DEFAULT_COOLDOWN_MS,
      )
      accountManager.markAccountCooldown(
        currentAccountName,
        cooldownMs,
        `Upstream rate limit (HTTP ${response.status})`,
      )
      excludedAccounts.add(currentAccountName)

      consola.warn(
        `[copilot-fetch] Account ${currentAccountName} rate-limited `
          + `(attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS + 1}), trying failover...`,
      )

      const nextAccount = accountManager.resolveFailoverAccount(
        ctx.sessionId,
        ctx.model,
        excludedAccounts,
      )
      if (!nextAccount) {
        consola.warn("[copilot-fetch] No more accounts for failover")
        return response // Return the rate-limit response as-is
      }

      // Swap the Authorization header to the failover account's token
      const headers = new Headers(requestInit.headers)
      headers.set("Authorization", `Bearer ${nextAccount.copilotToken}`)
      requestInit = { ...requestInit, headers }
      currentAccountName = nextAccount.name
      continue
    }

    // Check model-unavailable error
    if (ctx.model && currentAccountName) {
      const isModelError = await isUpstreamModelUnavailable(response)
      if (isModelError) {
        accountManager.markModelUnavailable(currentAccountName, ctx.model)
        excludedAccounts.add(currentAccountName)

        consola.warn(
          `[copilot-fetch] Model ${ctx.model} unavailable for `
            + `${currentAccountName} (attempt ${attempt + 1}), trying failover...`,
        )

        const nextAccount = accountManager.resolveFailoverAccount(
          ctx.sessionId,
          ctx.model,
          excludedAccounts,
        )
        if (!nextAccount) {
          return response
        }

        const headers = new Headers(requestInit.headers)
        headers.set("Authorization", `Bearer ${nextAccount.copilotToken}`)
        requestInit = { ...requestInit, headers }
        currentAccountName = nextAccount.name
        continue
      }
    }

    // Non-retryable error — return as-is (caller will throw HTTPError)
    return response
  }

  // Exhausted all retries — make one last attempt
  return fetch(url, requestInit)
}
