/**
 * @deepseek-ai/dsh-tui — interactive terminal REPL over the direct Agent
 * driver. The bundle patch rides over dsh-base without Host, HTTP, or browser
 * plugins; this runner creates one Agent through the core registry, streams
 * its session events to the terminal as they commit, and reads prompts from
 * stdin until the user exits.
 *
 * Rendering is a projection of the durable session log: every line the
 * terminal shows comes from a committed `session/event`, so the display can
 * never disagree with what persistence stored.
 *
 * Terminal behavior while a turn is running: a typed line becomes steering
 * for the nearest step (`agent.steer`), Ctrl+C cancels the active turn, and
 * the prompt returns at quiescence. At an idle prompt, Ctrl+C and Ctrl+D end
 * the session after a final flush.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands'
import { Prompter, installInteraction } from './prompter.ts'
// Empty type imports carry the loader Context merge for the settlement await,
// the cmdline Context merge for the appExit host value, the commands Context
// merge for the registry dispatch, and the plan-mode/compaction SessionEventMap
// merges for their notice lines.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-compaction'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the optional first prompt resolved from this app's injected provider service. */
export interface Config {
  /** The first prompt to submit before reading terminal input; empty means none. */
  prompt: string
}

export const Config: z<Config> = z.object({
  prompt: z.string().default(''),
})

/** Process-facing effects of one session: terminal streams plus the launcher's bounded exit request. */
interface TuiIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner reads and writes; tests substitute captures. */
export const internals: {
  /** Readline input. `unref` is present on socket stdin (pipe/TTY parents) and absent for file redirects. */
  stdin: NodeJS.ReadableStream & { unref?(): void }
  /** Readline echo target and the renderer's stream; `isTTY` gates the color palette. */
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
  stderr: TuiIo['stderr']
} = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}

/** One ANSI SGR painter; identity when the stream is not an interactive terminal or NO_COLOR is set. */
type Paint = (text: string) => string

/** The painters the renderer draws with. */
interface Palette {
  dim: Paint
  bold: Paint
  cyan: Paint
  yellow: Paint
  red: Paint
}

/**
 * Build the palette for the runner's stdout.
 * @returns SGR-wrapping painters, or identity painters when color is unavailable or refused.
 */
function palette(): Palette {
  const enabled = (internals.stdout.isTTY ?? false) && (process.env.NO_COLOR ?? '') === ''
  const paint = (code: string): Paint => enabled
    ? text => `\u001B[${code}m${text}\u001B[0m`
    : text => text
  return { dim: paint('2'), bold: paint('1'), cyan: paint('36'), yellow: paint('33'), red: paint('31') }
}

/** What kind of streamed output the cursor currently sits after, within one turn. */
type StreamedKind = 'none' | 'text' | 'reasoning'

/** Squash a value onto one bounded line for inline previews. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The structural slice of a content block that previews read. */
interface PreviewBlock {
  readonly type: string
  readonly text?: string
  readonly content?: readonly PreviewBlock[]
  readonly isError?: boolean
}

/** Join the text blocks of a message content array, unwrapping tool-result wrappers. */
function textOf(content: readonly PreviewBlock[]): string {
  return content.map(block =>
    block.type === 'text' ? block.text ?? ''
      : block.type === 'tool-result' ? textOf(block.content ?? [])
        : '').join('')
}

/** Whether any tool-result wrapper in the content marks a failed call. */
function isErrorResult(content: readonly PreviewBlock[]): boolean {
  return content.some(block => block.type === 'tool-result' && block.isError === true)
}

