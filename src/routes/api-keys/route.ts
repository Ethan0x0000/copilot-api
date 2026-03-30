import { Hono } from "hono"

import { getAllKeyUsage } from "~/lib/api-key-usage"
import { getConfiguredApiKeys } from "~/lib/request-auth"

export const apiKeysRoute = new Hono()

apiKeysRoute.get("/usage", (c) => {
  const { resetDate, keys } = getAllKeyUsage()
  const configs = getConfiguredApiKeys()

  const result = configs.map((config) => {
    const usage = keys[config.name]
    const limit = config.monthlyPremiumLimit
    return {
      name: config.name,
      monthlyPremiumLimit:
        limit === undefined || limit <= 0 ? "unlimited" : limit,
      premiumRequests: usage?.premiumRequests ?? 0,
      totalRequests: usage?.totalRequests ?? 0,
      lastRequestTime: usage?.lastRequestTime ?? null,
    }
  })

  return c.json({ resetDate, keys: result })
})
