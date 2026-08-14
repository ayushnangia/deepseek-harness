# @deepseek-ai/dsh-tui

English | [中文](README.zh.md)

The dsh interactive terminal bundle: a coding-agent interface directly over `dsh-base`, with no Host, HTTP server, Web runtime, or browser plugin. A TTY uses Pi's differential terminal renderer and multiline editor; a pipe or redirect keeps a plain streaming transcript. Both modes drive the same Agent and session log.

```sh
dsh --profile tui                     # start an interactive session
dsh --profile tui "run the tests"     # start with a first prompt already submitted
```

## Interactive layout

The main-screen TTY layout preserves ordinary terminal scrollback and keeps four regions visible as the conversation grows:

- A compact header identifies the Harness, provider/model route, working directory, and essential keys.
- A conversation transcript projects committed `session/event` records. User prompts use a distinct block; assistant Markdown streams in place; reasoning is dimmed; tool calls settle into their result previews; turn, plan-mode, and compaction notices remain visible.
- A bordered multiline editor provides prompt history, bracketed-paste handling, slash-command autocomplete, and path completion. Enter submits; Shift+Enter inserts a newline.
- A responsive footer shows the working directory, provider/model, session id, cumulative token use, and live `ready`/`working`/decision state.

The renderer does not invent model history: conversation content comes from the durable log. Header, footer, command results, and interaction prompts are terminal presentation around that projection.

Colors are SGR sequences and are disabled when stdout is not interactive or `NO_COLOR` is set. `TERM=dumb` selects the plain renderer.

## Driving the agent

| Input | Idle | While a turn runs |
| --- | --- | --- |
| Submitted text | starts a follow-up turn | steers the nearest step (`agent.steer`) |
| Ctrl+C | exits after a final flush | cancels the active turn (`agent.cancel`, kind `user`) |
| Ctrl+D / stdin end | exits after a final flush | drains the active turn, then flushes and exits |
| `/help` `/model` `/session` `/exit` | slash commands | `/exit` cancels the active turn and exits |

In the TTY editor, Escape also cancels active work when the editor is empty. The footer shows the available interrupt while a turn runs.

Because stdin end drains the active turn, piped input behaves as a one-shot: `echo "run the tests" | dsh --profile tui` streams the full response before exiting.

Steering rides the core inbox: a line typed mid-turn becomes model-visible context at the next step boundary, exactly as `agent.steer` documents, with no TUI-private channel.

Any other `/`-prefixed line dispatches through the `commands` registry when the composition mounts it (`dsh-base` registers `/compact`, `/feedback`, `/goal`, `/permission`, and `/plan`); `/help` lists the registry's commands after the built-ins. A registry command's success or error text prints directly — it is presentation, not model input; whatever the command itself logs (a compaction, a plan-mode switch) reaches the model through the session as usual.

## Interaction prompts

The runner is the deployment's interaction surface, mirroring what the Web UI provides over HTTP:

- **User questions** — when `dsh-user-questions` is composed, the runner registers its provider. `ask_user_question` and plan review render each question with its numbered options; answer with an option number, an exact label, or free text (comma-separated numbers for multi-select), and an empty line skips the question. A plan-review question notes which option approves the plan.
- **Approvals** — the runner answers `approval/request` for its own agent with a `[y/N]` prompt (`y`/`yes` → `allowed-once`, anything else → `rejected`); requests from other agents delegate down the waterfall untouched. Sandbox-escalation retries from `dsh-shell` surface here under `DSH_PERMISSION_MODE=read-only`/`ask`.

Prompts serialize over the active input owner. In a TTY, the bordered editor switches to the pending decision and the footer shows its answer hint; in plain mode, `readline.question` owns the next line. An answer is therefore never misread as steering. Every wait withdraws on its request's abort signal (a cancelled turn resolves approvals `cancelled` and questions `ASK_ABORTED`).

## Composition

The bundle patch mirrors `dsh-headless`: the persona row is narrowed to a terse coding-agent line, the shared module-reload HMR row stays off (the launcher's watch-only fallback keeps user patch layers live), Code Mode's worker-thread runtime is inserted, and two app plugins ride on top:

- `tui-startup` — injects `cmdlineArgs`, parses the optional first-prompt positional and `--help`, and publishes the `tuiStartup` service. On `--help` nothing is provided, so the runner never mounts.
- `tui-runner` — creates one Agent through the core registry (same model-selection install as the one-shot bundle), subscribes to the `session/event` feed filtered to that agent's session, registers the terminal as the user-questions provider and approval answerer, and owns either the Pi TTY document or the plain readline loop until the user exits.

## Model Experience

None, as the runner submits typed lines, steering, and interaction answers through the composed packages' own seams; prompts and tools belong to the base and tui bundle rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix — it only reads the session log and relays user decisions to the seams that log them.

## Known Limitations and Deferred Work

- **No session resume flag** — every invocation creates a fresh session; `--resume <id>` over the persistence store is the natural next step.
- **`/model` reports but cannot switch** — the command prints the session's model; changing models mid-session is deferred until the core exposes a reselection seam.
- **The TTY transcript is main-screen scrollback** — there is no application-owned search or alternate-screen viewport; use the terminal's own scrolling and search.