/** Render token counts as a compact `1.2k` style figure. */
function figure(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

/**
 * The live event renderer for one agent's session: a stateful projection of
 * the committed log onto the terminal. Chunk deltas stream as they arrive;
 * boundary events draw the tool and status lines around them.
 */
class Renderer {
  private streamed: StreamedKind = 'none'
  private turnStartedAt = 0
  private inputTokens = 0
  private outputTokens = 0

  constructor(private readonly io: TuiIo, private readonly ui: Palette) {}

  /** Close any open streamed run so the next write starts at column zero. */
  private break_(): void {
    if (this.streamed !== 'none') this.io.stdout.write('\n')
    this.streamed = 'none'
  }

  /** Project one committed session event onto the terminal. */
  render(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        this.turnStartedAt = event.time
        this.inputTokens = 0
        this.outputTokens = 0
        return
      }
      case 'assistant/chunk': {
        this.chunk(event.data.chunk)
        return
      }
      case 'tool/call': {
        this.break_()
        this.io.stdout.write(`${this.ui.yellow('●')} ${this.ui.bold(event.data.name)} ${this.ui.dim(oneLine(event.data.arguments, 80))}\n`)
        return
      }
      case 'tool/result': {
        this.break_()
        const failure = event.data.error
        if (failure !== undefined) {
          this.io.stdout.write(`  ${this.ui.red(`└ ${failure.code}`)}\n`)
          return
        }
        const preview = oneLine(textOf(event.data.message.content), 100)
        if (preview === '') return
        const paint = isErrorResult(event.data.message.content) ? this.ui.red : this.ui.dim
        this.io.stdout.write(`  ${paint(`└ ${preview}`)}\n`)
        return
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage !== undefined) {
          this.inputTokens += usage.inputTokens
          this.outputTokens += usage.outputTokens
        }
        return
      }
      case 'turn/end': {
        this.break_()
        this.status(event)
        return
      }
      case 'plan/mode': {
        this.break_()
        this.io.stdout.write(this.ui.dim(`· plan mode ${event.data.active ? 'on' : 'off'}\n`))
        return
      }
      case 'compaction/start': {
        this.break_()
        this.io.stdout.write(this.ui.dim('· compacting context…\n'))
        return
      }
      case 'compaction/summary': {
        this.break_()
        this.io.stdout.write(this.ui.dim('· context compacted\n'))
        return
      }
      default:
        // The log is merge-extensible; events this surface does not draw
        // (chunk rows, request headers, todos, …) simply do not render.
        return
    }
  }

  /** Stream one raw model chunk: text verbatim, reasoning dimmed, the rest silent. */
  private chunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text-delta': {
        if (this.streamed === 'reasoning') this.io.stdout.write('\n\n')
        this.io.stdout.write(chunk.text)
        this.streamed = 'text'
        return
      }
      case 'reasoning-delta': {
        this.io.stdout.write(this.ui.dim(chunk.text))
        this.streamed = 'reasoning'
        return
      }
      default:
        // Tool-call deltas render once assembled (the `tool/call` event);
        // block boundaries, usage, and finish carry no terminal ink.
        return
    }
  }

  /** Draw the one-line turn summary under the turn's output. */
  private status(event: SessionEvent<'turn/end'>): void {
    const elapsed = ((event.time - this.turnStartedAt) / 1000).toFixed(1)
    const tokens = this.inputTokens + this.outputTokens > 0
      ? ` · ↑${figure(this.inputTokens)} ↓${figure(this.outputTokens)}`
      : ''
    const reason = event.data.reason
    switch (reason.kind) {
      case 'completed':
        this.io.stdout.write(this.ui.dim(`─ ${elapsed}s${tokens}\n`))
        return
      case 'aborted':
        this.io.stdout.write(this.ui.dim(`■ interrupted after ${elapsed}s${tokens}\n`))
        return
      case 'error':
        this.io.stdout.write(this.ui.red(`✖ ${reason.error.code}: ${reason.error.message}\n`))
        return
      case 'max-tokens':
        this.io.stdout.write(this.ui.yellow(`■ output-token ceiling reached after ${elapsed}s${tokens}\n`))
        return
      default:
        // Merge-extensible reasons fall through to their tag.
        this.io.stdout.write(this.ui.dim(`■ ${reason.kind} after ${elapsed}s${tokens}\n`))
        return
    }
  }
}

/** The REPL's slash-command help, shown by `/help` and on unknown commands. */
const COMMANDS = `  /help      show this help
  /model     show the provider route and model this agent uses
  /session   show the session id and working directory
  /exit      flush the session and leave (Ctrl+D at the prompt does the same)
Other /commands dispatch to the plugin command registry (listed below when composed).
While the agent is running: a typed line steers the nearest step, Ctrl+C cancels the turn.
When the agent asks a question or requests approval, the prompt switches to that decision.`

/**
 * Run the interactive session over a freshly created Agent and request
 * process exit when the user leaves.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param firstPrompt - a prompt to submit before reading terminal input; empty means none.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, firstPrompt: string, io: TuiIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer (same stance as
  // the one-shot bundle).
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  await agent.whenIdle()

  const ui = palette()
  const renderer = new Renderer(io, ui)
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (session.id !== agent.session.id) return
    renderer.render(event)
  })

  io.stdout.write(`${ui.bold('dsh')} ${ui.dim('·')} ${selection.provider}/${selection.model}\n`)
  io.stdout.write(ui.dim(`${process.cwd()} · /help for commands\n\n`))

  const rl = createInterface({ input: internals.stdin, output: internals.stdout, prompt: ui.cyan('› '), historySize: 500 })

  // This terminal is the deployment's interaction surface: ask_user_question,
  // plan review, and tool approvals prompt through the same readline.
  const prompter = new Prompter(rl, { stdout: io.stdout, dim: ui.dim, bold: ui.bold, cyan: ui.cyan, yellow: ui.yellow })
  installInteraction(ctx, agent, prompter)

  const commandRuntime = ctx.get('commands')
  loop(agent, rl, io, ui, {
    firstPrompt,
    flush: () => sessions.flush(agent.session),
    release: () => { internals.stdin.unref?.() },
    ...commandRuntime === undefined ? {} : {
      commands: {
        list: () => commandRuntime.list(agent),
        // The REPL has no per-command cancellation surface; the signal never fires.
        execute: line => commandRuntime.execute(agent, line, new AbortController().signal),
      },
    },
  })
}

/** The loop's session-scoped effects beyond the agent handle itself. */
interface LoopHooks {
  /** A prompt to submit before the first read; empty means none. */
  firstPrompt: string
  /** Flush the session's buffered events to durable storage. */
  flush(): Promise<unknown>
  /**
   * Drop the REPL's event-loop reference on its input stream. The launcher's
   * completed shutdown ends the process by draining the loop, not by
   * `process.exit`, so a still-open piped stdin would otherwise hold the
   * process alive forever after `/exit`.
   */
  release(): void
  /** The registry dispatch for plugin-owned slash commands; absent when the deployment composes none. */
  commands?: {
    /** Name-sorted descriptors of the commands this agent can run. */
    list(): readonly CommandDescriptor[]
    /** Run one slash-command line; `undefined` means unknown name or invalid syntax. */
    execute(line: string): Promise<CommandExecution | undefined>
  }
}

