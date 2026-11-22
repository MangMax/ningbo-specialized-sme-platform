import { expect, it, vi } from 'vitest'
import { validateRuntimeMode } from '../../../db/runtime-mode'

it('requires a PostgreSQL connection URL', () => {
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', undefined)
  try {
    expect(() => validateRuntimeMode()).toThrow(/NUXT_POSTGRES_DIRECTORY_URL is required/)
  } finally { vi.unstubAllEnvs() }
})

it('allows distinct PostgreSQL roles on the same endpoint and rejects another database or host override', () => {
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', 'postgresql://business@db/roster?host=%2Fvar%2Frun%2Fpostgresql')
  try {
    vi.stubEnv('NUXT_POSTGRES_LOG_URL', 'postgres://log@other:5432/%72oster?host=%2Fvar%2Frun%2Fpostgresql')
    expect(() => validateRuntimeMode()).not.toThrow()
    vi.stubEnv('NUXT_POSTGRES_LOG_URL', 'postgres://log@db/logs?host=%2Fvar%2Frun%2Fpostgresql')
    expect(() => validateRuntimeMode()).toThrow(/same PostgreSQL database/)
    vi.stubEnv('NUXT_POSTGRES_LOG_URL', 'postgres://log@db/roster?host=%2Ftmp')
    expect(() => validateRuntimeMode()).toThrow(/same PostgreSQL database/)
  } finally { vi.unstubAllEnvs() }
})
