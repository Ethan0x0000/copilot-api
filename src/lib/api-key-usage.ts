import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { isPremiumModel } from "./config"
import { PATHS } from "./paths"

// ── Types ────────────────────────────────────────────────────────────

export interface ApiKeyMonthlyUsage {
  premiumRequests: number
  totalRequests: number
  lastRequestTime: number
}

interface ApiKeyUsageData {
  /**
   * Copilot quota reset date (ISO date string, e.g. "2025-04-15").
   * When today >= this date, all counters reset.
   * `null` means not yet known — falls back to calendar-month reset.
   */
  resetDate: string | null
  /**
   * Fallback: calendar month (e.g. "2025-03") used when resetDate is unknown.
   */
  month: string
  keys: Partial<Record<string, ApiKeyMonthlyUsage>>
}

interface ApiKeyRequestLogEntry {
  /** timestamp (epoch seconds) */
  t: number
  /** key name */
  k: string
  /** model */
  m: string | undefined
  /** endpoint path */
  e: string
  /** isPremium */
  p: boolean
}

// ── State ────────────────────────────────────────────────────────────

let cachedUsage: ApiKeyUsageData | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

// ── Helpers ──────────────────────────────────────────────────────────

function getCurrentMonth(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}

function getTodayDateKey(): string {
  return new Date().toLocaleDateString("sv-SE")
}

// ── Disk I/O ─────────────────────────────────────────────────────────

function readUsageFromDisk(): ApiKeyUsageData {
  try {
    const raw = fs.readFileSync(PATHS.API_KEY_USAGE_PATH, "utf8").trim()
    if (!raw) return { resetDate: null, month: getCurrentMonth(), keys: {} }
    const data = JSON.parse(raw) as ApiKeyUsageData
    // Ensure month field exists (migration from older format)
    if (!data.month) {
      data.month = getCurrentMonth()
    }
    return data
  } catch {
    return { resetDate: null, month: getCurrentMonth(), keys: {} }
  }
}

function flushUsage(): void {
  writeTimer = null
  if (!cachedUsage) return

  try {
    fs.writeFileSync(
      PATHS.API_KEY_USAGE_PATH,
      `${JSON.stringify(cachedUsage, null, 2)}\n`,
      "utf8",
    )
  } catch (error) {
    consola.debug("Failed to persist API key usage", error)
  }
}

function scheduleFlush(): void {
  if (!writeTimer) {
    writeTimer = setTimeout(flushUsage, 1000)
  }
}

// ── JSONL request log ────────────────────────────────────────────────

function ensureLogDir(): void {
  if (!fs.existsSync(PATHS.API_KEY_LOGS_DIR)) {
    fs.mkdirSync(PATHS.API_KEY_LOGS_DIR, { recursive: true })
  }
}

function appendRequestLog(entry: ApiKeyRequestLogEntry): void {
  try {
    ensureLogDir()
    const dateKey = getTodayDateKey()
    const logPath = path.join(
      PATHS.API_KEY_LOGS_DIR,
      `api-key-requests-${dateKey}.jsonl`,
    )
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8")
  } catch (error) {
    consola.debug("Failed to write API key request log", error)
  }
}

// ── Reset logic ──────────────────────────────────────────────────────

/**
 * Check whether counters should be reset.
 *
 * Strategy:
 * 1. If a Copilot resetDate is known and today >= resetDate → reset.
 * 2. Otherwise fall back to calendar-month rollover.
 */
function shouldReset(data: ApiKeyUsageData): boolean {
  const today = getTodayDateKey() // "YYYY-MM-DD"

  if (data.resetDate && today >= data.resetDate) {
    return true
  }

  // Fallback: calendar-month rollover
  const currentMonth = getCurrentMonth()
  return data.month !== currentMonth
}

function performReset(data: ApiKeyUsageData): ApiKeyUsageData {
  const currentMonth = getCurrentMonth()
  consola.info(
    data.resetDate ?
      `API key usage reset (Copilot quota reset date ${data.resetDate} reached)`
    : `API key usage reset (month rolled over → ${currentMonth})`,
  )
  return {
    resetDate: null, // will be re-populated on next Copilot usage fetch
    month: currentMonth,
    keys: {},
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Ensure the usage data is loaded and current.
 * Resets all counters when the Copilot reset date is reached (or month rolls over).
 */
function ensureUsage(): ApiKeyUsageData {
  if (!cachedUsage) {
    cachedUsage = readUsageFromDisk()
  }

  if (shouldReset(cachedUsage)) {
    cachedUsage = performReset(cachedUsage)
    scheduleFlush()
  }

  return cachedUsage
}

/**
 * Set the Copilot quota reset date.
 * Called from account manager / startup after fetching Copilot usage data.
 */
export function setApiKeyResetDate(resetDate: string): void {
  const usage = ensureUsage()
  if (usage.resetDate !== resetDate) {
    usage.resetDate = resetDate
    scheduleFlush()
    consola.debug(`API key usage reset date set to ${resetDate}`)
  }
}

/**
 * Get the currently known reset date (if any).
 */
export function getApiKeyResetDate(): string | null {
  const usage = ensureUsage()
  return usage.resetDate
}

/**
 * Get current period's usage for a specific key.
 */
export function getKeyUsage(keyName: string): ApiKeyMonthlyUsage {
  const usage = ensureUsage()
  return (
    usage.keys[keyName] ?? {
      premiumRequests: 0,
      totalRequests: 0,
      lastRequestTime: 0,
    }
  )
}

/**
 * Get usage summary for all keys.
 */
export function getAllKeyUsage(): {
  resetDate: string | null
  keys: Partial<Record<string, ApiKeyMonthlyUsage>>
} {
  const usage = ensureUsage()
  return { resetDate: usage.resetDate, keys: { ...usage.keys } }
}

/**
 * Record a request against an API key.
 * Increments usage counters and writes a JSONL log entry.
 */
export function recordApiKeyRequest(
  keyName: string,
  model: string | undefined,
  endpoint: string,
): void {
  const usage = ensureUsage()
  const premium = model ? isPremiumModel(model) : false
  const now = Date.now()

  const existing = usage.keys[keyName]
  usage.keys[keyName] = {
    premiumRequests: (existing?.premiumRequests ?? 0) + (premium ? 1 : 0),
    totalRequests: (existing?.totalRequests ?? 0) + 1,
    lastRequestTime: now,
  }

  scheduleFlush()

  // Append compact JSONL log entry
  appendRequestLog({
    t: Math.floor(now / 1000),
    k: keyName,
    m: model,
    e: endpoint,
    p: premium,
  })
}

/**
 * Check whether a key has exceeded its monthly premium limit.
 * Returns `true` if the limit is exceeded.
 * `monthlyPremiumLimit <= 0` or `undefined` means unlimited.
 */
export function isKeyPremiumLimitExceeded(
  keyName: string,
  monthlyPremiumLimit: number | undefined,
): boolean {
  if (monthlyPremiumLimit === undefined || monthlyPremiumLimit <= 0)
    return false

  const usage = getKeyUsage(keyName)
  return usage.premiumRequests >= monthlyPremiumLimit
}

// ── Cleanup on exit ──────────────────────────────────────────────────

function cleanup(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  flushUsage()
}

process.on("exit", cleanup)
