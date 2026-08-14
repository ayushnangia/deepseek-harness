/** Pi-style interactive terminal surface over the Harness session event log. */

import { homedir } from 'node:os'
import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  TuiMainScreen,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Component, EditorTheme, MarkdownTheme, Terminal, TUI } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionDriver, SessionSurface, NoticeTone } from './session-driver.ts'
import type { PromptInput, PrompterUi } from './prompter.ts'
import { figure, isErrorResult, oneLine, textOf } from './render-utils.ts'

/** ANSI painters used by the component tree. */
export interface InteractivePalette {
  dim: (text: string) => string
  bold: (text: string) => string
  cyan: (text: string) => string
  yellow: (text: string) => string
  red: (text: string) => string
  userMessage: (text: string) => string
}

/** Inputs needed to construct one interactive terminal document. */
export interface InteractiveOptions {
  terminal: Terminal
  provider: string
  model: string
  sessionId: string
  cwd: string
  palette: InteractivePalette
  color: boolean
  commands: readonly { name: string; description?: string }[]
}

/** One pending out-of-band decision routed through the editor. */
interface PendingPrompt {
  finish(answer: string | undefined): void
}

/** Responsive two-line footer: workspace/model facts above live input state and usage. */
class Footer implements Component {
  private busy = false
  private prompt: string | undefined
  private inputTokens = 0
  private outputTokens = 0

  constructor(
    private readonly cwd: string,
    private readonly model: string,
    private readonly sessionId: string,
    private readonly ui: InteractivePalette,
  ) {}

  setBusy(busy: boolean): void {
    this.busy = busy
  }

  setPrompt(prompt: string | undefined): void {
    this.prompt = prompt
  }

  addUsage(input: number, output: number): void {
    this.inputTokens += input
    this.outputTokens += output
  }

  invalidate(): void {}

  render(width: number): string[] {
    const location = this.cwd.replace(homedir(), '~')
    const state = this.prompt ?? (this.busy ? 'working · Esc/Ctrl+C to interrupt' : 'ready')
    const usage = `↑${figure(this.inputTokens)} ↓${figure(this.outputTokens)} · ${oneLine(this.sessionId, 18)}`
    return [
      this.row(location, this.model, width),
      this.row(state, usage, width),
    ]
  }

  private row(left: string, right: string, width: number): string {
    if (width <= 1) return this.ui.dim(truncateToWidth(left, width))
    const clippedRight = truncateToWidth(right, Math.max(1, Math.floor(width * 0.58)), '…')
    const availableLeft = Math.max(1, width - visibleWidth(clippedRight) - 1)
    const clippedLeft = truncateToWidth(left, availableLeft, '…')
    const gap = Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight))
    return this.ui.dim(`${clippedLeft}${' '.repeat(gap)}${clippedRight}`)
  }
}

/** Mutable tool row whose result arrives after its call event. */
class ToolBlock extends Container {
  private readonly result = new Text('', 1, 0)

  constructor(name: string, args: string, ui: InteractivePalette) {
    super()
    this.addChild(new Text(`${ui.yellow('●')} ${ui.bold(name)} ${ui.dim(oneLine(args, 100))}`, 1, 0))
    this.addChild(this.result)
  }

  settle(text: string): void {
    this.result.setText(text)
  }
}

/** Differential-rendered terminal document and renderer-neutral input surface. */
export class InteractiveSession implements SessionSurface, PromptInput {
  /** Palette and output adapter used by the shared interaction prompter. */
  readonly prompterUi: PrompterUi

  private readonly tui: TUI
  private readonly transcript = new Container()
  private readonly editor: Editor
  private readonly footer: Footer
  private readonly markdownTheme: MarkdownTheme
  private readonly tools = new Map<string, ToolBlock>()
  private readonly stagedUsers: string[] = []
  private driver: SessionDriver | undefined
  private pendingPrompt: PendingPrompt | undefined
  private closed = false
  private assistantText: Markdown | undefined
  private reasoningText: Text | undefined
  private assistantBuffer = ''
  private reasoningBuffer = ''
  private turnStartedAt = 0

