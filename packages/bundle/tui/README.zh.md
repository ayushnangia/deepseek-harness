# @deepseek-ai/dsh-tui

[English](README.md) | 中文

dsh 交互式终端组合包：直接叠加在 `dsh-base` 之上的流式 REPL，不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。`dsh-headless` 回答一个任务后即退出，而本组合包让同一个直接 Agent（智能体）驱动保持存活，把终端变成对话界面。

```sh
dsh --profile tui                     # start an interactive session
dsh --profile tui "run the tests"     # start with a first prompt already submitted
```

## 终端显示的内容

渲染是持久会话日志的投影：每一行都来自已提交的 `session/event`，因此显示内容永远不会与持久化存储的内容相悖。

- assistant 文本随到随流式显示（`assistant/chunk` 文本增量，逐字呈现）。
- 推理内容以暗淡样式流式显示，并与其后的回答分隔。
- 每次工具调用绘制一行——`● name {arguments…}`——来自已提交的 `tool/call` 事件，并附带来自其 `tool/result` 的暗淡单行结果预览（出错时为红色错误码）。
- 每个轮次以单行摘要收尾：耗时与来自该轮次 `assistant/message` 用量的 `↑input ↓output` token 总数，或轮次出错时的失败码。
- 计划模式切换（`plan/mode`）与压缩（compaction）进度（`compaction/start`、`compaction/summary`）绘制暗淡的单行提示。

颜色为普通 SGR 序列；当 stdout 不是交互式终端或设置了 `NO_COLOR` 时禁用。

## 驱动 agent

| 输入 | 空闲时 | 轮次运行中 |
| --- | --- | --- |
| 输入一行文本 | 开始一个后续轮次 | 对最近的步骤进行 steering（中途引导）（`agent.steer`） |
| Ctrl+C | 最终 flush 后退出 | 取消当前轮次（`agent.cancel`，kind 为 `user`） |
| Ctrl+D / stdin 结束 | 最终 flush 后退出 | 等当前轮次完成，然后 flush 并退出 |
| `/help` `/model` `/session` `/exit` | 斜杠命令 | `/exit` 取消当前轮次并退出 |

由于 stdin 结束会等当前轮次完成，管道输入表现为一次性运行：`echo "run the tests" | dsh --profile tui` 会在退出前流式输出完整响应。

steering 走核心收件箱：轮次中途输入的一行会在下一个步骤边界成为模型可见的上下文，与 `agent.steer` 文档所述完全一致，没有 TUI 私有通道。

其他以 `/` 开头的行会在组合挂载了 `commands` 注册表时经由它分发（`dsh-base` 注册 `/compact`、`/feedback`、`/goal`、`/permission` 和 `/plan`）；`/help` 在内置命令之后列出注册表中的命令。注册表命令的成功或错误文本直接打印——它是呈现内容，不是模型输入；命令自身记录的内容（一次压缩、一次计划模式切换）照常通过会话到达模型。

## 交互提示

runner 是该部署的交互界面，与 Web UI 通过 HTTP 提供的能力对应：

- **用户提问**——当组合中包含 `dsh-user-questions` 时，runner 注册其提供方。`ask_user_question` 与计划评审会渲染每个问题及其编号选项；用选项编号、精确的选项文本或自由文本作答（多选用逗号分隔的编号），空行跳过该问题。计划评审问题会注明选择哪个选项即批准计划。
- **审批**——runner 用 `[y/N]` 提示回答自己 agent 的 `approval/request`（`y`/`yes` → `allowed-once`，其余 → `rejected`）；其他 agent 的请求原样沿 waterfall 向下委托。`DSH_PERMISSION_MODE=read-only`/`ask` 下 `dsh-shell` 的沙箱升级重试会在这里出现。

提示在共享 readline 上串行化——`readline.question` 把下一行输入路由给待答提示，因此回答绝不会被误读为 steering——且每次等待都会随其请求的 abort 信号撤回（被取消的轮次会把审批解析为 `cancelled`、把提问解析为 `ASK_ABORTED`）。

## 组合

组合包补丁与 `dsh-headless` 一致：persona 条目收窄为一行简洁的 coding agent（编程智能体）设定，共享的模块重载 HMR（热模块替换）条目保持关闭（启动器的 watch-only 回退保持用户补丁层可用），插入 Code Mode 的 worker 线程运行时，并在其上叠加两个应用插件：

- `tui-startup`——注入 `cmdlineArgs`，解析可选的首个提示词位置参数与 `--help`，并发布 `tuiStartup` 服务。`--help` 时不提供任何内容，因此 runner 永不挂载。
- `tui-runner`——通过核心注册表创建一个 Agent（与一次性组合包相同的模型选择安装方式），订阅按该 agent 会话过滤的 `session/event` 流，把终端注册为用户提问提供方与审批应答方，并持有 readline 循环直到用户退出。

## 模型体验

无影响，因为 runner 把输入行、steering 与交互回答经由所组合各包自己的接缝提交；提示词与工具由 base 和 tui 组合包中的相应条目提供。

#### KV Cache 影响

无；runner 不向请求前缀添加任何内容——它只读取会话日志，并把用户决定转交给负责记录它们的接缝。

## 已知限制与暂缓事项

- **readline 回显与流式输出交错**——agent 流式输出期间输入的行会在流中的光标位置回显。仅影响观感；日志与 steering 投递不受影响。
- **没有会话恢复标志**——每次启动都会创建全新会话；基于持久化存储的 `--resume <id>` 是自然的下一步。
- **`/model` 只报告、不能切换**——该命令打印会话当前模型；会话中途切换模型暂缓，等待核心暴露重新选择的接缝。
