/** Input and shutdown control shared by the interactive and plain terminal surfaces. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands'

/** Semantic styling for controller-owned terminal notices. */
export type NoticeTone = 'normal' | 'dim' | 'error'

/** The terminal operations the session controller needs from either renderer. */
export interface SessionSurface {
  /** Stop accepting terminal input. */
  close(): void
  /** Draw controller-owned output such as command results. */
  write(text: string, tone?: NoticeTone): void
  /** Refresh the surface after the agent changes between idle and running. */
  setBusy(busy: boolean): void
  /** Restore the ordinary input affordance after a completed action. */
  prompt(): void
  /** Echo a positional first prompt on surfaces where the terminal did not echo it. */
  showFirstPrompt(text: string): void
}

/** Session-scoped effects beyond the Agent handle. */
export interface SessionDriverHooks {
  /** Persist every buffered event before process exit. */
  flush(): Promise<unknown>
  /** Release the input stream's event-loop reference after the surface closes. */
  release(): void
  /** Request process exit after the driver reaches quiescence. */
  exit(code: number): void
  /** Report a durability failure without hiding the requested exit. */
  error(text: string): void
  /** Optional plugin-owned slash-command registry. */
  commands?: {
    list(): readonly CommandDescriptor[]
    execute(line: string): Promise<CommandExecution | undefined>
  }
}

/** Built-in command help shared by both terminal renderers. */
export const COMMANDS = `  /help      show this help
  /model     show the provider route and model this agent uses
  /session   show the session id and working directory
  /exit      flush the session and leave (Ctrl+D at the prompt does the same)
Other /commands dispatch to the plugin command registry (listed below when composed).
While the agent is running: a submitted message steers the nearest step, Ctrl+C cancels the turn.
When the agent asks a question or requests approval, the editor switches to that decision.`

/** Drive one Agent from submitted terminal lines without owning a renderer. */
export class SessionDriver {
  private busy = false
  private closing = false

  constructor(
    private readonly agent: Agent,
    private readonly surface: SessionSurface,
    private readonly hooks: SessionDriverHooks,
  ) {}

  /** Whether a submitted non-command line will steer the active turn. */
  get isBusy(): boolean {
    return this.busy
  }

  /**
   * Begin input, optionally submitting the CLI's positional first prompt.
   * @param firstPrompt - Positional prompt from startup, or an empty string for the editor.
   */
  start(firstPrompt: string): void {
    if (firstPrompt !== '') {
      this.surface.showFirstPrompt(firstPrompt)
      this.submit(firstPrompt)
      return
    }
    this.surface.prompt()
  }

  /**
   * Handle one complete editor/readline submission.
   * @param line - Submitted user text or slash-command line.
   */
  line(line: string): void {
    const text = line.trim()
    if (text === '') {
      if (!this.busy && !this.closing) this.surface.prompt()
      return
    }
    if (text.startsWith('/')) {
      this.command(text)
      return
    }
    if (this.busy) {
      this.agent.steer(this.message(text))
      this.surface.write('(steering queued for the nearest step)', 'dim')
      return
    }
    this.submit(text)
  }

  /** Ctrl+C cancels a running turn and exits only from an idle editor. */
  interrupt(): void {
    if (this.busy) {
      this.agent.cancel({ kind: 'user' })
      return
    }
    this.shutdown(0, false)
  }

  /** Ctrl+D or stdin EOF drains any active turn before leaving. */
  end(): void {
    this.shutdown(0, false)
  }

  private message(text: string) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
  }

  private submit(text: string): void {
    this.busy = true
    this.surface.setBusy(true)
    this.agent.followup(this.message(text))
    void this.agent.whenIdle().then(() => {
      this.busy = false
      this.surface.setBusy(false)
      if (!this.closing) this.surface.prompt()
    })
  }

  private command(line: string): void {
    switch (line.split(/\s/, 1)[0]) {
      case '/help':
        this.help()
        break
      case '/model':
        this.surface.write(`${this.agent.options.provider}/${this.agent.options.model}`)
        break
      case '/session':
        this.surface.write(`${this.agent.session.id}\n${process.cwd()}`)
        break
      case '/exit':
      case '/quit':
        this.shutdown(0, true)
        return
      default:
        this.dispatch(line)
        return
    }
    if (!this.busy) this.surface.prompt()
  }

  private help(): void {
    this.surface.write(COMMANDS)
    const descriptors = this.hooks.commands?.list() ?? []
    if (descriptors.length === 0) return
    this.surface.write('plugin commands:', 'dim')
    for (const descriptor of descriptors) {
      const pad = ' '.repeat(Math.max(1, 10 - descriptor.name.length))
      this.surface.write(`  /${descriptor.name}${pad}${descriptor.description}`, 'dim')
    }
  }

  private dispatch(line: string): void {
    const registry = this.hooks.commands
    if (registry === undefined) {
      this.unknown(line)
      return
    }
    registry.execute(line).then((execution) => {
      if (execution === undefined) {
        this.unknown(line)
        return
      }
      else if (execution.result.kind === 'error') this.surface.write(`✖ ${execution.result.text}`, 'error')
      else if (execution.result.text !== undefined && execution.result.text !== '') {
        this.surface.write(execution.result.text)
      }
      if (!this.busy && !this.closing) this.surface.prompt()
    }, (error: unknown) => {
      this.surface.write(`✖ ${error instanceof Error ? error.message : String(error)}`, 'error')
      if (!this.busy && !this.closing) this.surface.prompt()
    })
  }

  private unknown(line: string): void {
    this.surface.write(`unknown command ${line}; /help lists commands`, 'dim')
    if (!this.busy && !this.closing) this.surface.prompt()
  }

  /** Close input first, then wait for the Agent and durable store before exit. */
  private shutdown(code: number, cancelRunning: boolean): void {
    if (this.closing) return
    this.closing = true
    if (cancelRunning && this.busy) this.agent.cancel({ kind: 'user' })
    this.surface.close()
    this.hooks.release()
    void this.agent.whenIdle()
      .then(() => this.hooks.flush())
      .catch((error: unknown) => {
        this.hooks.error(`dsh: session flush failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
      .finally(() => { this.hooks.exit(code) })
  }
}
