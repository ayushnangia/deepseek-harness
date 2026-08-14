# Agent Note: Separate source launch from repository build

Status: implemented

English | [中文](2026-08-12-separate-source-launch-from-build.zh.md)

## Problem

The TypeScript source launcher does not need a complete repository build for every invocation. The Web surface does need built frontend and client-plugin artifacts. Making one package script own both operations adds repository-wide build latency to repeated TUI, headless, and Web startup and obscures when browser artifacts are refreshed.

Source modules reached through tsx and browser modules reached through built bundles have different freshness behavior. Separating their commands requires explicit ownership of artifact production and an accurate failure model for missing and stale output.

## Decision

The root `dsh` script only runs the built `apps/cli/lib/bin.js`, and the explicit `dsh:source` script only runs `node --import tsx/esm apps/cli/src/bin.ts`. Neither launcher builds. `pnpm run build` remains the separate operation that generates package and frontend artifacts; checkout users run it after a fresh checkout and whenever package, frontend, or Client plugin artifacts need refreshing.

Missing Typert host artifacts fail profile boot through module-resolution errors without a build instruction. Once those host artifacts exist, missing frontend and client-plugin artifacts fail at startup with diagnostics that direct the user to `pnpm run build`. The launcher does not validate artifact freshness: existing stale frontend or client-plugin bundles are accepted and can run older browser code until the next build. After package Node halves have been built once, `pnpm run dev:web` rebuilds only packages that declare `dsh.client`; it keeps client-plugin bundles current and activates their hot-reload path, but does not rebuild the frontend shell.

This decision owns build scheduling only. The [tsx ESM source-launch decision](../architecture/2026-07-29-dsh-source-launch-tsx-esm.md) owns TypeScript transformation and workspace resolution, the [source-run decision](2026-08-10-source-run-without-managed-installer.md) owns repository scripts as the supported checkout entry points, and the [personal-config decision](../feature/2026-07-20-dsh-cli-personal-config.md) owns the machine-level configuration layer.

## Alternatives considered

**Build before every source launch.** This provides the strongest default freshness guarantee, but charges every invocation for repository-wide artifact generation even when the relevant outputs are already current.

**Build only when an artifact is missing.** This avoids some startup work but leaves stale output undetected while making build behavior implicit and dependent on the current filesystem contents.

**Start the Web artifact watcher from `pnpm dsh`.** This keeps client-plugin bundles current but changes a one-shot launcher into an owner of another long-lived process. The explicit `pnpm run dev:web` command already owns that development lifecycle.

## Consequences

- Repeated checkout launches do not wait for a complete repository build, and build output is not mixed with CLI output.
- Checkout users own artifact freshness. Missing artifacts stop startup, but only frontend and Client plugin failures direct users to `pnpm run build`; existing stale frontend and Client plugin bundles can silently serve older browser code.
- TUI, Web, and headless selection, argument forwarding, and environment inheritance are shared by the built default and the explicit tsx ESM source vector.
- The root onboarding and CLI reference show build and launch as separate commands and document the stale-artifact behavior.

## Verification

`apps/cli/tests/source-launch.compat.spec.ts` pins both root package commands and exercises the explicit source-launch vector. `apps/cli/tests/built-bin.e2e.ts` exercises the compiled package bin under plain Node. `packages/bundle/web-app/tests/web-app.spec.ts` and `packages/client/modules/tests/node-half.client.spec.ts` pin the missing-artifact diagnostics.
