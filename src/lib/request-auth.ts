import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import type { ApiKeyConfig } from "./config"

import {
  isKeyPremiumLimitExceeded,
  getApiKeyResetDate,
  recordApiKeyRequest,
} from "./api-key-usage"
import { getConfig, isPremiumModel } from "./config"

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Whether a monthlyPremiumLimit value means "unlimited".
 * `undefined`, `0`, and negative values all mean unlimited.
 */
function isUnlimited(limit: number | undefined): boolean {
  return limit === undefined || limit <= 0
}

// ── Normalization ────────────────────────────────────────────────────

function isApiKeyConfigObject(
  value: unknown,
): value is { name?: string; key: string; monthlyPremiumLimit?: number } {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as Record<string, unknown>).key === "string"
  )
}

/**
 * Normalize auth.apiKeys from config into a canonical Array<ApiKeyConfig>.
 * Supports both plain string entries (backward compat) and object entries.
 */
export function normalizeApiKeys(apiKeys: unknown): Array<ApiKeyConfig> {
  if (!Array.isArray(apiKeys)) {
    if (apiKeys !== undefined) {
      consola.warn(
        "Invalid auth.apiKeys config. Expected an array of strings or key objects.",
      )
    }
    return []
  }

  const configs: Array<ApiKeyConfig> = []
  const seenKeys = new Set<string>()
  let autoIndex = 0

  for (const entry of apiKeys) {
    if (typeof entry === "string") {
      const key = entry.trim()
      if (key.length > 0 && !seenKeys.has(key)) {
        seenKeys.add(key)
        autoIndex++
        configs.push({ name: `key-${autoIndex}`, key })
      }
    } else if (isApiKeyConfigObject(entry)) {
      const key = entry.key.trim()
      if (key.length > 0 && !seenKeys.has(key)) {
        seenKeys.add(key)
        autoIndex++
        const name = entry.name?.trim() || `key-${autoIndex}`
        configs.push({
          name,
          key,
          monthlyPremiumLimit: entry.monthlyPremiumLimit,
        })
      }
    } else {
      consola.warn(
        "Invalid auth.apiKeys entry found. Expected a string or { name, key, monthlyPremiumLimit? } object.",
      )
    }
  }

  return configs
}

export function getConfiguredApiKeys(): Array<ApiKeyConfig> {
  const config = getConfig()
  return normalizeApiKeys(config.auth?.apiKeys)
}

// ── Key extraction ───────────────────────────────────────────────────

export function extractRequestApiKey(c: Context): string | null {
  const xApiKey = c.req.header("x-api-key")?.trim()
  if (xApiKey) {
    return xApiKey
  }

  const authorization = c.req.header("authorization")
  if (!authorization) {
    return null
  }

  const [scheme, ...rest] = authorization.trim().split(/\s+/)
  if (scheme.toLowerCase() !== "bearer") {
    return null
  }

  const bearerToken = rest.join(" ").trim()
  return bearerToken || null
}

// ── Response helpers ─────────────────────────────────────────────────

function createUnauthorizedResponse(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    {
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    },
    401,
  )
}

function createPremiumLimitResponse(
  c: Context,
  keyName: string,
  limit: number,
): Response {
  const resetDate = getApiKeyResetDate()
  const resetInfo =
    resetDate ?
      `Resets on ${resetDate}.`
    : "Resets at the beginning of the next billing cycle."

  return c.json(
    {
      error: {
        message: `API key "${keyName}" has reached its monthly premium request limit (${limit}). ${resetInfo}`,
        type: "rate_limit_error",
      },
    },
    429,
  )
}

// ── Middleware ────────────────────────────────────────────────────────

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<ApiKeyConfig>
  allowUnauthenticatedPaths?: Array<string>
  allowOptionsBypass?: boolean
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  const getApiKeys = options.getApiKeys ?? getConfiguredApiKeys
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]
  const allowOptionsBypass = options.allowOptionsBypass ?? true

  return async (c, next) => {
    if (allowOptionsBypass && c.req.method === "OPTIONS") {
      return next()
    }

    if (allowUnauthenticatedPaths.includes(c.req.path)) {
      return next()
    }

    const apiKeys = getApiKeys()
    if (apiKeys.length === 0) {
      return next()
    }

    const requestApiKey = extractRequestApiKey(c)
    if (!requestApiKey) {
      return createUnauthorizedResponse(c)
    }

    const matchedKey = apiKeys.find((config) => config.key === requestApiKey)
    if (!matchedKey) {
      return createUnauthorizedResponse(c)
    }

    // Store resolved key info on Hono context for downstream use
    c.set("apiKeyName", matchedKey.name)
    c.set("apiKeyConfig", matchedKey)

    // ── Premium limit pre-check ──────────────────────────────────
    let requestModel: string | undefined

    if (c.req.method === "POST") {
      try {
        const cloned = c.req.raw.clone()
        const body = (await cloned.json()) as { model?: string }
        requestModel = body.model
      } catch {
        // Not JSON or no model field — fine
      }
    }

    if (
      !isUnlimited(matchedKey.monthlyPremiumLimit)
      && requestModel
      && isPremiumModel(requestModel)
      && isKeyPremiumLimitExceeded(
        matchedKey.name,
        matchedKey.monthlyPremiumLimit,
      )
    ) {
      return createPremiumLimitResponse(
        c,
        matchedKey.name,
        matchedKey.monthlyPremiumLimit ?? 0,
      )
    }

    // ── Execute handler ──────────────────────────────────────────
    await next()

    // ── Post-request: record usage ───────────────────────────────
    recordApiKeyRequest(matchedKey.name, requestModel, c.req.path)
  }
}
