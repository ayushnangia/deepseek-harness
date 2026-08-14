# Agent Note: 默认 checkout 命令使用已构建 CLI

Status: implemented

[English](2026-08-14-default-checkout-built-cli.md) | 中文

## 问题

npm 包通过已编译的 `apps/cli/lib/bin.js` 暴露 `dsh`，但仓库默认的 `pnpm dsh` 命令会通过 tsx ESM 钩子运行 `apps/cli/src/bin.ts`。两条路径可能解析到不同文件，而默认 checkout 命令还会在产品界面出现前打印实现专用的 TypeScript loader 调用。通过这条路径测试终端 beta，无法证明安装后的包能启动同一个应用。

## 决策

私有根 workspace 依赖 `@deepseek-ai/dsh`，其 `dsh` 脚本会调用该包生成的 bin shim。该 shim 在普通 Node 下运行 `apps/cli/lib/bin.js`，因此包管理器输出会显示产品命令，而不是 Node 实现命令。用户使用 `pnpm run build` 构建一次，之后 `pnpm dsh <args...>` 会执行与安装后 `dsh` 相同的已编译入口与包解析行为。npm manifest（元数据清单）继续将该文件暴露为 `dsh` bin；公开 beta 文档使用 `npm install --global @deepseek-ai/dsh@next`，然后运行 `dsh --profile tui`；不安装的形式是 `npx --yes @deepseek-ai/dsh@next --profile tui`。

TypeScript 启动器仅作为 `pnpm dsh:source <args...>` 保留，供明确需要源码面解析的贡献者使用。它继续遵循 tsx ESM 转换决策，不会成为产品安装路径。

发行验证会在仓库之外安装已打包的依赖集，并保留普通 npm 安装也会保留的可选平台包，然后检查安装后的 CLI 版本并运行 `--profile tui --help`。必须保留这些包，因为 Koffi 等外部原生模块会通过平台专用的可选依赖分发预构建二进制；删除全部可选依赖会把包验证变成一次无关的本机原生工具链测试。安装后探针会证明包内含可用的可执行文件，能从已安装产物解析 TUI 组合包，并且无需 workspace 链接或 tsx 即可到达终端应用自身的解析器。

## 考虑过的备选方案

**保留源码启动器作为默认 checkout 命令。**这会保留零构建编辑循环，但会让普通 beta 测试继续使用与 npm 不同的模块解析路径，并继续暴露 loader 调用。显式的 `dsh:source` 命令保留了该循环，无需将其设为默认。

**在 wrapper 后隐藏源码调用。**这会移除打印的细节，但测试的仍是源码转换和 workspace 路径投影，而不是分发的包。

**每次运行 `pnpm dsh` 时自动构建。**这会保证产物最新，但会在每次启动时执行全仓库构建，并将构建输出与终端界面混在一起。产物生成继续按现有构建分离决策保持显式。

## 影响

- 默认 checkout 命令与安装后的命令会在普通 Node 下执行同一个已编译 CLI 入口。
- 全新 checkout 必须在 `pnpm dsh` 之前运行 `pnpm run build`；后续启动不会重新构建，也不会检查产物新鲜度。
- 贡献者仍保留明确的源码命令，因此源码面兼容性与配置解析仍可测试。
- 发布仍需要仓库的发行凭据与工作流；本决策使 tarball 达到可发行状态，但不会让 fork 获得向 `@deepseek-ai` npm scope 发布的权限。
