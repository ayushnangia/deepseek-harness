# @deepseek-ai/dsh-tui

[English](README.md) | 中文

dsh 交互式终端组合包：直接叠加在 `dsh-base` 之上的 coding-agent（编程智能体）界面，不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。TTY 使用 Pi 的差异渲染终端与多行编辑器；管道或重定向保留纯文本流式记录。两种模式驱动同一个 Agent（智能体）与会话日志。

```sh
dsh --profile tui                     # start an interactive session
dsh --profile tui "run the tests"     # start with a first prompt already submitted
```

## 交互式布局

主屏幕 TTY 布局保留终端原有的 scrollback（回滚记录），并在对话增长时持续显示四个区域：

- 紧凑的页眉标明 Harness、provider/model 路由、工作目录与主要按键。
- 对话记录投影已提交的 `session/event`。用户提示使用独立区块；assistant Markdown 原位流式更新；推理内容以暗淡样式显示；工具调用在结果到达后补充预览；轮次、计划模式与压缩提示保持可见。
- 带边框的多行编辑器提供提示历史、bracketed paste（括号粘贴）处理、斜杠命令自动补全与路径补全。Enter 提交；Shift+Enter 插入换行。
- 响应式页脚显示工作目录、provider/model、会话 id、累计 token 用量，以及实时的 `ready`／`working`／待决策状态。

渲染器不会编造模型历史：对话内容来自持久日志。页眉、页脚、命令结果与交互提示是围绕该投影的终端呈现。

颜色使用 SGR 序列；当 stdout 不是交互式终端或设置了 `NO_COLOR` 时禁用。`TERM=dumb` 会选择纯文本渲染器。

## 驱动 agent

| 输入 | 空闲时 | 轮次运行中 |
| --- | --- | --- |
| 提交文本 | 开始一个后续轮次 | 对最近的步骤进行 steering（中途引导）（`agent.steer`） |
| Ctrl+C | 最终 flush 后退出 | 取消当前轮次（`agent.cancel`，kind 为 `user`） |
| Ctrl+D / stdin 结束 | 最终 flush 后退出 | 等当前轮次完成，然后 flush 并退出 |
| `/help` `/model` `/session` `/exit` | 斜杠命令 | `/exit` 取消当前轮次并退出 |

在 TTY 编辑器为空时，Escape 也会取消正在运行的任务。轮次运行期间，页脚会显示可用的中断按键。

由于 stdin 结束会等当前轮次完成，管道输入表现为一次性运行：`echo "run the tests" | dsh --profile tui` 会在退出前流式输出完整响应。

steering 走核心收件箱：轮次中途输入的一行会在下一个步骤边界成为模型可见的上下文，与 `agent.steer` 文档所述完全一致，没有 TUI 私有通道。

其他以 `/` 开头的行会在组合挂载了 `commands` 注册表时经由它分发（`dsh-base` 注册 `/compact`、`/feedback`、`/goal`、`/permission` 和 `/plan`）；`/help` 在内置命令之后列出注册表中的命令。注册表命令的成功或错误文本直接打印——它是呈现内容，不是模型输入；命令自身记录的内容（一次压缩、一次计划模式切换）照常通过会话到达模型。

## 交互提示

runner 是该部署的交互界面，与 Web UI 通过 HTTP 提供的能力对应：

- **用户提问**——当组合中包含 `dsh-user-questions` 时，runner 注册其提供方。`ask_user_question` 与计划评审会渲染每个问题及其编号选项；用选项编号、精确的选项文本或自由文本作答（多选用逗号分隔的编号），空行跳过该问题。计划评审问题会注明选择哪个选项即批准计划。
- **审批**——runner 用 `[y/N]` 提示回答自己 agent 的 `approval/request`（`y`/`yes` → `allowed-once`，其余 → `rejected`）；其他 agent 的请求原样沿 waterfall 向下委托。`DSH_PERMISSION_MODE=read-only`/`ask` 下 `dsh-shell` 的沙箱升级重试会在这里出现。

提示通过当前输入所有者串行化。在 TTY 中，带边框的编辑器会切换为待决策状态，页脚显示回答提示；在纯文本模式中，`readline.question` 接管下一行。因此回答绝不会被误读为 steering。每次等待都会随其请求的 abort 信号撤回（被取消的轮次会把审批解析为 `cancelled`、把提问解析为 `ASK_ABORTED`）。

## 组合

组合包补丁与 `dsh-headless` 一致：persona 条目收窄为一行简洁的 coding agent（编程智能体）设定，共享的模块重载 HMR（热模块替换）条目保持关闭（启动器的 watch-only 回退保持用户补丁层可用），插入 Code Mode 的 worker 线程运行时，并在其上叠加两个应用插件：

- `tui-startup`——注入 `cmdlineArgs`，解析可选的首个提示词位置参数与 `--help`，并发布 `tuiStartup` 服务。`--help` 时不提供任何内容，因此 runner 永不挂载。
- `tui-runner`——通过核心注册表创建一个 Agent（与一次性组合包相同的模型选择安装方式），订阅按该 agent 会话过滤的 `session/event` 流，把终端注册为用户提问提供方与审批应答方，并持有 Pi TTY 文档或纯文本 readline 循环直到用户退出。

## 模型体验

无影响，因为 runner 把输入行、steering 与交互回答经由所组合各包自己的接缝提交；提示词与工具由 base 和 tui 组合包中的相应条目提供。

#### KV Cache 影响

无；runner 不向请求前缀添加任何内容——它只读取会话日志，并把用户决定转交给负责记录它们的接缝。

## 已知限制与暂缓事项

- **没有会话恢复标志**——每次启动都会创建全新会话；基于持久化存储的 `--resume <id>` 是自然的下一步。
- **`/model` 只报告、不能切换**——该命令打印会话当前模型；会话中途切换模型暂缓，等待核心暴露重新选择的接缝。
- **TTY 对话使用主屏幕 scrollback**——目前没有应用自己管理的搜索或 alternate-screen（备用屏幕）视口；请使用终端自身的滚动与搜索。
