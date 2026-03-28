import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { runWithAccount } from "./lib/account-context"
import { createAuthMiddleware } from "./lib/request-auth"
import { state } from "./lib/state"
import { traceIdMiddleware } from "./lib/trace"
import { accountsRoute } from "./routes/accounts/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"

export const server = new Hono()

server.use(traceIdMiddleware)
server.use(logger())
server.use(cors())
server.use(
  "*",
  createAuthMiddleware({
    allowUnauthenticatedPaths: ["/"],
  }),
)

// Multi-account resolution middleware
server.use("*", async (c, next) => {
  const accountManager = state.accountManager
  if (!accountManager?.hasAccounts()) {
    return next()
  }

  // Extract session ID from header for session affinity
  const sessionId = c.req.header("x-session-id")

  const account = accountManager.resolveAccount(sessionId)
  if (!account) {
    return next()
  }

  return runWithAccount(account, () => next())
})

server.get("/", (c) => c.text("Server running"))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/accounts", accountsRoute)
server.route("/token", tokenRoute)
server.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Provider scoped Anthropic-compatible endpoints
server.route("/:provider/v1/messages", providerMessageRoutes)
server.route("/:provider/v1/models", providerModelRoutes)
