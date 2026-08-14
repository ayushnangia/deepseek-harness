/** REPL loop behavior over a scripted Agent: projection, steering, commands, cancel, and drain-on-exit. */

import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '@earendil-works/pi-tui'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-plan-mode'
import { apply, Config, internals } from '../src/index.ts'

const originalInternals = { ...internals }
const originalNoColor = process.env.NO_COLOR
afterEach(() => {
  Object.assign(internals, originalInternals)
  if (originalNoColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = originalNoColor
})

/** Poll until `condition` holds, yielding to IO between checks. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  if (!condition()) throw new Error('condition not reached')
}

/** What the scripted Agent does when the REPL submits a prompt or cancels. */
interface Script {
  afterPrompt?(session: Session, message: UserMessage): Promise<void> | void
  onCancel?(): void
}

/** Terminal knobs and composed extras for one bench boot. */
interface BenchOptions {
  prompt?: string
  isTTY?: boolean
  interactive?: boolean
  commands?: unknown
}

/** Deterministic terminal boundary for exercising Pi's real renderer and editor. */
class TestTerminal implements Terminal {
  readonly columns = 88
  readonly rows = 30
  readonly kittyProtocolActive = false
  private input: ((data: string) => void) | undefined

  constructor(private readonly output: (chunk: string) => void) {}

  start(onInput: (data: string) => void, _onResize: () => void): void { this.input = onInput }
  stop(): void { this.input = undefined }
  drainInput(): Promise<void> { return Promise.resolve() }
  write(data: string): void { this.output(data) }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}

  send(data: string): void {
    for (const character of data) this.input?.(character === '\n' ? '\r' : character)
  }
}

/** Append one completed turn whose only output is `text` streamed in a single chunk. */
function appendAnswerTurn(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text } })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** One booted REPL over the scripted Agent: streams, observed effects, and the exit settlement. */
interface Driven {
  ctx: Context
  stdin: PassThrough
  out(): string
  err(): string
  exit: Promise<number>
  order: string[]
  prompts: UserMessage[]
  steered: UserMessage[]
  cancelled: unknown[]
  keys(data: string): void
  agent(): Agent
  session(): Session
}

/** Mount the real registries around a scripted Agent factory and boot the runner on captured streams. */
async function bench(script: Script = {}, options: BenchOptions = {}): Promise<Driven> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  const prompts: UserMessage[] = []
  const steered: UserMessage[] = []
  const cancelled: unknown[] = []
  let sessionRef: Session | undefined
  let agentRef: Agent | undefined
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(createOptions.sessionId, {
        ...createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      })
      sessionRef = session
      let idle = Promise.resolve()
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: createOptions.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'idle',
        ctx: agentCtx,
        cancel: (reason: unknown) => { cancelled.push(reason); script.onCancel?.() },
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          prompts.push(message)
          idle = Promise.resolve().then(() => script.afterPrompt?.(session, message)).then(() => undefined)
        },
        steer: (message: UserMessage) => { steered.push(message) },
        inject: () => {},
        whenIdle: () => idle,
      } satisfies Partial<Agent>)
      agentRef = agent
      await createOptions.setup?.(agentCtx)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  if (options.commands !== undefined) ctx.provide('commands', options.commands as never)

  const stdin = new PassThrough()
  let out = ''
  let err = ''
  let terminal: TestTerminal | undefined
  const order: string[] = []
  ctx.on('session/flush', () => { order.push('flush') })
  internals.stdin = Object.assign(stdin, options.interactive === true ? { isTTY: true } : {})
  internals.stdout = Object.assign(
    new Writable({ write: (chunk: unknown, _encoding, callback) => { out += String(chunk); callback() } }),
    options.isTTY === true ? { isTTY: true } : {},
  )
  internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
  internals.interactive = options.interactive
  internals.terminal = () => {
    terminal = new TestTerminal((chunk) => { out += chunk })
    return terminal
  }
  const exit = new Promise<number>((resolve) => {
    ctx.provide('appExit', (code: number) => { order.push('exit'); resolve(code) })
  })
  apply(ctx, { prompt: options.prompt ?? '' })
  return {
    ctx,
    stdin,
    out: () => out,
    err: () => err,
    exit,
    order,
    prompts,
    steered,
    cancelled,
    keys: (data: string) => {
      if (terminal === undefined) throw new Error('interactive terminal not started')
      terminal.send(data)
    },
    agent: () => {
      if (agentRef === undefined) throw new Error('agent not created yet')
      return agentRef
    },
    session: () => {
      if (sessionRef === undefined) throw new Error('agent not created yet')
      return sessionRef
    },
  }
}

