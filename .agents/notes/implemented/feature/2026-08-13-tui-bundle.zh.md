# Agent Note: tui 组合包

Status: implemented

[English](2026-08-13-tui-bundle.md) | 中文

## 问题

[TUI 包移除](../simplification/2026-08-04-remove-tui-package.md)之后，唯一的交互式产品界面是 Web UI；终端用户只有一次性的 `dsh --profile headless`。交互式终端使用——后续输入、steering（中途引导）、取消、回答模型的提问、审批工具升级——要么依赖浏览器栈，要么无从进行。移除记录规定了重新引入的条件：具名产品或部署、显式包边界、具体交互提供方，以及组装后的生命周期验收。

## 决策

位于 `packages/bundle/tui` 的 `@deepseek-ai/dsh-tui` 是一个可安装组合包，其补丁与 `dsh-headless` 完全一样叠加在 `dsh-base` 之上，以 `dsh --profile tui` 部署交付。它不包含任何 UI 框架：两个函数插件——`tui-startup`（命令行位置参数与 `--help`）和 `tui-runner`（一个 Agent（智能体）、一个 readline 循环）——直接驱动组合后的 harness。

渲染是已提交 `session/event` 记录的纯投影——流式文本、暗淡的推理内容、每次工具调用一行并附结果预览、每轮次一条状态行，以及计划模式与压缩（compaction）提示——因此显示内容不可能与持久化相悖。输入行经核心收件箱提交或 steering；Ctrl+C 取消运行中的轮次；`/exit`、Ctrl+D 与 stdin 结束会等当前轮次完成、flush 会话，并依靠事件循环自然排空退出（runner 在关闭 readline 后对 stdin 执行 unref）。

终端就是该部署的交互界面。runner 在组合包含该接缝时注册 `dsh-user-questions` 提供方，并为自己的 agent 回答 `approval/request`（`[y/N]` → `allowed-once`/`rejected`；其他 agent 的请求沿 waterfall 向下委托）。提示经由 `readline.question` 在共享 readline 上串行化，待答的回答行因此不会进入 steering 路径，且每次等待都会随其请求的 abort 信号撤回。内置命令之外的斜杠行经 `commands` 注册表分发，因此 `/plan`、`/compact` 及其余 base 命令原样可用。

这满足了移除记录的重新引入条件：部署是 `dsh --profile tui`；边界是一个除 `tuiStartup` 外不提供任何服务的组合包；交互提供方是终端提示器；生命周期验收通过包测试覆盖排空／退出行为，并通过无密钥产品 profile 快照覆盖脚本化 stdin、终端输出与规范化持久日志。

## 考虑过的替代方案

**复活已删除的 `ui/tui` 实现。** 不予采纳：它是一个产品规模的前端，带有打过补丁的 `pi-tui` 依赖和自己的一套呈现词汇。移除记录要求从实际宿主与交互需求出发；基于既有接缝的 readline REPL 正是这个起点，且不继承旧包的任何 surface。

**独立的终端交互适配器包。** 不予采纳：该组合包是唯一的终端宿主，而 `dsh-user-questions`／`dsh-user-approval`／`dsh-commands` 本身就是提供方无关的边界。出现第二个终端宿主才是提升为独立包的触发条件。

**全屏 TUI 框架。** 不予采纳：追加式行渲染器与追加式会话日志相匹配，使 readline 的 steering 与问题路由语义保持简单，并在管道下行为一致；管理屏幕的框架用私有呈现状态换取布局，而该状态可能与日志漂移。

## 后果

harness 重新拥有了交互式终端产品，Web UI 通过 HTTP 提供的每个交互接缝都有了终端应答方，因此会在提问或审批上阻塞的组合无需浏览器栈即可使用。代价记录在包 README 的限制条目中：readline 回显与流式输出在观感上交错、没有会话恢复标志，且 `/model` 只报告不能切换。[移除记录](../simplification/2026-08-04-remove-tui-package.md)仍是旧包删除决策的依据；其清单表述现指向本记录。
