# @deepseek-ai/dsh-tui

English | [中文](README.zh.md)

The dsh interactive terminal bundle: a streaming REPL directly over `dsh-base`, with no Host, HTTP server, Web runtime, or browser plugin. Where `dsh-headless` answers one task and exits, this bundle keeps the same direct Agent driver alive and turns the terminal into the conversation surface.

```sh
dsh --profile tui                     # start an interactive session
dsh --profile tui "run the tests"     # start with a first prompt already submitted
```

## What the terminal shows

Rendering is a projection of the durable session log: every line comes from a committed `session/event`, so the display can never disagree with what persistence stored.

- Assistant text streams as it arrives (`assistant/chunk` text deltas, verbatim).
- Reasoning streams dimmed, separated from the answer that follows it.
- Each tool call draws one line — `● name {arguments…}` — from the committed `tool/call` event, with a dimmed one-line result preview (or a red error code) from its `tool/result`.
- Each turn closes with a one-line summary: elapsed time and `↑input ↓output` token totals from the turn's `assistant/message` usage, or the failure code when the turn errored.
- Plan-mode transitions (`plan/mode`) and compaction progress (`compaction/start`, `compaction/summary`) draw dimmed one-line notices.

Colors are plain SGR sequences, disabled when stdout is not an interactive terminal or `NO_COLOR` is set.

## Driving the agent

| Input | Idle | While a turn runs |
| --- | --- | --- |
| A typed line | starts a follow-up turn | steers the nearest step (`agent.steer`) |
| Ctrl+C | exits after a final flush | cancels the active turn (`agent.cancel`, kind `user`) |
| Ctrl+D / stdin end | exits after a final flush | drains the active turn, then flushes and exits |
| `/help` `/model` `/session` `/exit` | slash commands | `/exit` cancels the active turn and exits |

Because stdin end drains the active turn, piped input behaves as a one-shot: `echo "run the tests" | dsh --profile tui` streams the full response before exiting.

Steering rides the core inbox: a line typed mid-turn becomes model-visible context at the next step boundary, exactly as `agent.steer` documents, with no TUI-private channel.

Any other `/`-prefixed line dispatches through the `commands` registry when the composition mounts it (`dsh-base` registers `/compact`, `/feedback`, `/goal`, `/permission`, and `/plan`); `/help` lists the registry's commands after the built-ins. A registry command's success or error text prints directly — it is presentation, not model input; whatever the command itself logs (a compaction, a plan-mode switch) reaches the model through the session as usual.

## Interaction prompts

The runner is the deployment's interaction surface, mirroring what the Web UI provides over HTTP:

- **User questions** — when `dsh-user-questions` is composed, the runner registers its provider. `ask_user_question` and plan review render each question with its numbered options; answer with an option number, an exact label, or free text (comma-separated numbers for multi-select), and an empty line skips the question. A plan-review question notes which option approves the plan.
- **Approvals** — the runner answers `approval/request` for its own agent with a `[y/N]` prompt (`y`/`yes` → `allowed-once`, anything else → `rejected`); requests from other agents delegate down the waterfall untouched. Sandbox-escalation retries from `dsh-shell` surface here under `DSH_PERMISSION_MODE=read-only`/`ask`.

Prompts serialize over the shared readline — `readline.question` routes the next line to the pending prompt, so an answer is never misread as steering — and every wait withdraws on its request's abort signal (a cancelled turn resolves approvals `cancelled` and questions `ASK_ABORTED`).

## Composition

The bundle patch mirrors `dsh-headless`: the persona row is narrowed to a terse coding-agent line, the shared module-reload HMR row stays off (the launcher's watch-only fallback keeps user patch layers live), Code Mode's worker-thread runtime is inserted, and two app plugins ride on top:

- `tui-startup` — injects `cmdlineArgs`, parses the optional first-prompt positional and `--help`, and publishes the `tuiStartup` service. On `--help` nothing is provided, so the runner never mounts.
- `tui-runner` — creates one Agent through the core registry (same model-selection install as the one-shot bundle), subscribes to the `session/event` feed filtered to that agent's session, registers the terminal as the user-questions provider and approval answerer, and owns the readline loop until the user exits.

## Model Experience

None, as the runner submits typed lines, steering, and interaction answers through the composed packages' own seams; prompts and tools belong to the base and tui bundle rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix — it only reads the session log and relays user decisions to the seams that log them.

## Known Limitations and Deferred Work

- **Readline echo interleaves with streaming output** — a line typed while the agent streams is echoed at the cursor position mid-stream. Cosmetic; the log and the steering delivery are unaffected.
- **No session resume flag** — every invocation creates a fresh session; `--resume <id>` over the persistence store is the natural next step.
- **`/model` reports but cannot switch** — the command prints the session's model; changing models mid-session is deferred until the core exposes a reselection seam.
