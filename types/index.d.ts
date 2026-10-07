export type CodexLine = { stream: 'stdout' | 'stderr' | 'info'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'codex-bridge': {
      lines: CodexLine[]
      running: string
      model: string
      models: string[]
      configModel: string
      isPickerHidden: boolean
      isCodexChat: boolean
      thread: string
      effort: string
      efforts: Record<string, string[]>
      configEffort: string
    }
  }
}
