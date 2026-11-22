import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

export function businessDigest(runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>) {
  const bytes = execFileSync(join(runtime.env.NUXT_POSTGRES_BIN, 'pg_dump'), [
    '--schema=business', '--data-only', '--sequence-data', '--no-owner', '--no-privileges',
    '--restrict-key=FixtureBusinessDigest', '--dbname=' + runtime.url,
  ], { stdio: 'pipe' })
  return createHash('sha256').update(bytes).digest('hex')
}
