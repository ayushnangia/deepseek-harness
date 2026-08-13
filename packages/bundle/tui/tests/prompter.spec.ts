/** Serialized terminal prompting: answer decoding, abort withdrawal, approval outcomes, and interaction registration. */

import { PassThrough } from 'node:stream'
import { createInterface, type Interface } from 'node:readline'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionItem, AskUserQuestionRequest, UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import { decodeAnswer, installInteraction, Prompter, type PrompterUi } from '../src/prompter.ts'

/** One pending readline.question wait: its rendered query and the answer callback. */
interface PendingRead {
  query: string
  answer(line: string): void
}

/** Build a Prompter over a hand-answered readline stand-in with captured output. */
function bench(): {
  prompter: Prompter
  pending: PendingRead[]
  out(): string
  tick(): Promise<void>
} {
  const pending: PendingRead[] = []
  const rl = {
    question: (query: string, optionsOrCallback: unknown, callback?: (answer: string) => void) => {
      const answer = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (answer: string) => void
        : callback
      if (answer === undefined) throw new Error('question callback is required')
      pending.push({ query, answer })
    },
  } as unknown as Interface
  let out = ''
  const identity = (text: string): string => text
  const ui: PrompterUi = {
    stdout: { write: (chunk: string) => { out += chunk } },
    dim: identity,
    bold: identity,
    cyan: identity,
    yellow: identity,
  }
  return {
    prompter: new Prompter(rl, ui),
    pending,
    out: () => out,
    tick: () => new Promise(resolve => setImmediate(resolve)),
  }
}

const question = (item: Partial<AskUserQuestionItem>): AskUserQuestionItem => ({
  id: 'q1',
  question: 'Which way?',
  ...item,
})

describe('decodeAnswer', () => {
  it('preserves an empty line as skipped', () => {
    expect(decodeAnswer(question({}), '')).toEqual({ id: 'q1', selected: [] })
  })

  it('selects by option number and by exact label', () => {
    const item = question({ options: [{ label: 'alpha' }, { label: 'beta' }] })
    expect(decodeAnswer(item, '2')).toEqual({ id: 'q1', selected: ['beta'] })
    expect(decodeAnswer(item, 'alpha')).toEqual({ id: 'q1', selected: ['alpha'] })
  })

  it('treats an out-of-range number as custom text and overrides single-select selection', () => {
    const item = question({ options: [{ label: 'alpha' }] })
    expect(decodeAnswer(item, '9')).toEqual({ id: 'q1', selected: [], custom: '9' })
  })

  it('splits multi-select tokens, dropping blanks and joining customs', () => {
    const item = question({ multiSelect: true, options: [{ label: 'alpha' }, { label: 'beta' }] })
    expect(decodeAnswer(item, '1, , beta, extra idea')).toEqual({
      id: 'q1',
      selected: ['alpha', 'beta'],
      custom: 'extra idea',
    })
  })

  it('keeps a fully-recognized multi-select answer free of custom text', () => {
    const item = question({ multiSelect: true, options: [{ label: 'alpha' }, { label: 'beta' }] })
    expect(decodeAnswer(item, '1,2')).toEqual({ id: 'q1', selected: ['alpha', 'beta'] })
  })
})

