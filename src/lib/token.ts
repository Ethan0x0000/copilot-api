import consola from "consola"
import fs from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

import { isOpencodeOauthApp } from "~/lib/api-config"
import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

let copilotRefreshLoopController: AbortController | null = null

export const stopCopilotRefreshLoop = () => {
  if (!copilotRefreshLoopController) {
    return
  }

  copilotRefreshLoopController.abort()
  copilotRefreshLoopController = null
}

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export const setupCopilotToken = async () => {
  if (isOpencodeOauthApp()) {
    if (!state.githubToken) throw new Error(`opencode token not found`)

    state.copilotToken = state.githubToken

    consola.debug("GitHub Copilot token set from opencode auth token")
    if (state.showToken) {
      consola.info("Copilot token:", state.copilotToken)
    }

    stopCopilotRefreshLoop()
    return
  }

  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  stopCopilotRefreshLoop()

  const controller = new AbortController()
  copilotRefreshLoopController = controller

  runCopilotRefreshLoop(refresh_in, controller.signal)
    .catch(() => {
      consola.warn("Copilot token refresh loop stopped")
    })
    .finally(() => {
      if (copilotRefreshLoopController === controller) {
        copilotRefreshLoopController = null
      }
    })
}

const runCopilotRefreshLoop = async (
  refreshIn: number,
  signal: AbortSignal,
) => {
  let nextRefreshDelayMs = (refreshIn - 60) * 1000

  while (!signal.aborted) {
    await delay(nextRefreshDelayMs, undefined, { signal })

    consola.debug("Refreshing Copilot token")

    try {
      const { token, refresh_in } = await getCopilotToken()
      state.copilotToken = token
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }

      nextRefreshDelayMs = (refresh_in - 60) * 1000
    } catch (error) {
      consola.error("Failed to refresh Copilot token:", error)
      nextRefreshDelayMs = 15_000
      consola.warn(`Retrying Copilot token refresh in ${nextRefreshDelayMs}ms`)
    }
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  if (!state.githubToken) return
  const user = await getGitHubUser(state.githubToken)
  consola.info(`Logged in as ${user.login}`)
}

// --- Per-account token management ---

export interface AccountTokenState {
  copilotToken: string
  refreshController: AbortController
}

export async function fetchCopilotTokenForAccount(
  githubToken: string,
): Promise<{ token: string; refreshIn: number }> {
  if (isOpencodeOauthApp()) {
    return { token: githubToken, refreshIn: 0 }
  }

  const { token, refresh_in } = await getCopilotToken(githubToken)
  return { token, refreshIn: refresh_in }
}

interface AccountRefreshOptions {
  accountName: string
  githubToken: string
  refreshIn: number
  onTokenRefreshed: (token: string) => void
}

export function startAccountRefreshLoop(
  options: AccountRefreshOptions,
): AbortController {
  const controller = new AbortController()

  if (isOpencodeOauthApp() || options.refreshIn <= 0) {
    return controller
  }

  runAccountRefreshLoop({
    ...options,
    signal: controller.signal,
  }).catch(() => {
    consola.warn(
      `Copilot token refresh loop stopped for account ${options.accountName}`,
    )
  })

  return controller
}

const runAccountRefreshLoop = async (options: {
  accountName: string
  githubToken: string
  refreshIn: number
  signal: AbortSignal
  onTokenRefreshed: (token: string) => void
}) => {
  const { accountName, githubToken, signal, onTokenRefreshed } = options
  let nextRefreshDelayMs = (options.refreshIn - 60) * 1000

  while (!signal.aborted) {
    await delay(nextRefreshDelayMs, undefined, { signal })

    consola.debug(`Refreshing Copilot token for account ${accountName}`)

    try {
      const { token, refresh_in } = await getCopilotToken(githubToken)
      onTokenRefreshed(token)
      consola.debug(`Copilot token refreshed for account ${accountName}`)
      if (state.showToken) {
        consola.info(`Refreshed Copilot token for ${accountName}:`, token)
      }

      nextRefreshDelayMs = (refresh_in - 60) * 1000
    } catch (error) {
      consola.error(
        `Failed to refresh Copilot token for account ${accountName}:`,
        error,
      )
      nextRefreshDelayMs = 15_000
      consola.warn(
        `Retrying Copilot token refresh for ${accountName} in ${nextRefreshDelayMs}ms`,
      )
    }
  }
}
