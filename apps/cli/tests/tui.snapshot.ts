/** Keyless product-profile acceptance for the interactive terminal beta. */

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const overlayPath = fileURLToPath(new URL('./fixtures/tui-snapshot/cordis.yml', import.meta.url))
const adapterPath = fileURLToPath(new URL('./fixtures/tui-snapshot/llm.ts', import.meta.url))
const scenarioDir = fileURLToPath(new URL('./snapshots/tui-basic/', import.meta.url))
const terminalExpected = join(scenarioDir, 'terminal.expected.txt')
const sessionExpected = join(scenarioDir, 'session.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const prompt = 'Prove the interactive terminal beta with one tool round trip.'

interface JsonObject {
  [key: string]: unknown
}

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

async function persistedSession(root: string): Promise<string> {
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.jsonl'))
  if (files.length !== 1 || files[0] === undefined) {
    throw new Error(`TUI snapshot expected one uncompressed session log, found ${files.length}`)
  }
  return readFile(join(root, files[0]), 'utf8')
}

function normalizeTerminal(stdout: string, cwd: string): string {
  return stdout
    .split(`/private${cwd}`).join('{{cwd}}')
    .split(cwd).join('{{cwd}}')
    .replace(/─ \d+\.\d+s/g, '─ {{elapsed}}s')
}

describe('tui product profile snapshot', () => {
  it('streams a tool round trip, drains stdin, and persists the same completed turn', async () => {
    let normalizedSession = ''
    let snapshotCwd = ''
    const result = await runLoaderSmoke({
      label: 'product TUI profile snapshot',
      tempDirPrefix: 'dsh-tui-snapshot-',
      binScript: dshBinScript,
      configPath: overlayPath,
      binArgs: ['--profile', 'tui', '--patch', overlayPath, prompt],
      tsconfigPath,
      env: {
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: async (cwd) => {
        const fixtureDir = join(cwd, '.dsh', 'profiles', 'tui', 'snapshot-fixtures')
        await mkdir(fixtureDir, { recursive: true })
        await Promise.all([
          copyFile(adapterPath, join(fixtureDir, 'tui-snapshot-llm.ts')),
          writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
        ])
      },
      inspect: async (cwd) => {
        snapshotCwd = cwd
        const raw = await persistedSession(join(cwd, '.dsh', 'sessions'))
        const header = parseJsonl(raw)[0]
        const context: NormalizeContext = {
          sessionIds: typeof header?.id === 'string' ? [header.id] : [],
          cwd: typeof header?.cwd === 'string' ? header.cwd : cwd,
        }
        normalizedSession = scrubRequestHeaders(normalizeSessionLog(raw, context))
      },
    })

    const terminal = normalizeTerminal(result.stdout, snapshotCwd)
    if (refreshing) {
      await mkdir(scenarioDir, { recursive: true })
      await Promise.all([
        writeFile(terminalExpected, terminal),
        writeFile(sessionExpected, normalizedSession),
      ])
    }
    expect(result.stderr).toBe('')
    expect(terminal).toBe(await readFile(terminalExpected, 'utf8'))
    expect(normalizedSession).toBe(await readFile(sessionExpected, 'utf8'))
    expect(normalizedSession).toContain(prompt)
    expect(normalizedSession).toContain('Terminal beta ready: TUI_BETA_READY')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
