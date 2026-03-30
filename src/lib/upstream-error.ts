const DEFAULT_COOLDOWN_MS = 90_000 // 90 seconds

/**
 * Detect if an upstream Copilot API response indicates a quota/rate-limit error.
 * Uses response.clone() so the original body is still consumable.
 */
export async function isUpstreamQuotaOrRateLimit(
  response: Response,
): Promise<boolean> {
  if (response.status === 429) return true
  if (response.status >= 500) return false
  if (response.status !== 403) return false

  const text = await response
    .clone()
    .text()
    .catch(() => "")
  const lower = text.toLowerCase()
  return (
    lower.includes("rate limit")
    || lower.includes("quota")
    || lower.includes("exhaust")
    || lower.includes("capacity")
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

  const text = await response
    .clone()
    .text()
    .catch(() => "")
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
