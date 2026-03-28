import { defineCommand } from "citty"
import consola from "consola"

import { type AccountConfig, getAccounts, saveAccounts } from "./lib/config"
import { ensurePaths } from "./lib/paths"
import {
  extractUsageSummary,
  formatQuotaBar,
  formatQuotaLine,
  getPlanDisplayName,
  getStatusEmoji,
  getStatusLabel,
} from "./lib/subscription"
import { getCopilotUsage } from "./services/github/get-copilot-usage"
import { getDeviceCode } from "./services/github/get-device-code"
import { getGitHubUser } from "./services/github/get-user"
import { pollAccessToken } from "./services/github/poll-access-token"

const accountAdd = defineCommand({
  meta: {
    name: "add",
    description:
      "Add a GitHub account (via --token or interactive device flow login)",
  },
  args: {
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type (individual, business, enterprise)",
    },
    name: {
      alias: "n",
      type: "string",
      description: "Account name (defaults to GitHub username)",
    },
    token: {
      alias: "t",
      type: "string",
      description: "Provide a GitHub token directly (skip device flow)",
    },
  },
  async run({ args }) {
    await ensurePaths()

    let githubToken: string

    if (args.token) {
      // Mode 1: direct token
      githubToken = args.token
      consola.info("Using provided GitHub token")
    } else {
      // Mode 2: interactive device flow
      consola.info("Starting GitHub device flow authentication...")
      const response = await getDeviceCode()

      consola.info(
        `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
      )

      githubToken = await pollAccessToken(response)
      consola.success("Authentication successful!")
    }

    // Resolve account name: explicit --name > GitHub username
    const accountName = await resolveAccountName(args.name, githubToken)

    // Fetch plan info (best-effort)
    let planDisplay = "unknown"
    try {
      const usage = await getCopilotUsage(githubToken)
      planDisplay = getPlanDisplayName(usage.copilot_plan)
    } catch {
      consola.debug("Could not fetch plan info")
    }

    // Save (upsert)
    const accounts = getAccounts()
    const existing = accounts.find((a) => a.name === accountName)
    if (existing) {
      consola.warn(`Account "${accountName}" already exists. Updating token...`)
      existing.githubToken = githubToken
      existing.accountType = args["account-type"]
      existing.active = true
      saveAccounts(accounts)
      consola.success(`Account "${accountName}" updated (${planDisplay})`)
      return
    }

    accounts.push({
      name: accountName,
      githubToken,
      accountType: args["account-type"],
      active: true,
    })
    saveAccounts(accounts)

    consola.success(
      `Account "${accountName}" added [${planDisplay}] (${args["account-type"]})`,
    )
    consola.info(
      `Total accounts: ${accounts.length}. Restart the server to apply changes.`,
    )
  },
})

async function resolveAccountName(
  explicitName: string | undefined,
  githubToken: string,
): Promise<string> {
  if (explicitName) return explicitName

  try {
    const user = await getGitHubUser(githubToken)
    return user.login
  } catch {
    consola.warn("Could not fetch GitHub username. Use --name to set a name.")
    return `account-${Date.now()}`
  }
}

const accountList = defineCommand({
  meta: {
    name: "list",
    description: "List all configured GitHub accounts with plan and quota info",
  },
  async run() {
    await ensurePaths()

    const accounts = getAccounts()

    if (accounts.length === 0) {
      consola.info("No accounts configured. Use `account add` to add one.")
      return
    }

    consola.info(`Fetching status for ${accounts.length} account(s)...\n`)

    const lines: Array<string> = []

    for (const account of accounts) {
      const activeLabel =
        account.active !== false ? "\u2705 Active" : "\u26D4 Disabled"
      const tier = account.tier ?? "pro"
      const tokenPreview = `${account.githubToken.slice(0, 8)}...`

      const line = await formatAccountListEntry({
        account,
        tier,
        activeLabel,
        tokenPreview,
      })
      lines.push(line)
    }

    consola.log(lines.join("\n\n"))
  },
})

async function formatAccountListEntry(options: {
  account: AccountConfig
  tier: string
  activeLabel: string
  tokenPreview: string
}): Promise<string> {
  const { account, tier, activeLabel, tokenPreview } = options
  try {
    const usage = await getCopilotUsage(account.githubToken)
    const summary = extractUsageSummary(usage)

    const planLine = `  Plan: ${summary.planDisplay} (${summary.plan})`

    const premium = summary.premium
    let quotaLine: string
    if (premium.unlimited) {
      quotaLine = "  Premium: unlimited"
    } else {
      const used = premium.entitlement - premium.remaining
      quotaLine =
        `  Premium: ${formatQuotaBar(premium)} `
        + `(${used}/${premium.entitlement})`
    }

    let statusIcon: string
    if (!premium.unlimited && premium.remaining <= 0) {
      statusIcon = "\uD83D\uDEAB"
      quotaLine += " \u26A0 EXHAUSTED"
    } else {
      statusIcon = account.active !== false ? "\u2705" : "\u26D4"
    }

    quotaLine += `\n  Resets: ${summary.resetDate}`

    return (
      `${statusIcon} ${account.name} [${tier}] (${activeLabel})\n`
      + `  Token: ${tokenPreview}\n`
      + `${planLine}\n`
      + quotaLine
    )
  } catch {
    return (
      `\u274C ${account.name} [${tier}] (${activeLabel})\n`
      + `  Token: ${tokenPreview}\n`
      + "  Plan: \u26A0 failed to fetch (token may be invalid)"
    )
  }
}

const accountStatus = defineCommand({
  meta: {
    name: "status",
    description: "Show detailed status, plan, and quota for all accounts",
  },
  async run() {
    await ensurePaths()

    const accounts = getAccounts()

    if (accounts.length === 0) {
      consola.info("No accounts configured. Use `account add` to add one.")
      return
    }

    consola.info(
      `Fetching detailed status for ${accounts.length} account(s)...\n`,
    )

    // Fetch all account statuses in parallel
    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        const usage = await getCopilotUsage(account.githubToken)
        return { account, usage }
      }),
    )

    const sections: Array<string> = []

    for (const result of results) {
      if (result.status === "rejected") {
        sections.push(
          "\u274C Unknown Account\n"
            + `  Error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        )
        continue
      }

      const { account, usage } = result.value
      const summary = extractUsageSummary(usage)
      const tier = account.tier ?? "pro"
      const activeLabel = account.active !== false ? "active" : "disabled"

      // Determine status
      let status: "ready" | "quota_exhausted" | "disabled" = "ready"
      if (account.active === false) {
        status = "disabled"
      } else if (!summary.premium.unlimited && summary.premium.remaining <= 0) {
        status = "quota_exhausted"
      }

      const statusEmoji = getStatusEmoji(status)
      const statusLabel = getStatusLabel(status)

      const header = `${statusEmoji} ${account.name} [${tier}] - ${statusLabel}`
      const planInfo =
        `  Plan: ${summary.planDisplay}` + ` (raw: ${summary.plan})`

      const premiumLine = `  ${formatQuotaLine("Premium", summary.premium)}`
      const premiumBar = `           ${formatQuotaBar(summary.premium)}`
      const chatLine = `  ${formatQuotaLine("Chat", summary.chat)}`
      const completionsLine = `  ${formatQuotaLine("Completions", summary.completions)}`
      const resetLine = `  Reset: ${summary.resetDate}`
      const configLine = `  Config: ${activeLabel} | token: ${account.githubToken.slice(0, 8)}...`

      sections.push(
        [
          header,
          planInfo,
          "",
          premiumLine,
          premiumBar,
          chatLine,
          completionsLine,
          "",
          resetLine,
          configLine,
        ].join("\n"),
      )
    }

    consola.box(
      `Account Status Report\n\n${sections.join("\n\n" + "\u2500".repeat(50) + "\n\n")}`,
    )
  },
})

const accountRemove = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a configured GitHub account",
  },
  args: {
    name: {
      type: "positional",
      description: "Name of the account to remove",
      required: true,
    },
  },
  async run({ args }) {
    await ensurePaths()

    const accounts = getAccounts()
    const index = accounts.findIndex((a) => a.name === args.name)

    if (index === -1) {
      consola.error(`Account "${args.name}" not found`)
      const names = accounts.map((a) => a.name).join(", ")
      if (names) {
        consola.info(`Available accounts: ${names}`)
      }
      process.exit(1)
    }

    accounts.splice(index, 1)
    saveAccounts(accounts)

    consola.success(`Account "${args.name}" removed`)
    consola.info(
      `Remaining accounts: ${accounts.length}. Restart the server to apply changes.`,
    )
  },
})

export const account = defineCommand({
  meta: {
    name: "account",
    description: "Manage GitHub accounts for multi-account support",
  },
  subCommands: {
    add: accountAdd,
    list: accountList,
    status: accountStatus,
    remove: accountRemove,
  },
})
