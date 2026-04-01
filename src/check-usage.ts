import { defineCommand } from "citty"
import consola from "consola"

import { ensurePaths } from "./lib/paths"
import {
  formatQuotaBar,
  formatQuotaLine,
  getPlanDisplayName,
} from "./lib/subscription"
import { setupGitHubToken } from "./lib/token"
import { getCopilotUsage } from "./services/github/get-copilot-usage"

export const checkUsage = defineCommand({
  meta: {
    name: "check-usage",
    description: "Show current GitHub Copilot usage/quota information",
  },
  async run() {
    await ensurePaths()
    await setupGitHubToken()
    try {
      const usage = await getCopilotUsage()
      const planDisplay = getPlanDisplayName(usage.copilot_plan)

      const lines: Array<string> = [
        `Copilot Usage`,
        `Plan: ${planDisplay} (${usage.copilot_plan})`,
        `Quota resets: ${usage.quota_reset_date}`,
        `\nQuotas:`,
      ]

      if (usage.quota_snapshots) {
        const premium = usage.quota_snapshots.premium_interactions
        const premiumLine = formatQuotaLine("Premium", premium)
        const premiumBar = `         ${formatQuotaBar(premium)}`
        const chatLine = formatQuotaLine("Chat", usage.quota_snapshots.chat)
        const completionsLine = formatQuotaLine(
          "Completions",
          usage.quota_snapshots.completions,
        )
        lines.push(
          `  ${premiumLine}`,
          `  ${premiumBar}`,
          `  ${chatLine}`,
          `  ${completionsLine}`,
        )
      } else {
        lines.push(`  (quota information unavailable)`)
      }

      consola.box(lines.join("\n"))
    } catch (err) {
      consola.error("Failed to fetch Copilot usage:", err)
      process.exit(1)
    }
  },
})
