const DEFAULT_COOLDOWN_MS = 90_000 // 90 seconds

export type UpstreamAccountFailureStatus =
  | "rate_limited"
  | "quota_exhausted"
  | "disabled"

export interface UpstreamAccountFailure {
  status: UpstreamAccountFailureStatus
  reason: string
}

async function readUpstreamBodyText(response: Response): Promise<string> {
  return response
    .clone()
    .text()
    .catch(() => "")
}

export async function classifyUpstreamAccountFailure(
  response: Response,
): Promise<UpstreamAccountFailure | undefined> {
  if (response.status === 429) {
    return {
      status: "rate_limited",
      reason: "Upstream rate limit (HTTP 429)",
    }
  }

  if (response.status >= 500 || response.status !== 403) {
    return undefined
  }

  const lower = (await readUpstreamBodyText(response)).toLowerCase()

  if (
    lower.includes("temporarily paused")
    || lower.includes("upgrade your account")
    || lower.includes("revert to copilot free")
  ) {
    return {
      status: "disabled",
      reason: "Copilot account temporarily paused upstream (HTTP 403)",
    }
  }

  if (lower.includes("quota") || lower.includes("exhaust")) {
    return {
      status: "quota_exhausted",
      reason: "Upstream quota exhausted (HTTP 403)",
    }
  }

  if (lower.includes("rate limit") || lower.includes("capacity")) {
    return {
      status: "rate_limited",
      reason: "Upstream rate limit (HTTP 403)",
    }
  }

  return undefined
}

/**
 * Detect if an upstream Copilot API response indicates a quota/rate-limit error.
 * Uses response.clone() so the original body is still consumable.
 */
export async function isUpstreamQuotaOrRateLimit(
  response: Response,
): Promise<boolean> {
  const failure = await classifyUpstreamAccountFailure(response)
  return (
    failure?.status === "rate_limited" || failure?.status === "quota_exhausted"
  )
}

/**
 * Detect if an upstream response indicates the model is not available
 * for this account.
 */
export async function isUpstreamModelUnavailable(
  response: Response,
): Promise<boolean> {
  if (![400, 403, 404].includes(response.status)) return false

  const text = await readUpstreamBodyText(response)
  const lower = text.toLowerCase()
  if (!lower.includes("model")) return false

  return (
    lower.includes("not found")
    || lower.includes("not available")
    || lower.includes("unsupported")
    || lower.includes("does not exist")
    || lower.includes("ineligible")
  )
}

/**
 * Detect if an upstream response is a server error (5xx).
 * These are usually transient (gateway timeouts, service unavailable)
 * and should be retried with account failover.
 */
export function isUpstreamServerError(response: Response): boolean {
  return response.status >= 500
}

/**
 * Parse Retry-After header value into milliseconds.
 */
export function parseRetryAfterMs(
  headers: Headers,
  fallbackMs: number = DEFAULT_COOLDOWN_MS,
): number {
  const retryAfter = headers.get("retry-after")
  if (!retryAfter) return fallbackMs

  const numeric = Number.parseInt(retryAfter, 10)
  if (Number.isFinite(numeric) && numeric > 0) return numeric * 1000

  return fallbackMs
}
