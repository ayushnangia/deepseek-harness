# Agent Note: tui 组合包

Status: implemented

[English](2026-08-13-tui-bundle.md) | 中文

## 问题

[TUI 包移除](../simplification/2026-08-04-remove-tui-package.md)之后，唯一的交互式产品界面是 Web UI；终端用户只有一次性的 `dsh --profile headless`。交互式终端使用——后续输入、steering（中途引导）、取消、回答模型的提问、审批工具升级——要么依赖浏览器栈，要么无从进行。移除记录规定了重新引入的条件：具名产品或部署、显式包边界、具体交互提供方，以及组装后的生命周期验收。

## 决策

位于 `packages/bundle/tui` 的 `@deepseek-ai/dsh-tui` 是一个可安装组合包，其补丁与 `dsh-headless` 完全一样叠加在 `dsh-base` 之上，以 `dsh --profile tui` 部署交付。两个函数插件——`tui-startup`（命令行位置参数与 `--help`）和 `tui-runner`（一个 Agent（智能体）与一个终端控制器）——直接驱动组合后的 harness。runner 为真实 TTY 选择基于 `@earendil-works/pi-tui` 的主屏幕文档，并为管道、重定向与 dumb terminal（简易终端）选择追加式 readline 渲染器。

对话渲染投影已提交的 `session/event` 记录——用户消息、流式 Markdown 与推理内容、附结果预览的工具调用、轮次结果，以及计划模式／压缩提示。TTY 在该持久对话记录周围添加仅用于呈现的页眉、页脚、编辑器、命令结果与交互提示。带边框的编辑器负责多行编辑、历史、粘贴处理与斜杠／路径补全；页脚负责工作目录、路由、会话、用量与实时输入状态。提交的文本通过核心收件箱成为 follow-up（后续输入）或 steering；Ctrl+C 取消运行中的轮次；`/exit`、Ctrl+D 与 stdin 结束依照输入约定排空或取消任务、flush 会话、还原终端状态，并依靠事件循环自然排空退出。

终端就是该部署的交互界面。runner 在组合包含该接缝时注册 `dsh-user-questions` 提供方，并为自己的 agent 回答 `approval/request`（`[y/N]` → `allowed-once`/`rejected`；其他 agent 的请求沿 waterfall 向下委托）。提示通过一个与渲染器无关的输入所有者串行化：TTY 暂时把编辑器提交路由给待决策项，纯文本模式则把输入所有权交给 `readline.question`。每次等待都会随其请求的 abort 信号撤回。内置命令之外的斜杠行经 `commands` 注册表分发，因此 `/plan`、`/compact` 及其余 base 命令原样可用。

这满足了移除记录的重新引入条件：部署是 `dsh --profile tui`；边界是一个除 `tuiStartup` 外不提供任何服务的组合包；交互提供方是终端提示器；生命周期验收覆盖两种渲染器与排空／退出行为，并通过无密钥产品 profile 快照覆盖脚本化 stdin、终端输出与规范化持久日志。

## 考虑过的替代方案

**复活已删除的 `ui/tui` 实现。** 不予采纳：它是一个产品规模的前端，带有打过补丁的依赖、扩展系统、SDK surface（接口面）与自己的一套呈现词汇。当前组合包仅把维护中的上游 Pi TUI 库用于终端基础组件，并在本地保留 Harness 事件、命令、交互接缝与生命周期所有权。

**独立的终端交互适配器包。** 不予采纳：该组合包是唯一的终端宿主，而 `dsh-user-questions`／`dsh-user-approval`／`dsh-commands` 本身就是提供方无关的边界。出现第二个终端宿主才是提升为独立包的触发条件。

**使用备用屏幕并由应用管理视口。** 不予采纳：主要编程流程需要终端原生的 scrollback 与搜索，管道也仍需稳定的追加式文本记录。Pi 的主屏幕差异渲染器提供持久编辑器与页脚，而不接管历史滚动。

## 后果

harness 重新拥有了交互式终端产品，Web UI 通过 HTTP 提供的每个交互接缝都有了终端应答方，因此会在提问或审批上阻塞的组合无需浏览器栈即可使用。交互式会话获得稳定的原位流式更新、多行编辑、补全与实时会话状态；非 TTY 自动化保留确定性文本输出。该包现在承担一个维护中的 TUI 依赖与渲染器专用组件投影。剩余产品缺口是会话恢复、模型切换与由应用管理的对话搜索。[移除记录](../simplification/2026-08-04-remove-tui-package.md)仍是旧包删除决策的依据；其清单表述现指向本记录。