describe('tui runner', () => {
  it('uses Pi differential rendering and the bordered editor for a real TTY', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Interactive answer' } })
        session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Interactive answer' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
          usage: { inputTokens: 42, outputTokens: 7 },
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    }, { isTTY: true, interactive: true })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(test.out()).toContain('Shift+Enter newline')
    expect(test.out()).toContain('DeepSeek Harness coding agent')
    expect(test.out()).toContain('test-provider/test-model')
    expect(test.out()).toContain('─'.repeat(20))

    test.keys('hello from editor\n')
    await new Promise(resolve => setTimeout(resolve, 25))
    await until(() => test.out().includes('Interactive answer'))
    expect(test.prompts).toHaveLength(1)
    expect(test.prompts[0]).toMatchObject({
      content: [{ type: 'text', text: 'hello from editor' }],
      source: { kind: 'user' },
    })
    expect(test.out()).toContain('↑42 ↓7')

    test.keys('/exit\n')
    expect(await test.exit).toBe(0)
    expect(test.order).toEqual(['flush', 'exit'])
    await test.ctx.fiber.dispose()
  })

  it('answers tool approvals through the same Pi editor', async () => {
    const test = await bench({}, { isTTY: true, interactive: true })
    await until(() => test.out().includes('Shift+Enter newline'))

    const decision = test.ctx.waterfall(
      'approval/request',
      { agent: test.agent(), toolName: 'bash', reason: 'run the project checks' },
      () => Promise.resolve('unavailable' as const),
    )
    await until(() => test.out().includes('approve once? [y/N]'))
    expect(test.out()).toContain('bash requests approval: run the project checks')

    test.keys('y\n')
    await expect(decision).resolves.toBe('allowed-once')
    test.keys('/exit\n')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('streams a full turn as a projection of committed events and exits on /exit with a drained flush', async () => {
    const test = await bench({
      afterPrompt(session) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'pondering' } })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello ' } })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'world' } })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish' } as unknown as StreamChunk })
        session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'read_file', arguments: '{"path":"a.txt"}' })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId: CallId('call-1'), content: [{ type: 'text', text: 'file body' }], isError: false }),
        }, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Hello world' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
          usage: { inputTokens: 1200, outputTokens: 5 },
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    })
    test.stdin.write('hi\n')
    await until(() => test.out().includes('─ 0.0s'))
    expect(test.prompts).toHaveLength(1)
    expect(test.out()).toContain('dsh · test-provider/test-model')
    expect(test.out()).toContain('/help for commands')
    expect(test.out()).toContain('pondering\n\nHello world\n● read_file {"path":"a.txt"}\n  └ file body\n')
    expect(test.out()).toContain('─ 0.0s · ↑1.2k ↓5')
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    expect(test.order).toEqual(['flush', 'exit'])
    expect(test.err()).toBe('')
    await test.ctx.fiber.dispose()
  })

  it('renders failure results, preview edge shapes, and an error turn', async () => {
    const longArguments = `{"detail":"${'x'.repeat(120)}"}`
    const test = await bench({
      afterPrompt(session) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'run_shell', arguments: longArguments })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId: CallId('call-1'), content: [], isError: false }),
          error: { name: 'ToolError', code: 'E_TOOL' },
        }, { surfaceOp: 'append' })
        session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-2'), name: 'write_file', arguments: '{}' })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId: CallId('call-2'), content: [{ type: 'text', text: 'denied' }], isError: true }),
        }, { surfaceOp: 'append' })
        session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-3'), name: 'quiet_tool', arguments: '{}' })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: CallId('call-3'),
            content: [{ type: 'image' } as never, { type: 'text' } as never, { type: 'tool-result' } as never],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: '' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } } })
      },
    })
    test.stdin.write('go\n')
    await until(() => test.out().includes('✖ SERVER: provider unavailable'))
    expect(test.out()).toContain('● run_shell {"detail":"xxx')
    expect(test.out()).toContain('…')
    expect(test.out()).toContain('  └ E_TOOL\n')
    expect(test.out()).toContain('  └ denied\n')
    expect(test.out()).not.toContain('└ \n')
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('renders plan, compaction, and the remaining turn outcomes', async () => {
    const test = await bench()
    await until(() => test.out().includes('/help for commands'))
    const session = test.session()
    session.append('plan/mode', { active: true })
    session.append('plan/mode', { active: false })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } })
    session.append('turn/start', { turn: 3 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    for (const type of ['compaction/start', 'compaction/summary'] as const) {
      test.ctx.emit('session/event', session, { type, seq: 0, time: Date.now(), data: {} } as unknown as SessionEvent)
    }
    test.ctx.emit(
      'session/event',
      { id: 'foreign-session' } as unknown as Session,
      { type: 'plan/mode', seq: 0, time: Date.now(), data: { active: true } } as unknown as SessionEvent,
    )
    await until(() => test.out().includes('· context compacted'))
    expect(test.out().match(/· plan mode on\n/g)).toHaveLength(1)
    expect(test.out()).toContain('· plan mode on\n')
    expect(test.out()).toContain('· plan mode off\n')
    expect(test.out()).toContain('■ output-token ceiling reached after 0.0s\n')
    expect(test.out()).toContain('■ blocked after 0.0s\n')
    expect(test.out()).toContain('─ 0.0s\n')
    expect(test.out()).toContain('· compacting context…\n')
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('steers while busy, keeps empty lines inert, and reprompts at idle', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await bench({
      async afterPrompt(session) {
        await gate
        appendAnswerTurn(session, 1, 'done')
      },
    })
    test.stdin.write('work on it\n')
    await until(() => test.prompts.length === 1)
    test.stdin.write('\n')
    test.stdin.write('also check the docs\n')
    await until(() => test.steered.length === 1)
    expect(test.out()).toContain('(steering queued for the nearest step)')
    test.stdin.write('/model\n')
    await until(() => (test.out().match(/test-provider\/test-model\n/g) ?? []).length === 2)
    release()
    await until(() => test.out().includes('done'))
    test.stdin.write('\n')
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('serves the built-in commands without a registry and reports unknown slashes', async () => {
    const test = await bench()
    await until(() => test.out().includes('/help for commands'))
    test.stdin.write('/help\n')
    await until(() => test.out().includes('/exit      flush the session and leave'))
    expect(test.out()).not.toContain('plugin commands:')
    test.stdin.write('/model\n')
    await until(() => test.out().includes('› test-provider/test-model\n'))
    test.stdin.write('/session\n')
    await until(() => test.out().includes(String(test.session().id)))
    expect(test.out()).toContain(process.cwd())
    test.stdin.write('/nope\n')
    await until(() => test.out().includes('unknown command /nope; /help lists commands'))
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('dispatches registry commands through every outcome and lists them in /help', async () => {
    const executions: string[] = []
    const commands = {
      list: () => [
        { name: 'plan', description: 'toggle plan mode' },
        { name: 'longcommandname', description: 'tight pad' },
      ],
      execute: (_agent: unknown, line: string) => {
        executions.push(line)
        switch (line) {
          case '/silent': return Promise.resolve({ result: { kind: 'ok', text: '' } })
          case '/notext': return Promise.resolve({ result: { kind: 'ok' } })
          case '/bad': return Promise.resolve({ result: { kind: 'error', text: 'nope' } })
          case '/throw': return Promise.reject(new Error('exploded'))
          case '/rawthrow': return { then: (_resolve: unknown, reject: (reason: unknown) => void) => { reject('raw failure') } }
          case '/ok': return Promise.resolve({ result: { kind: 'ok', text: 'plan set' } })
          default: return Promise.resolve(undefined)
        }
      },
    }
    const test = await bench({}, { commands })
    await until(() => test.out().includes('/help for commands'))
    test.stdin.write('/help\n')
    await until(() => test.out().includes('plugin commands:'))
    expect(test.out()).toContain('  /plan      toggle plan mode')
    expect(test.out()).toContain('  /longcommandname tight pad')
    test.stdin.write('/silent\n/notext\n/bad\n/throw\n/rawthrow\n/mystery\n/ok\n')
    await until(() => test.out().includes('plan set'))
    expect(executions).toEqual(['/silent', '/notext', '/bad', '/throw', '/rawthrow', '/mystery', '/ok'])
    expect(test.out()).toContain('✖ nope\n')
    expect(test.out()).toContain('✖ exploded\n')
    expect(test.out()).toContain('✖ raw failure\n')
    expect(test.out()).toContain('unknown command /mystery; /help lists commands')
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('settles a registry command while the agent is busy without stealing the prompt', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const commands = {
      list: () => [],
      execute: () => Promise.resolve({ result: { kind: 'ok', text: 'ran while busy' } }),
    }
    const test = await bench({
      async afterPrompt(session) {
        await gate
        appendAnswerTurn(session, 1, 'finished')
      },
    }, { commands })
    test.stdin.write('work\n')
    await until(() => test.prompts.length === 1)
    test.stdin.write('/anything\n')
    await until(() => test.out().includes('ran while busy'))
    release()
    await until(() => test.out().includes('finished'))
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('cancels the active turn on /exit and drains it before flushing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await bench({
      async afterPrompt(session) {
        session.append('turn/start', { turn: 1 })
        await gate
        session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      },
      onCancel: () => { release() },
    })
    test.stdin.write('long job\n')
    await until(() => test.prompts.length === 1)
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    expect(test.cancelled).toEqual([{ kind: 'user' }])
    expect(test.out()).toContain('■ interrupted after')
    expect(test.order.at(-1)).toBe('exit')
    expect(test.order).toContain('flush')
    await test.ctx.fiber.dispose()
  })

  it('maps Ctrl+C to cancel while busy and to shutdown at an idle prompt', async () => {
    process.env.NO_COLOR = '1'
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await bench({
      async afterPrompt(session) {
        session.append('turn/start', { turn: 1 })
        await gate
        session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      },
      onCancel: () => { release() },
    }, { isTTY: true })
    test.stdin.write('spin\n')
    await until(() => test.prompts.length === 1)
    test.stdin.write('')
    await until(() => test.out().includes('■ interrupted after'))
    expect(test.cancelled).toEqual([{ kind: 'user' }])
    test.stdin.write('')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('paints with SGR codes when stdout is a color-capable terminal', async () => {
    delete process.env.NO_COLOR
    const test = await bench({}, { isTTY: true })
    await until(() => test.out().includes('dsh'))
    expect(test.out()).toContain('[1mdsh[0m')
    test.stdin.write('/exit\n')
    expect(await test.exit).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('submits the first prompt before reading and drains it when piped stdin ends', async () => {
    const unrefs: number[] = []
    const test = await bench({
      afterPrompt(session) { appendAnswerTurn(session, 1, 'POSITIONAL-OK') },
    }, { prompt: 'do it' })
    Object.assign(test.stdin, { unref: () => unrefs.push(1) })
    test.stdin.end()
    expect(await test.exit).toBe(0)
    expect(test.out()).toContain('› do it\n')
    expect(test.out()).toContain('POSITIONAL-OK')
    expect(test.prompts).toHaveLength(1)
    expect(unrefs).toEqual([1])
    await test.ctx.fiber.dispose()
  })
})

describe('tui runner edges', () => {
  it('reports a direct Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.stdin = new PassThrough()
    internals.stdout = new Writable({ write: (_chunk, _encoding, callback) => { callback() } })
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agents', { create: () => Promise.reject(new Error('factory exploded')) } as never)
    apply(ctx, { prompt: '' })
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('stringifies a non-Error Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.stdin = new PassThrough()
    internals.stdout = new Writable({ write: (_chunk, _encoding, callback) => { callback() } })
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    const rejected = {
      then(_resolve: (value: never) => void, reject: (reason: unknown) => void): void {
        reject('factory exploded')
      },
    }
    ctx.provide('agents', { create: () => rejected } as never)
    apply(ctx, { prompt: '' })
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it.each([
    { label: 'an Error', flush: () => Promise.reject(new Error('disk full')) },
    { label: 'a non-Error', flush: () => ({ then: (_resolve: unknown, reject: (reason: unknown) => void) => { reject('disk full') } }) },
  ])('reports $label flush failure on shutdown and still exits', async ({ flush }) => {
    const ctx = new Context()
    const stdin = new PassThrough()
    let out = ''
    let err = ''
    internals.stdin = stdin
    internals.stdout = new Writable({ write: (chunk: unknown, _encoding, callback) => { out += String(chunk); callback() } })
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush } as never)
    const agent = {
      session: { id: 'flush-fail-session' },
      options: { provider: 'p', model: 'm' },
      whenIdle: () => Promise.resolve(),
    }
    ctx.provide('agents', { create: () => Promise.resolve({ agent }) } as never)
    apply(ctx, { prompt: '' })
    await until(() => out.includes('/help for commands'))
    stdin.write('/exit\n')
    expect(await exited).toBe(0)
    expect(err).toBe('dsh: session flush failed: disk full\n')
    await ctx.fiber.dispose()
  })

  it('abandons a run when the tree is disposed during Loader settlement', async () => {
    const ctx = new Context()
    let exited = false
    internals.stdin = new PassThrough()
    internals.stdout = new Writable({ write: (_chunk, _encoding, callback) => { callback() } })
    internals.stderr = { write: () => true }
    ctx.provide('appExit', () => { exited = true })
    const services = ctx.plugin((child: Context) => {
      child.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
      child.provide('sessions', {} as never)
      child.provide('agents', {} as never)
    })
    await services
    let release!: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('loader', { await: () => settlement } as never)
    apply(ctx, { prompt: '' })
    await services.dispose()
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })

  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, { prompt: '' }) }).toThrow('must provide ctx.appExit')
  })

  it('validates config: the prompt is optional and defaults to empty', () => {
    expect(new Config({} as never)).toEqual({ prompt: '' })
    expect(new Config({ prompt: 'run the tests' })).toEqual({ prompt: 'run the tests' })
  })
})
