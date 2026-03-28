import { AsyncLocalStorage } from "node:async_hooks"

export interface AccountContext {
  name: string
  copilotToken: string
  githubToken: string
  accountType: string
}

const accountStorage = new AsyncLocalStorage<AccountContext>()

export function getAccountContext(): AccountContext | undefined {
  return accountStorage.getStore()
}

export function runWithAccount<T>(account: AccountContext, fn: () => T): T {
  return accountStorage.run(account, fn)
}
