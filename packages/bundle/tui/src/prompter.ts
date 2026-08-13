/**
 * Terminal prompting for out-of-band human decisions: user questions
 * (`ask_user_question`, plan review) and one-shot tool approvals. Prompts are
 * serialized over the REPL's shared readline so parallel asks never
 * interleave, and every wait withdraws on its request's abort signal.
 *
 * `readline.question` routes the next input line to its own callback instead
 * of the REPL's `line` listener, so a pending prompt cannot be misread as
 * steering input.
 *
 * @module @deepseek-ai/dsh-tui/src/prompter
 */

import type { Interface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/** The output stream and painters the prompter draws with (structural slice of the runner's palette). */
export interface PrompterUi {
  stdout: { write(chunk: string): unknown }
  dim(text: string): string
  bold(text: string): string
  cyan(text: string): string
  yellow(text: string): string
}

/**
 * Decode one raw input line into the question's answer encoding: option
 * numbers or exact labels select, anything else is custom text, and an empty
 * line preserves the question as skipped (`selected: []`).
 * @param item - the question the line answers.
 * @param line - the trimmed raw input line.
 * @returns the answer item in the seam's encoding.
 */
export function decodeAnswer(item: AskUserQuestionItem, line: string): AskUserQuestionAnswerItem {
  if (line === '') return { id: item.id, selected: [] }
  const options = item.options ?? []
  const tokens = item.multiSelect === true
    ? line.split(',').map(token => token.trim()).filter(token => token !== '')
    : [line]
  const selected: string[] = []
  const custom: string[] = []
  for (const token of tokens) {
    const index = /^\d+$/.test(token) ? Number(token) : Number.NaN
    const byNumber = Number.isInteger(index) ? options[index - 1] : undefined
    if (byNumber !== undefined) selected.push(byNumber.label)
    else if (options.some(option => option.label === token)) selected.push(token)
    else custom.push(token)
  }
  // Single-select contract: custom text overrides and `selected` stays empty.
  if (item.multiSelect !== true && custom.length > 0) {
    return { id: item.id, selected: [], custom: custom.join(', ') }
  }
  return { id: item.id, selected, ...custom.length > 0 ? { custom: custom.join(', ') } : {} }
}

/** Serialized out-of-band prompting over the REPL's readline. */
export class Prompter {
  /** Tail of the prompt queue; each ask chains behind the previous settlement. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly rl: Interface, private readonly ui: PrompterUi) {}

  /** Chain one prompting job behind every earlier one, regardless of their outcomes. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Read one input line for `query`.
   * @param query - the prompt string readline displays.
   * @param signal - withdraws the wait; an aborted read resolves `undefined`.
   * @returns the trimmed line, or `undefined` when the wait was withdrawn.
   */
  private read(query: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        resolve(undefined)
        return
      }
      const onAbort = (): void => { resolve(undefined) }
      signal?.addEventListener('abort', onAbort, { once: true })
      const onAnswer = (answer: string): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(answer.trim())
      }
      try {
        if (signal === undefined) this.rl.question(query, onAnswer)
        else this.rl.question(query, { signal }, onAnswer)
      } catch (error: unknown) {
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Ask the user-questions request through the terminal, one question at a time.
   * @param request - the seam's question batch with its abort signal.
   * @returns the batch answer in the seam's encoding.
   */
  askQuestions(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    return this.enqueue(async () => {
      const answers: AskUserQuestionAnswerItem[] = []
      for (const item of request.questions) {
        answers.push(await this.askOne(item, request.signal))
      }
      return { answers }
    })
  }

  /** Render one question with its options and read the decoded answer. */
  private async askOne(item: AskUserQuestionItem, signal: AbortSignal | undefined): Promise<AskUserQuestionAnswerItem> {
    const out = this.ui.stdout
    out.write('\n')
    if (item.header !== undefined) out.write(this.ui.dim(`[${item.header}]\n`))
    out.write(`${this.ui.yellow('?')} ${this.ui.bold(item.question)}\n`)
    if (item.detail !== undefined) out.write(`${item.detail}\n`)
    const options = item.options ?? []
    options.forEach((option, index) => {
      const description = option.description === undefined ? '' : this.ui.dim(` — ${option.description}`)
      out.write(`  ${this.ui.cyan(String(index + 1))}) ${option.label}${description}\n`)
    })
    if (item.intent?.kind === 'plan-review') {
      out.write(this.ui.dim(`  (choosing "${item.intent.approve}" approves the plan)\n`))
    }
    const hint = options.length === 0
      ? 'answer'
      : item.multiSelect === true ? 'numbers (comma-separated) or text' : 'number or text'
    const line = await this.read(this.ui.cyan(`${hint} › `), signal)
    if (line === undefined) {
      throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    return decodeAnswer(item, line)
  }

  /**
   * Ask one approval decision through the terminal.
   * @param request - the approval seam's request with tool name, reason, and abort signal.
   * @returns `allowed-once` on an explicit yes, `rejected` otherwise, `cancelled` when withdrawn.
   */
  askApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return this.enqueue(async () => {
      if (request.signal?.aborted === true) return 'cancelled'
      const reason = request.reason === undefined ? '' : `: ${request.reason}`
      this.ui.stdout.write(`\n${this.ui.yellow('⚑')} ${this.ui.bold(request.toolName)} requests approval${reason}\n`)
      const line = await this.read(this.ui.cyan('approve once? [y/N] › '), request.signal)
      if (line === undefined) return 'cancelled'
      const normalized = line.toLowerCase()
      return normalized === 'y' || normalized === 'yes' ? 'allowed-once' : 'rejected'
    })
  }
}

/**
 * Register this terminal as the deployment's interaction surface: the
 * user-questions provider (when the seam is composed) and the approval
 * answerer for the REPL's own agent. Both registrations are effects tied to
 * the runner's fiber; other agents' approval requests delegate down the
 * waterfall untouched.
 * @param ctx - the runner's plugin context.
 * @param agent - the REPL's agent; only its approval requests are answered here.
 * @param prompter - the serialized terminal prompter.
 */
export function installInteraction(ctx: Context, agent: Agent, prompter: Prompter): void {
  const questions = ctx.get('userQuestions')
  if (questions !== undefined) {
    ctx.effect(
      () => questions.registerProvider({ ask: request => prompter.askQuestions(request) }),
      'tui-runner: user-questions provider',
    )
  }
  ctx.on('approval/request', (request, next) => {
    if (request.agent.session.id !== agent.session.id) return next()
    return prompter.askApproval(request)
  })
}
