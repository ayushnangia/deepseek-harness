/**
 * @deepseek-ai/dsh-tui — interactive terminal application over the direct
 * Agent driver. A real TTY gets a Pi component tree with differential
 * rendering and a multiline editor; pipes and redirects get an append-only
 * readline transcript. Both modes drive the same Agent and session log.
 *
 * Conversation rows project the durable session log; header, footer,
 * commands, and interaction prompts remain presentation-only. Both renderers
 * therefore show the same model-visible conversation and lifecycle facts.
 *
 * Submitted text during a turn becomes steering for the nearest step
 * (`agent.steer`). Ctrl+C cancels active work; Ctrl+D drains it. Idle exit
 * waits for the Agent, flushes the session, and restores terminal state.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRegistry, CreateAgentOptions, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { Prompter, installInteraction } from './prompter.ts'
import { InteractiveSession } from './interactive.ts'
import { figure, isErrorResult, oneLine, textOf } from './render-utils.ts'
import {
  SessionDriver,
  type NoticeTone,
  type SessionDriverHooks,
  type SessionSurface,
} from './session-driver.ts'
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
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; unref?(): void }
  /** Readline echo target and the renderer's stream; `isTTY` gates the color palette. */
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
  stderr: TuiIo['stderr']
  /** Construct the Pi terminal adapter after the runner selects interactive mode. */
  terminal(): Terminal
  /** Test-only mode override; `undefined` selects from the real stream capabilities. */
  interactive: boolean | undefined
} = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  terminal: () => new ProcessTerminal(),
  interactive: undefined,
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
  userMessage: Paint
}

/** Whether this process-facing output supports terminal color. */
function colorEnabled(): boolean {
  return (internals.stdout.isTTY ?? false) && (process.env.NO_COLOR ?? '') === ''
}

/**
 * Build the palette for the runner's stdout.
 * @returns SGR-wrapping painters, or identity painters when color is unavailable or refused.
 */
function palette(): Palette {
  const enabled = colorEnabled()
  const paint = (code: string): Paint => enabled
    ? text => `\u001B[${code}m${text}\u001B[0m`
    : text => text
  const background = Number(process.env.COLORFGBG?.split(';').at(-1))
  const lightBackground = Number.isFinite(background) && background >= 7
  const userMessage = enabled
    ? paint(lightBackground ? '48;5;254;30' : '48;5;236;37')
    : (text: string): string => text
  return { dim: paint('2'), bold: paint('1'), cyan: paint('36'), yellow: paint('33'), red: paint('31'), userMessage }
}

/** What kind of streamed output the cursor currently sits after, within one turn. */
type StreamedKind = 'none' | 'text' | 'reasoning'


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

function tuiAgentRequest(selection: NonNullable<ModelSelectionRef['current']>): CreateAgentOptions {
  return {
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  }
}

async function createTuiAgent(agents: AgentRegistry, selection: NonNullable<ModelSelectionRef['current']>): Promise<Agent> {
  const handle = await agents.create(tuiAgentRequest(selection))
  await handle.agent.whenIdle()
  return handle.agent
}

/** Readline-backed surface for pipes, redirects, dumb terminals, and snapshots. */
class PlainSurface implements SessionSurface {
  constructor(
    private readonly rl: Interface,
    private readonly io: TuiIo,
    private readonly ui: Palette,
  ) {}

  close(): void {
    this.rl.close()
  }

  write(text: string, tone: NoticeTone = 'normal'): void {
    const paint = tone === 'dim' ? this.ui.dim : tone === 'error' ? this.ui.red : (value: string): string => value
    this.io.stdout.write(`${paint(text)}\n`)
  }

  setBusy(_busy: boolean): void {}

  prompt(): void {
    this.rl.prompt()
  }

  showFirstPrompt(text: string): void {
    this.io.stdout.write(`${this.ui.cyan('› ')}${text}\n`)
  }
}

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
  const runtime = {
    agentRegistry: ctx.get('agents'),
    modelDefaults: ctx.get('agentDefaultModel'),
    sessionStore: ctx.get('sessions'),
  }
  // Early process shutdown can dispose the tree while settlement is pending.
  if (runtime.agentRegistry === undefined || runtime.modelDefaults === undefined || runtime.sessionStore === undefined) return
  const { agentRegistry, modelDefaults, sessionStore } = runtime

  const selection = modelDefaults.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer (same stance as
  // the one-shot bundle).
  const agent = await createTuiAgent(agentRegistry, selection)

  const ui = palette()
  const commandRuntime = ctx.get('commands')
  const hooks: SessionDriverHooks = {
    flush: () => sessionStore.flush(agent.session),
    release: () => { internals.stdin.unref?.() },
    exit: (code: number) => { io.exit(code) },
    error: (text: string) => { io.stderr.write(text) },
    ...commandRuntime === undefined ? {} : {
      commands: {
        list: () => commandRuntime.list(agent),
        // Slash commands expose no separate cancellation control in either terminal renderer.
        execute: line => commandRuntime.execute(agent, line, new AbortController().signal),
      },
    },
  }

  const interactive = internals.interactive ?? (internals.stdin.isTTY === true
    && internals.stdout.isTTY === true
    && process.env.TERM !== 'dumb')
  if (interactive) {
    const surface = new InteractiveSession({
      terminal: internals.terminal(),
      provider: selection.provider,
      model: selection.model,
      sessionId: String(agent.session.id),
      cwd: process.cwd(),
      palette: ui,
      color: colorEnabled(),
      commands: [
        { name: 'help', description: 'show commands and keyboard help' },
        { name: 'model', description: 'show the active provider and model' },
        { name: 'session', description: 'show the session id and working directory' },
        { name: 'exit', description: 'flush the session and leave' },
        ...(commandRuntime?.list(agent) ?? []),
      ],
    })
    const driver = new SessionDriver(agent, surface, hooks)
    surface.attach(driver)
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (session.id === agent.session.id) surface.render(event)
    })
    installInteraction(ctx, agent, new Prompter(surface, surface.prompterUi))
    ctx.effect(() => () => { surface.close() }, 'tui-runner: interactive terminal')
    surface.start()
    driver.start(firstPrompt)
    return
  }

  const renderer = new Renderer(io, ui)
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (session.id === agent.session.id) renderer.render(event)
  })
  io.stdout.write(`${ui.bold('dsh')} ${ui.dim('·')} ${selection.provider}/${selection.model}\n`)
  io.stdout.write(ui.dim(`${process.cwd()} · /help for commands\n\n`))
  const rl = createInterface({ input: internals.stdin, output: internals.stdout, prompt: ui.cyan('› '), historySize: 500 })
  const surface = new PlainSurface(rl, io, ui)
  const driver = new SessionDriver(agent, surface, hooks)
  installInteraction(ctx, agent, new Prompter(rl, {
    stdout: io.stdout,
    dim: ui.dim,
    bold: ui.bold,
    cyan: ui.cyan,
    yellow: ui.yellow,
  }))
  rl.on('line', (line) => { driver.line(line) })
  rl.on('SIGINT', () => { driver.interrupt() })
  rl.on('close', () => { driver.end() })
  driver.start(firstPrompt)
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
