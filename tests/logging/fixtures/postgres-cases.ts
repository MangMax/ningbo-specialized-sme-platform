import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { startDebugLogCollection } from './debug-collection'

export function usePostgresLogCases({ debug = false } = {}) {
  let directory: string
  let template: Awaited<ReturnType<typeof postgresRuntimeFixture>>
  let generation = 0
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'log-cases-'))
    template = debug
      ? await startDebugLogCollection(directory)
      : await postgresRuntimeFixture({ dir: directory, logsOnly: true })
  }, 30_000)
  afterAll(() => {
    try { template?.close() }
    finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
  })
  return () => {
    const database = 'log_case_' + ++generation
    template.psql(['-c', 'CREATE DATABASE ' + database + ' TEMPLATE postgres'])
    const url = new URL(template.url)
    url.pathname = '/' + database
    return {
      url: url.href,
      env: { ...template.env, NUXT_POSTGRES_LOG_URL: url.href },
      psql: (args: string[]) => template.psql(['-d', database, ...args]),
      close: () => { template.psql(['-c', 'DROP DATABASE ' + database]) },
    }
  }
}