describe('Prompter questions', () => {
  it('renders header, detail, options, and plan-review hint, then decodes the read line', async () => {
    const test = bench()
    const request: AskUserQuestionRequest = {
      questions: [question({
        header: 'Pick',
        detail: 'more context',
        options: [{ label: 'alpha', description: 'first' }, { label: 'beta' }],
        intent: { kind: 'plan-review', approve: 'alpha' },
      })],
    }
    const asked = test.prompter.askQuestions(request)
    await test.tick()
    expect(test.out()).toContain('[Pick]')
    expect(test.out()).toContain('? Which way?')
    expect(test.out()).toContain('more context')
    expect(test.out()).toContain('1) alpha — first')
    expect(test.out()).toContain('2) beta')
    expect(test.out()).toContain('(choosing "alpha" approves the plan)')
    expect(test.pending[0]?.query).toBe('number or text › ')
    test.pending[0]?.answer('2')
    expect(await asked).toEqual({ answers: [{ id: 'q1', selected: ['beta'] }] })
  })

  it('hints the multi-select and option-less encodings', async () => {
    const test = bench()
    const asked = test.prompter.askQuestions({
      questions: [
        question({ multiSelect: true, options: [{ label: 'alpha' }] }),
        question({ id: 'q2' }),
      ],
    })
    await test.tick()
    expect(test.pending[0]?.query).toBe('numbers (comma-separated) or text › ')
    test.pending[0]?.answer('1')
    await test.tick()
    expect(test.pending[1]?.query).toBe('answer › ')
    test.pending[1]?.answer('free text')
    expect(await asked).toEqual({
      answers: [
        { id: 'q1', selected: ['alpha'] },
        { id: 'q2', selected: [], custom: 'free text' },
      ],
    })
  })

  it('serializes parallel asks over the one readline', async () => {
    const test = bench()
    const first = test.prompter.askQuestions({ questions: [question({})] })
    const second = test.prompter.askQuestions({ questions: [question({ id: 'q2', question: 'Second?' })] })
    await test.tick()
    expect(test.pending).toHaveLength(1)
    expect(test.out()).not.toContain('Second?')
    test.pending.shift()?.answer('one')
    await test.tick()
    expect(test.out()).toContain('Second?')
    test.pending.shift()?.answer('two')
    expect(await first).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'one' }] })
    expect(await second).toEqual({ answers: [{ id: 'q2', selected: [], custom: 'two' }] })
  })

  it('withdraws on an already-aborted request and keeps the queue serving later asks', async () => {
    const test = bench()
    const controller = new AbortController()
    controller.abort()
    await expect(test.prompter.askQuestions({ questions: [question({})], signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const next = test.prompter.askQuestions({ questions: [question({ id: 'q2' })] })
    await test.tick()
    test.pending.shift()?.answer('still served')
    expect(await next).toEqual({ answers: [{ id: 'q2', selected: [], custom: 'still served' }] })
  })

  it('withdraws a wait when the signal aborts mid-question', async () => {
    const test = bench()
    const controller = new AbortController()
    const asked = test.prompter.askQuestions({ questions: [question({})], signal: controller.signal })
    await test.tick()
    expect(test.pending).toHaveLength(1)
    controller.abort()
    await expect(asked).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('removes an aborted real readline question so the next line returns to the REPL', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const rl = createInterface({ input, output })
    const identity = (text: string): string => text
    const prompter = new Prompter(rl, {
      stdout: { write: () => true },
      dim: identity,
      bold: identity,
      cyan: identity,
      yellow: identity,
    })
    const lines: string[] = []
    rl.on('line', line => lines.push(line))
    const controller = new AbortController()
    const asked = prompter.askQuestions({ questions: [question({})], signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await expect(asked).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    input.write('after abort\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(lines).toEqual(['after abort'])
    rl.close()
  })

  it('rejects when readline closes before it can accept the question', async () => {
    const identity = (text: string): string => text
    const rl = {
      question: () => { throw new Error('readline closed') },
    } as unknown as Interface
    const prompter = new Prompter(rl, {
      stdout: { write: () => true },
      dim: identity,
      bold: identity,
      cyan: identity,
      yellow: identity,
    })
    await expect(prompter.askQuestions({ questions: [question({})] }))
      .rejects.toThrow('readline closed')
  })

  it('normalizes a non-Error readline failure', async () => {
    const identity = (text: string): string => text
    const failure: unknown = 'readline closed'
    const rl = {
      question: () => { throw failure },
    } as unknown as Interface
    const prompter = new Prompter(rl, {
      stdout: { write: () => true },
      dim: identity,
      bold: identity,
      cyan: identity,
      yellow: identity,
    })
    await expect(prompter.askQuestions({ questions: [question({})] }))
      .rejects.toEqual(new Error('readline closed'))
  })
})

describe('Prompter approvals', () => {
  const approval = (over: Partial<ApprovalRequest>): ApprovalRequest => ({
    agent: { session: { id: 'own-session' } } as Agent,
    toolName: 'write_file',
    ...over,
  })

  it('maps an explicit yes to allowed-once and anything else to rejected', async () => {
    const test = bench()
    const yes = test.prompter.askApproval(approval({ reason: 'writes outside the workspace' }))
    await test.tick()
    expect(test.out()).toContain('⚑ write_file requests approval: writes outside the workspace')
    expect(test.pending[0]?.query).toBe('approve once? [y/N] › ')
    test.pending.shift()?.answer('YES')
    expect(await yes).toBe('allowed-once')

    const no = test.prompter.askApproval(approval({}))
    await test.tick()
    expect(test.out()).toContain('⚑ write_file requests approval\n')
    test.pending.shift()?.answer('nah')
    expect(await no).toBe('rejected')
  })

  it('cancels on an aborted signal before and during the wait', async () => {
    const test = bench()
    const preAborted = new AbortController()
    preAborted.abort()
    expect(await test.prompter.askApproval(approval({ signal: preAborted.signal }))).toBe('cancelled')

    const controller = new AbortController()
    const pending = test.prompter.askApproval(approval({ signal: controller.signal }))
    await test.tick()
    controller.abort()
    expect(await pending).toBe('cancelled')
  })
})

describe('installInteraction', () => {
  const ownAgent = { session: { id: 'own-session' } } as Agent

  it('answers approvals for its own agent and delegates foreign agents down the waterfall', async () => {
    const test = bench()
    const ctx = new Context()
    installInteraction(ctx, ownAgent, test.prompter)

    const own = ctx.waterfall(
      'approval/request',
      { agent: ownAgent, toolName: 'write_file' } as ApprovalRequest,
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    await test.tick()
    test.pending.shift()?.answer('y')
    expect(await own).toBe('allowed-once')

    const foreign = await ctx.waterfall(
      'approval/request',
      { agent: { session: { id: 'other-session' } } as Agent, toolName: 'write_file' } as ApprovalRequest,
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    expect(foreign).toBe('unavailable')
    await ctx.fiber.dispose()
  })

  it('registers the user-questions provider as an effect and removes it on dispose', async () => {
    const test = bench()
    const ctx = new Context()
    let provider: UserQuestionProvider | undefined
    const removals: string[] = []
    ctx.provide('userQuestions', {
      registerProvider: (candidate: UserQuestionProvider) => {
        provider = candidate
        return () => { removals.push('provider') }
      },
    } as never)
    const fiber = await ctx.plugin((child: Context) => {
      installInteraction(child, ownAgent, test.prompter)
    })
    expect(provider).toBeDefined()

    const asked = provider!.ask({ questions: [question({})] })
    await test.tick()
    test.pending.shift()?.answer('via provider')
    expect(await asked).toEqual({ answers: [{ id: 'q1', selected: [], custom: 'via provider' }] })

    await fiber.dispose()
    expect(removals).toEqual(['provider'])
    await ctx.fiber.dispose()
  })
})