/**
 * Wire the readline loop over one live agent. Split from {@link run} so the
 * event handlers close over exactly the state they own.
 * @param agent - the live agent this terminal drives.
 * @param rl - the readline interface owning stdin.
 * @param io - process-facing effects.
 * @param ui - the terminal palette.
 * @param hooks - first prompt and the durability flush.
 */
function loop(agent: Agent, rl: Interface, io: TuiIo, ui: Palette, hooks: LoopHooks): void {
  let busy = false
  let closing = false

  // Drains the active turn before flushing, so piped stdin behaves as a
  // one-shot: the prompt streams its full response before the process exits.
  // Immediate exits (/exit, /quit) cancel the turn first, making the drain a no-op.
  const shutdown = (code: number): void => {
    if (closing) return
    closing = true
    rl.close()
    hooks.release()
    void agent.whenIdle()
      .then(() => hooks.flush())
      .catch((error: unknown) => {
        io.stderr.write(`dsh: session flush failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
      .finally(() => { io.exit(code) })
  }

  const submit = (text: string): void => {
    busy = true
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    void agent.whenIdle().then(() => {
      busy = false
      if (!closing) rl.prompt()
    })
  }

  // Registry commands (e.g. /plan, /compact, /feedback) settle asynchronously;
  // the prompt returns when the result renders, matching the built-in flow.
  const dispatch = (line: string): void => {
    const reprompt = (): void => { if (!busy && !closing) rl.prompt() }
    const registry = hooks.commands
    if (registry === undefined) {
      io.stdout.write(ui.dim(`unknown command ${line}; /help lists commands\n`))
      reprompt()
      return
    }
    registry.execute(line).then((execution) => {
      if (execution === undefined) {
        io.stdout.write(ui.dim(`unknown command ${line}; /help lists commands\n`))
      } else if (execution.result.kind === 'error') {
        io.stdout.write(ui.red(`✖ ${execution.result.text}\n`))
      } else if (execution.result.text !== undefined && execution.result.text !== '') {
        io.stdout.write(`${execution.result.text}\n`)
      }
      reprompt()
    }, (error: unknown) => {
      io.stdout.write(ui.red(`✖ ${error instanceof Error ? error.message : String(error)}\n`))
      reprompt()
    })
  }

  const command = (line: string): void => {
    switch (line.split(/\s/, 1)[0]) {
      case '/help': {
        io.stdout.write(COMMANDS + '\n')
        const descriptors = hooks.commands?.list() ?? []
        if (descriptors.length > 0) {
          io.stdout.write(ui.dim('plugin commands:\n'))
          for (const descriptor of descriptors) {
            const pad = ' '.repeat(Math.max(1, 10 - descriptor.name.length))
            io.stdout.write(`  /${descriptor.name}${pad}${ui.dim(descriptor.description)}\n`)
          }
        }
        break
      }
      case '/model':
        io.stdout.write(`${agent.options.provider}/${agent.options.model}\n`)
        break
      case '/session':
        io.stdout.write(`${agent.session.id}\n${process.cwd()}\n`)
        break
      case '/exit':
      case '/quit':
        if (busy) agent.cancel({ kind: 'user' })
        shutdown(0)
        return
      default:
        dispatch(line)
        return
    }
    if (!busy) rl.prompt()
  }

  rl.on('line', (line: string) => {
    const text = line.trim()
    if (text === '') {
      if (!busy && !closing) rl.prompt()
      return
    }
    if (text.startsWith('/')) {
      command(text)
      return
    }
    if (busy) {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      io.stdout.write(ui.dim('(steering queued for the nearest step)\n'))
      return
    }
    submit(text)
  })

  rl.on('SIGINT', () => {
    if (busy) {
      agent.cancel({ kind: 'user' })
      return
    }
    io.stdout.write('\n')
    shutdown(0)
  })

  // Ctrl+D at the prompt, or the input stream ending (piped stdin drained).
  rl.on('close', () => { shutdown(0) })

  if (hooks.firstPrompt !== '') {
    io.stdout.write(`${ui.cyan('› ')}${hooks.firstPrompt}\n`)
    submit(hooks.firstPrompt)
    return
  }
  rl.prompt()
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: TuiIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated first-prompt config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config.prompt, io).catch((error: unknown) => { fail(io, error) })
}
