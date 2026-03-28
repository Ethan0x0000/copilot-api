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

const copilotRoutePaths = new Set([
  "/chat/completions",
  "/models",
  "/embeddings",
  "/responses",
  "/v1/chat/completions",
  "/v1/models",
  "/v1/embeddings",
  "/v1/responses",
  "/v1/messages",
])

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

  const sessionId = c.req.header("x-session-id")

  // Extract model from request body for tier-based routing
  let model: string | undefined
  if (c.req.method === "POST") {
    try {
      const cloned = c.req.raw.clone()
      const body = (await cloned.json()) as { model?: string }
      model = body.model
    } catch {
      // Not JSON or no model field — fine
    }
  }

  const account = accountManager.resolveAccount(sessionId, model)
  if (!account) {
    if (copilotRoutePaths.has(c.req.path)) {
      return c.json(
        {
          error:
            model ?
              `No active account supports requested model: ${model}`
            : "No active account is currently ready to serve requests",
        },
        503,
      )
    }

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
