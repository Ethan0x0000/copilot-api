import {
  getGitHubApiBaseUrl,
  githubHeaders,
  standardHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getCopilotToken = async (githubToken?: string) => {
  const headers =
    githubToken ?
      {
        ...standardHeaders(),
        authorization: `token ${githubToken}`,
        "editor-version": `vscode/${state.vsCodeVersion}`,
      }
    : githubHeaders(state)

  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers,
    },
  )

  if (!response.ok) throw new HTTPError("Failed to get Copilot token", response)

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}
