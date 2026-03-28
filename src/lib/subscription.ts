import type {
  CopilotUsageResponse,
  QuotaDetail,
} from "~/services/github/get-copilot-usage"

// Maps copilot_plan API values to human-friendly tier names.
// GitHub uses various identifiers across versions; this mapping covers known
// values and falls back to the raw string for unknown plans.
const PLAN_DISPLAY_NAMES: Record<string, string> = {
  // Individual tiers
  copilot_free: "Free",
  copilot_for_individuals_free: "Free",
  copilot_individual: "Pro",
  copilot_for_individuals: "Pro",
  copilot_pro: "Pro",
  copilot_for_individuals_pro: "Pro",
  copilot_pro_plus: "Pro+",
  copilot_for_individuals_pro_plus: "Pro+",
  // Education
  copilot_for_education: "Student (Education)",
  copilot_education: "Student (Education)",
  // Business / Enterprise
  copilot_for_business: "Business",
  copilot_business: "Business",
  copilot_for_enterprise: "Enterprise",
  copilot_enterprise: "Enterprise",
}

export function getPlanDisplayName(copilotPlan: string): string {
  const normalized = copilotPlan.toLowerCase().trim()
  if (PLAN_DISPLAY_NAMES[normalized]) {
    return PLAN_DISPLAY_NAMES[normalized]
  }

  // Heuristic fallback for unknown values
  if (normalized.includes("free")) return `Free (${copilotPlan})`
  if (normalized.includes("pro_plus") || normalized.includes("pro+"))
    return `Pro+ (${copilotPlan})`
  if (normalized.includes("pro")) return `Pro (${copilotPlan})`
  if (normalized.includes("education") || normalized.includes("student"))
    return `Student (${copilotPlan})`
  if (normalized.includes("business")) return `Business (${copilotPlan})`
  if (normalized.includes("enterprise")) return `Enterprise (${copilotPlan})`

  return copilotPlan
}

export type AccountStatus =
  | "ready"
  | "error"
  | "rate_limited"
  | "disabled"
  | "quota_exhausted"

export function getStatusEmoji(status: AccountStatus): string {
  switch (status) {
    case "ready": {
      return "\u2705"
    }
    case "error": {
      return "\u274C"
    }
    case "rate_limited": {
      return "\u23F3"
    }
    case "disabled": {
      return "\u26D4"
    }
    case "quota_exhausted": {
      return "\uD83D\uDEAB"
    }
    default: {
      return "\u2753"
    }
  }
}

export function getStatusLabel(status: AccountStatus): string {
  switch (status) {
    case "ready": {
      return "Ready"
    }
    case "error": {
      return "Error"
    }
    case "rate_limited": {
      return "Rate Limited"
    }
    case "disabled": {
      return "Disabled"
    }
    case "quota_exhausted": {
      return "Quota Exhausted"
    }
    default: {
      return "Unknown"
    }
  }
}

export function formatQuotaLine(name: string, quota: QuotaDetail): string {
  if (quota.unlimited) {
    return `${name}: unlimited`
  }
  const total = quota.entitlement
  const used = total - quota.remaining
  const pct = total > 0 ? ((used / total) * 100).toFixed(1) : "0.0"
  return `${name}: ${used}/${total} (${pct}% used)`
}

export function formatQuotaBar(quota: QuotaDetail): string {
  if (quota.unlimited) return "[unlimited]"
  const total = quota.entitlement
  if (total <= 0) return "[N/A]"
  const used = total - quota.remaining
  const pct = used / total
  const barLength = 20
  const filled = Math.round(pct * barLength)
  const empty = barLength - filled
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty)
  return `[${bar}] ${used}/${total}`
}

export interface AccountUsageSummary {
  plan: string
  planDisplay: string
  resetDate: string
  premium: QuotaDetail
  chat: QuotaDetail
  completions: QuotaDetail
}

export function extractUsageSummary(
  usage: CopilotUsageResponse,
): AccountUsageSummary {
  return {
    plan: usage.copilot_plan,
    planDisplay: getPlanDisplayName(usage.copilot_plan),
    resetDate: usage.quota_reset_date,
    premium: usage.quota_snapshots.premium_interactions,
    chat: usage.quota_snapshots.chat,
    completions: usage.quota_snapshots.completions,
  }
}
