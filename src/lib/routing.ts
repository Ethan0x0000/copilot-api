import type { RoutingConfig } from "./config"

const DEFAULT_TIER_PRIORITY = ["free", "student", "pro", "pro_plus"]

/**
 * Get the numeric rank of a tier. Higher = more capable.
 * Unknown tiers get rank -1 (treated as lowest).
 */
export function getTierRank(tier: string, tierPriority: Array<string>): number {
  return tierPriority.indexOf(tier)
}

/**
 * Find the minimum tier required for a given model.
 *
 * Matching rules (first match wins):
 *   1. Exact match:   "claude-sonnet-4" → "pro"
 *   2. Wildcard match: "o1*" matches "o1-pro", "o1-mini" (longest prefix wins)
 *   3. No match → undefined (any tier can use it)
 */
export function getModelMinTier(
  model: string,
  requirements: Record<string, string>,
): string | undefined {
  // Exact match first
  if (requirements[model]) {
    return requirements[model]
  }

  // Wildcard match — longest prefix wins
  let bestMatch: string | undefined
  let bestLen = 0

  for (const [pattern, tier] of Object.entries(requirements)) {
    if (!pattern.endsWith("*")) continue
    const prefix = pattern.slice(0, -1)
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      bestMatch = tier
      bestLen = prefix.length
    }
  }

  return bestMatch
}

/**
 * Determine if an account tier is eligible for a model.
 */
export function isTierEligible(
  accountTier: string,
  minTier: string | undefined,
  tierPriority: Array<string>,
): boolean {
  if (!minTier) return true // no requirement → any tier

  const accountRank = getTierRank(accountTier, tierPriority)
  const requiredRank = getTierRank(minTier, tierPriority)

  // Unknown tiers: if account tier is unknown, deny; if required tier is unknown, allow
  if (accountRank === -1) return false
  if (requiredRank === -1) return true

  return accountRank >= requiredRank
}

export interface TierRoutingContext {
  tierPriority: Array<string>
  modelTierRequirements: Record<string, string>
}

export function buildRoutingContext(config: RoutingConfig): TierRoutingContext {
  return {
    tierPriority: config.tierPriority ?? DEFAULT_TIER_PRIORITY,
    modelTierRequirements: config.modelTierRequirements ?? {},
  }
}

/**
 * Filter and sort accounts by tier eligibility for a model.
 *
 * Returns accounts sorted by tier rank ascending (lowest tier first),
 * so cheaper/student accounts are preferred when eligible.
 */
export function filterAndSortByTier<T extends { tier: string }>(
  accounts: Array<T>,
  model: string | undefined,
  ctx: TierRoutingContext,
): Array<T> {
  if (!model || Object.keys(ctx.modelTierRequirements).length === 0) {
    return accounts
  }

  const minTier = getModelMinTier(model, ctx.modelTierRequirements)

  const eligible = accounts.filter((a) =>
    isTierEligible(a.tier, minTier, ctx.tierPriority),
  )

  // Sort by tier rank ascending — prefer lower tiers to save premium quota
  eligible.sort(
    (a, b) =>
      getTierRank(a.tier, ctx.tierPriority)
      - getTierRank(b.tier, ctx.tierPriority),
  )

  return eligible
}
