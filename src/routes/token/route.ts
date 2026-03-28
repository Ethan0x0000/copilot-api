import { Hono } from "hono"

import { getAccountContext } from "~/lib/account-context"
import { state } from "~/lib/state"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  try {
    const account = getAccountContext()
    const token = account?.copilotToken ?? state.copilotToken

    return c.json({
      token,
      ...(account ? { account: account.name } : {}),
    })
  } catch (error) {
    console.error("Error fetching token:", error)
    return c.json({ error: "Failed to fetch token", token: null }, 500)
  }
})
