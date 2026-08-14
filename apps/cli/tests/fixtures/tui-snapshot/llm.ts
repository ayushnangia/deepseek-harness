import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** Keyless TUI snapshot adapter: one real bash call followed by a final answer. */
class TuiSnapshotAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      const args = JSON.stringify({ command: 'printf TUI_BETA_READY', description: 'Prove the terminal tool round trip.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('tui-snapshot-call'), name: 'bash', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('tui-snapshot-call'), name: 'bash', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `Terminal beta ready: ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'tui-snapshot-llm'
export const inject = ['llm']

/** Register the keyless `tui-snapshot` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['tui-snapshot'], new TuiSnapshotAdapter())
}
