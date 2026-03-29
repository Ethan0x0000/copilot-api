import consola from "consola"
import fs from "node:fs"

import { PATHS } from "./paths"

export interface AccountRequestRecord {
  lastRequestTime: number
  lastRequestModel: string
}

type AccountStateData = Partial<Record<string, AccountRequestRecord>>

let writeTimer: ReturnType<typeof setTimeout> | null = null
let pendingState: AccountStateData | null = null

/**
 * Read all persisted account request records from disk.
 */
export function readAccountState(): AccountStateData {
  try {
    const raw = fs.readFileSync(PATHS.ACCOUNT_STATE_PATH, "utf8").trim()
    if (!raw) return {}
    return JSON.parse(raw) as AccountStateData
  } catch {
    return {}
  }
}

/**
 * Record a request for an account.
 * Writes are debounced (1 s) so rapid requests don't hammer the disk.
 */
export function recordAccountRequest(
  accountName: string,
  model: string | undefined,
): void {
  if (!pendingState) {
    pendingState = readAccountState()
  }

  const existing = pendingState[accountName]
  const record: AccountRequestRecord = {
    lastRequestTime: Date.now(),
    lastRequestModel: model || existing?.lastRequestModel || "",
  }

  pendingState[accountName] = record

  if (!writeTimer) {
    writeTimer = setTimeout(() => {
      flushAccountState()
    }, 1000)
  }
}

function flushAccountState(): void {
  writeTimer = null
  if (!pendingState) return

  try {
    fs.writeFileSync(
      PATHS.ACCOUNT_STATE_PATH,
      `${JSON.stringify(pendingState, null, 2)}\n`,
      "utf8",
    )
  } catch (error) {
    consola.debug("Failed to persist account state", error)
  }

  pendingState = null
}

/**
 * Get the persisted request record for a single account.
 */
export function getAccountRequestRecord(
  accountName: string,
): AccountRequestRecord | undefined {
  const data = readAccountState()
  return data[accountName]
}
