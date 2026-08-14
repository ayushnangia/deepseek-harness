# Agent Note: Default checkout command uses the built CLI

Status: implemented

English | [中文](2026-08-14-default-checkout-built-cli.zh.md)

## Problem

The npm package exposes `dsh` through the compiled `apps/cli/lib/bin.js`, while the repository's default `pnpm dsh` command ran `apps/cli/src/bin.ts` through the tsx ESM hook. The two paths could resolve different files, and the default checkout command printed an implementation-specific TypeScript loader invocation before the product interface. A terminal beta tested through that path did not prove that the installed package could start the same application.

## Decision

The private root workspace depends on `@deepseek-ai/dsh` and its `dsh` script invokes that package's generated bin shim. The shim runs `apps/cli/lib/bin.js` under plain Node, so package-manager output shows the product command rather than a Node implementation command. Users build once with `pnpm run build`, then `pnpm dsh <args...>` exercises the same compiled entry and package-resolution behavior as an installed `dsh`. The npm manifest continues to expose that file as the `dsh` bin, and the public beta documentation uses `npm install --global @deepseek-ai/dsh@next` followed by `dsh --profile tui`; the no-install form is `npx --yes @deepseek-ai/dsh@next --profile tui`.

The TypeScript launcher remains available only as `pnpm dsh:source <args...>` for contributor work that specifically needs source-plane resolution. It retains the tsx ESM transformation decision and does not become the product installation path.

Release verification installs the packed dependency set outside the repository with the same optional platform packages a normal npm install keeps, checks the installed CLI version, and runs `--profile tui --help`. Keeping those packages matters because external native modules such as Koffi distribute their prebuilt binary through a platform-specific optional dependency; removing all optional dependencies would turn package verification into a local native-toolchain test. The installed probe proves that the package contains a working executable, resolves the TUI bundle from installed artifacts, and reaches the terminal application's own parser without workspace links or tsx.

## Alternatives considered

**Keep the source launcher as the default checkout command.** This preserves a zero-build edit loop, but it keeps normal beta testing on a different module-resolution path from npm and continues to expose the loader invocation. The explicit `dsh:source` command retains that loop without making it the default.

**Hide the source invocation behind a wrapper.** This removes the printed detail but still tests source transformation and workspace path projection instead of the distributed package.

**Build automatically on every `pnpm dsh`.** This guarantees fresh artifacts but adds a repository-wide build to every launch and mixes build output with the terminal interface. Artifact generation remains explicit under the existing build-separation decision.

## Consequences

- The default checkout command and the installed command execute the same compiled CLI entry under plain Node.
- A fresh checkout must run `pnpm run build` before `pnpm dsh`; subsequent launches do not rebuild or check artifact freshness.
- Contributors retain an explicit source command, so source-plane compatibility and configuration resolution remain testable.
- Publishing still requires the repository's release credentials and workflow; this decision makes the tarballs release-ready but does not let a fork publish into the `@deepseek-ai` npm scope.
