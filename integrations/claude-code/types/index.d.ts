export type SyncStatus = {
  regions: number
  applied: string[]
  pulled: string[]
  compiled: string[]
  modelCalls: number
  attention: { id: string; what: string }[]
  suggestions: number
  hostedTokensToday: number
  localTokensToday: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    openarc: {
      status: Shaped<SyncStatus | null>
      log: Shaped<string[]>
      seen: Shaped<string>
    }
  }
}