  constructor(private readonly options: InteractiveOptions) {
    const { palette: ui } = options
    this.tui = new TuiMainScreen(options.terminal)
    const selectList = {
      selectedPrefix: (text: string) => ui.cyan(text),
      selectedText: (text: string) => ui.bold(text),
      description: (text: string) => ui.dim(text),
      scrollInfo: (text: string) => ui.dim(text),
      noMatch: (text: string) => ui.dim(text),
    }
    const editorTheme: EditorTheme = { borderColor: (text: string) => ui.cyan(text), selectList }
    this.markdownTheme = {
      heading: text => ui.bold(ui.cyan(text)),
      link: text => ui.cyan(text),
      linkUrl: text => ui.dim(text),
      code: text => ui.yellow(text),
      codeBlock: text => text,
      codeBlockBorder: text => ui.dim(text),
      quote: text => ui.dim(text),
      quoteBorder: text => ui.dim(text),
      hr: text => ui.dim(text),
      listBullet: text => ui.cyan(text),
      bold: text => ui.bold(text),
      italic: text => text,
      strikethrough: text => ui.dim(text),
      underline: text => ui.cyan(text),
    }
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 })
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...options.commands], options.cwd))
    this.footer = new Footer(options.cwd, `${options.provider}/${options.model}`, options.sessionId, ui)
    this.prompterUi = {
      stdout: { write: (chunk) => { this.write(chunk) } },
      dim: text => ui.dim(text),
      bold: text => ui.bold(text),
      cyan: text => ui.cyan(text),
      yellow: text => ui.yellow(text),
    }

    this.compose()
    this.editor.onSubmit = (text) => { this.submit(text) }
    this.tui.addInputListener(data => this.globalInput(data))
  }

  /**
   * Attach the controller before the TUI starts accepting input.
   * @param driver - Session input and shutdown controller for this surface.
   */
  attach(driver: SessionDriver): void {
    this.driver = driver
  }

  /** Enter raw mode, focus the editor, and draw the first document frame. */
  start(): void {
    this.tui.setFocus(this.editor)
    this.tui.start()
  }

  /**
   * Project one committed event into the interactive transcript.
   * @param event - Committed event belonging to this surface's session.
   */
  render(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
        this.turnStartedAt = event.time
        break
      case 'step/start':
        this.resetAssistantRun()
        break
      case 'user/message':
        this.userMessage(event.data)
        break
      case 'assistant/chunk':
        this.chunk(event.data.chunk)
        break
      case 'tool/call': {
        const tool = new ToolBlock(event.data.name, event.data.arguments, this.options.palette)
        this.tools.set(String(event.data.callId), tool)
        this.push(tool)
        break
      }
      case 'tool/result':
        this.toolResult(String(event.data.message.source.callId), event)
        break
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage !== undefined) this.footer.addUsage(usage.inputTokens, usage.outputTokens)
        break
      }
      case 'turn/end':
        this.turnEnd(event)
        break
      case 'plan/mode':
        this.notice(`plan mode ${event.data.active ? 'on' : 'off'}`)
        break
      case 'compaction/start':
        this.notice('compacting context…')
        break
      case 'compaction/summary':
        this.notice('context compacted')
        break
      default:
        break
    }
    this.tui.requestRender()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pendingPrompt?.finish(undefined)
    this.pendingPrompt = undefined
    this.tui.stop()
  }

  write(text: string, tone: NoticeTone = 'normal'): void {
    const normalized = text.replace(/^\n/, '').replace(/\n$/, '')
    if (normalized === '') return
    const paint = tone === 'dim' ? (value: string): string => this.options.palette.dim(value)
      : tone === 'error' ? (value: string): string => this.options.palette.red(value)
        : (value: string): string => value
    this.push(new Text(paint(normalized), 1, 0))
    this.tui.requestRender()
  }

  setBusy(busy: boolean): void {
    this.footer.setBusy(busy)
    if (this.pendingPrompt === undefined) {
      this.editor.borderColor = busy
        ? (text: string) => this.options.palette.yellow(text)
        : (text: string) => this.options.palette.cyan(text)
    }
    this.tui.terminal.setProgress(busy)
    this.tui.requestRender()
  }

  prompt(): void {
    this.tui.setFocus(this.editor)
    this.tui.requestRender()
  }

  showFirstPrompt(text: string): void {
    this.stageUser(text)
  }

  read(query: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve(undefined)
        return
      }
      let settled = false
      const finish = (answer: string | undefined): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        this.pendingPrompt = undefined
        this.footer.setPrompt(undefined)
        this.editor.borderColor = this.driver?.isBusy === true
          ? (text: string) => this.options.palette.yellow(text)
          : (text: string) => this.options.palette.cyan(text)
        this.tui.requestRender()
        resolve(answer?.trim())
      }
      const onAbort = (): void => { finish(undefined) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingPrompt = { finish }
      this.footer.setPrompt(query)
      this.editor.borderColor = (text: string) => this.options.palette.yellow(text)
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    })
  }

  private compose(): void {
    const { palette: ui, provider, model, cwd } = this.options
    const header = new Text(
      `${ui.bold('dsh')} ${ui.dim('DeepSeek Harness coding agent')}\n`
      + `${ui.cyan(`${provider}/${model}`)} ${ui.dim('·')} ${ui.dim(cwd)}\n`
      + ui.dim('Enter submit · Shift+Enter newline · /help commands'),
      1,
      0,
    )
    this.tui.addChild(new Spacer(1))
    this.tui.addChild(header)
    this.tui.addChild(new Spacer(1))
    this.tui.addChild(this.transcript)
    this.tui.addChild(new Spacer(1))
    this.tui.addChild(this.editor)
    this.tui.addChild(this.footer)
  }

  private globalInput(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'ctrl+c')) {
      this.driver?.interrupt()
      return { consume: true }
    }
    if (matchesKey(data, 'escape') && this.driver?.isBusy === true && this.editor.getText() === '') {
      this.driver.interrupt()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+d') && this.editor.getText() === '' && this.pendingPrompt === undefined) {
      this.driver?.end()
      return { consume: true }
    }
    return undefined
  }

  private submit(text: string): void {
    const pending = this.pendingPrompt
    if (pending !== undefined) {
      pending.finish(text)
      return
    }
    if (text.trim() !== '' && !text.trim().startsWith('/')) this.stageUser(text.trim())
    this.driver?.line(text)
  }

  private stageUser(text: string): void {
    this.stagedUsers.push(text)
    this.addUser(text)
  }

  private userMessage(message: SessionEvent<'user/message'>['data']): void {
    const source = message.source as { kind: string; form?: string; summary?: string }
    if (source.kind === 'user') {
      const text = textOf(message.content)
      if (this.stagedUsers[0] === text) this.stagedUsers.shift()
      else this.addUser(text)
      return
    }
    if (source.form === 'notice' && source.summary !== undefined) this.notice(source.summary)
  }

  private addUser(text: string): void {
    const prefix = this.options.color ? '' : '> '
    const bg = this.options.color ? this.options.palette.userMessage : undefined
    const box = new Box(1, 0, bg)
    box.addChild(new Text(`${prefix}${text}`, 0, 0))
    this.push(box)
  }

  private resetAssistantRun(): void {
    this.assistantText = undefined
    this.reasoningText = undefined
    this.assistantBuffer = ''
    this.reasoningBuffer = ''
  }

  private chunk(chunk: SessionEvent<'assistant/chunk'>['data']['chunk']): void {
    if (chunk.type === 'reasoning-delta') {
      if (this.reasoningText === undefined) {
        this.reasoningText = new Text('', 1, 0)
        this.push(this.reasoningText)
      }
      this.reasoningBuffer += chunk.text
      this.reasoningText.setText(this.options.palette.dim(this.reasoningBuffer))
      return
    }
    if (chunk.type !== 'text-delta') return
    if (this.assistantText === undefined) {
      this.assistantText = new Markdown('', 1, 0, this.markdownTheme)
      this.push(this.assistantText)
    }
    this.assistantBuffer += chunk.text
    this.assistantText.setText(this.assistantBuffer)
  }

  private toolResult(callId: string, event: SessionEvent<'tool/result'>): void {
    const tool = this.tools.get(callId)
    if (tool === undefined) return
    if (event.data.error !== undefined) {
      tool.settle(this.options.palette.red(`└ ${event.data.error.code}`))
      return
    }
    const preview = oneLine(textOf(event.data.message.content), 120)
    if (preview === '') return
    const paint = isErrorResult(event.data.message.content)
      ? (text: string): string => this.options.palette.red(text)
      : (text: string): string => this.options.palette.dim(text)
    tool.settle(paint(`└ ${preview}`))
  }

  private turnEnd(event: SessionEvent<'turn/end'>): void {
    const elapsed = ((event.time - this.turnStartedAt) / 1000).toFixed(1)
    const reason = event.data.reason
    if (reason.kind === 'completed') this.write(`─ ${elapsed}s`, 'dim')
    else if (reason.kind === 'error') this.write(`✖ ${reason.error.code}: ${reason.error.message}`, 'error')
    else if (reason.kind === 'aborted') this.write(`■ interrupted after ${elapsed}s`, 'dim')
    else if (reason.kind === 'max-tokens') this.write(`■ output-token ceiling reached after ${elapsed}s`, 'dim')
    else this.write(`■ ${reason.kind} after ${elapsed}s`, 'dim')
  }

  private notice(text: string): void {
    this.write(`· ${text}`, 'dim')
  }

  private push(component: Component): void {
    if (this.transcript.children.length > 0) this.transcript.addChild(new Spacer(1))
    this.transcript.addChild(component)
  }
}
