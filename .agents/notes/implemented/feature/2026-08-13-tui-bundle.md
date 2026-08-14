# Agent Note: The tui bundle

Status: implemented

English | [中文](2026-08-13-tui-bundle.zh.md)

## Problem

After the [TUI package removal](../simplification/2026-08-04-remove-tui-package.md), the only interactive product surface was the Web UI; terminal users had exactly one-shot `dsh --profile headless`. Interactive terminal use — follow-ups, steering, cancelling, answering the model's questions, approving tool escalations — required either the browser stack or nothing. The removal note set the reintroduction conditions: a named product or deployment, an explicit package boundary, a concrete interaction provider, and assembled lifecycle acceptance.

## Decision

`@deepseek-ai/dsh-tui` at `packages/bundle/tui` is an installable bundle whose patch layers over `dsh-base` exactly as `dsh-headless` does, shipped as the `dsh --profile tui` deployment. Two function plugins, `tui-startup` (cmdline positional and `--help`) and `tui-runner` (one Agent and one terminal controller), drive the composed harness directly. The runner selects an `@earendil-works/pi-tui` main-screen document for a real TTY and an append-only readline renderer for pipes, redirects, and dumb terminals.

Conversation rendering projects committed `session/event` records — user messages, streamed Markdown and reasoning, tool calls with result previews, turn outcomes, and plan-mode/compaction notices. The TTY adds presentation-only header, footer, editor, command results, and interaction prompts around that durable transcript. Its bordered editor owns multiline editing, history, paste handling, and slash/path completion; the footer owns working directory, route, session, usage, and live input state. Submitted text enters the core inbox as a follow-up or steering; Ctrl+C cancels a running turn; `/exit`, Ctrl+D, and stdin end drain or cancel according to the input contract, flush the session, restore terminal state, and exit by natural event-loop drain.

The terminal is the deployment's interaction surface. The runner registers the `dsh-user-questions` provider when the seam is composed and answers `approval/request` for its own agent (`[y/N]` → `allowed-once`/`rejected`; foreign agents delegate down the waterfall). Prompts serialize over one renderer-neutral input owner: the TTY temporarily routes editor submissions to the pending decision, while plain mode delegates ownership to `readline.question`. Every wait withdraws on its request's abort signal. Slash lines beyond the built-ins dispatch through the `commands` registry, so `/plan`, `/compact`, and the other base commands work unchanged.

This satisfies the removal note's reintroduction conditions: the deployment is `dsh --profile tui`; the boundary is one bundle package with no service of its own beyond `tuiStartup`; the interaction provider is the terminal prompter; lifecycle acceptance covers both renderers, the drain/exit contract, and a keyless product-profile snapshot with scripted stdin, terminal output, and the normalized durable log.

## Alternatives considered

**Revive the deleted `ui/tui` implementation.** Rejected: it was a product-sized frontend with a patched dependency, extension system, SDK surface, and its own presentation vocabulary. The current bundle uses the maintained upstream Pi TUI library only for terminal primitives and keeps Harness events, commands, interaction seams, and lifecycle ownership local.

**A separate terminal-interaction adapter package.** Rejected: the bundle is the only terminal host, and `dsh-user-questions`/`dsh-user-approval`/`dsh-commands` already are the provider-neutral boundary. A second terminal host is the promotion trigger.

**An alternate-screen application-owned viewport.** Rejected: the primary coding flow benefits from native terminal scrollback and search, and pipes still require a stable append-only transcript. Pi's main-screen differential renderer supplies a persistent editor and footer without taking ownership of historical scrolling.

## Consequences

The harness has an interactive terminal product again, and every interaction seam the Web UI serves over HTTP has a terminal answerer, so compositions that block on questions or approvals are usable without the browser stack. Interactive sessions gain stable in-place streaming, multiline editing, completion, and live session state; non-TTY automation retains deterministic text output. The package now carries one maintained TUI dependency and a renderer-specific component projection. The remaining product gaps are session resume, model switching, and application-owned transcript search. The [removal note](../simplification/2026-08-04-remove-tui-package.md) remains the authority for the old package's deletion; its inventory claims now point here.
