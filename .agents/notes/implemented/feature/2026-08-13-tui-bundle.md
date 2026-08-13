# Agent Note: The tui bundle

Status: implemented

English | [中文](2026-08-13-tui-bundle.zh.md)

## Problem

After the [TUI package removal](../simplification/2026-08-04-remove-tui-package.md), the only interactive product surface was the Web UI; terminal users had exactly one-shot `dsh --profile headless`. Interactive terminal use — follow-ups, steering, cancelling, answering the model's questions, approving tool escalations — required either the browser stack or nothing. The removal note set the reintroduction conditions: a named product or deployment, an explicit package boundary, a concrete interaction provider, and assembled lifecycle acceptance.

## Decision

`@deepseek-ai/dsh-tui` at `packages/bundle/tui` is an installable bundle whose patch layers over `dsh-base` exactly as `dsh-headless` does, shipped as the `dsh --profile tui` deployment. It contains no UI framework: two function plugins, `tui-startup` (cmdline positional and `--help`) and `tui-runner` (one Agent, one readline loop), drive the composed harness directly.

Rendering is a pure projection of committed `session/event` records — streamed text, dimmed reasoning, one line per tool call with a result preview, a per-turn status line, and plan-mode/compaction notices — so the display cannot disagree with persistence. Typed lines submit or steer through the core inbox; Ctrl+C cancels a running turn; `/exit`, Ctrl+D, and stdin end drain the active turn, flush the session, and exit by natural event-loop drain (the runner unrefs stdin after closing readline).

The terminal is the deployment's interaction surface. The runner registers the `dsh-user-questions` provider when the seam is composed and answers `approval/request` for its own agent (`[y/N]` → `allowed-once`/`rejected`; foreign agents delegate down the waterfall). Prompts serialize over the shared readline via `readline.question`, which routes the pending answer line away from the steering path, and every wait withdraws on its request's abort signal. Slash lines beyond the built-ins dispatch through the `commands` registry, so `/plan`, `/compact`, and the other base commands work unchanged.

This satisfies the removal note's reintroduction conditions: the deployment is `dsh --profile tui`; the boundary is one bundle package with no service of its own beyond `tuiStartup`; the interaction provider is the terminal prompter; lifecycle acceptance covers the drain/exit contract in package tests and a keyless product-profile snapshot with scripted stdin, terminal output, and the normalized durable log.

## Alternatives considered

**Revive the deleted `ui/tui` implementation.** Rejected: it was a product-sized frontend with a patched `pi-tui` dependency and its own presentation vocabulary. The removal note requires starting from actual host and interaction needs; a readline REPL over existing seams is that start, and it inherits none of the old package's surface.

**A separate terminal-interaction adapter package.** Rejected: the bundle is the only terminal host, and `dsh-user-questions`/`dsh-user-approval`/`dsh-commands` already are the provider-neutral boundary. A second terminal host is the promotion trigger.

**A full-screen TUI framework.** Rejected: an append-only line renderer matches the append-only session log, keeps readline's steering and question routing semantics trivial, and works identically under pipes; a screen-managing framework would buy layout at the cost of a private presentation state that can drift from the log.

## Consequences

The harness has an interactive terminal product again, and every interaction seam the Web UI serves over HTTP has a terminal answerer, so compositions that block on questions or approvals are usable without the browser stack. The costs are recorded in the package README's limitations: readline echo interleaves cosmetically with streamed output, there is no session resume flag, and `/model` reports without switching. The [removal note](../simplification/2026-08-04-remove-tui-package.md) remains the authority for the old package's deletion; its inventory claims now point here.
