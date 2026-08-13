/**
 * The interactive app's command-line provider: it parses the optional first
 * prompt positional and `--help`, then publishes {@link TUI_STARTUP_SERVICE}.
 * The REPL runner is an ordinary consumer whose lazy config waits for that
 * service, so on `--help` (and on a grammar rejection) the runner never mounts.
 * @module @deepseek-ai/dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the prompt can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the REPL runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** The first prompt to submit before reading terminal input; empty means none. */
  prompt: string
}

/**
 * This app's command: the optional prompt positional, its description, and its
 * help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Chat with the agent in the terminal; type /help inside for commands.')
    .helpOption('-h, --help', 'show this help')
    .argument('[prompt...]', 'an optional first prompt; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh --profile tui                          start an interactive session
  dsh --profile tui "run the tests"          start with a first prompt already submitted
`)
}

/**
 * Parse and provide the optional first prompt as an ordinary Cordis service.
 * Unlike the one-shot surface, an empty invocation is valid — it starts the
 * REPL with nothing submitted — so the action always provides.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    ctx.provide(TUI_STARTUP_SERVICE, { prompt: program.args.join(' ').trim() } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
