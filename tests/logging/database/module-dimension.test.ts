import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { expect, it } from 'vitest'
import { createPostgresLogService } from '../../../layers/core/lib/logging/postgres-service'

it('keeps historical events unmarked and combines module with other list and clear filters', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'log-module-migration-'))
  const runtime = await postgresRuntimeFixture({ dir: directory, logsOnly: true })
  const seed = createPostgresLogService({ postgresUrl: runtime.url })
  const event = { source: 'http', operation: 'http.request', outcome: 'success' } as const
  const oldId = seed.emit(event)
  await seed.flush()
  await seed.close()

  const service = createPostgresLogService({ postgresUrl: runtime.url })
  try {
    expect(await service.detail(oldId!)).toMatchObject({ id: oldId, module: null })
    service.emit({ ...event, module: 'sme-roster' })
    service.emit({ ...event, module: 'core' })
    service.emit({ ...event, source: 'mcp', module: 'sme-roster' })
    service.emit({ ...event, module: 'PRIVATE_UNREGISTERED_MODULE' })
    await service.flush()
    const filter = { module: 'sme-roster', source: 'http', outcome: 'success', level: 'info' }
    expect((await service.list(filter)).rows).toMatchObject([{ ...event, module: 'sme-roster' }])
    const unmarked = (await service.list({ module: ':unlabeled' })).rows
    expect(unmarked).toHaveLength(2)
    expect(unmarked.every(row => row.module === null)).toBe(true)
    expect(JSON.stringify(unmarked)).not.toContain('PRIVATE_UNREGISTERED_MODULE')
    await expect(service.list({ module: 'unknown-module' })).rejects.toMatchObject({ code: 'invalid_log_input' })
    const cleared = await service.clear({ ...filter, confirm: true, from: new Date(Date.now() - 60000).toISOString(), to: new Date().toISOString() })
    expect(cleared.deleted).toBe(1)
    expect((await service.list({ module: 'core', source: 'http' })).rows).toHaveLength(1)
    expect((await service.list({ module: 'sme-roster' })).rows).toMatchObject([{ source: 'mcp' }])
  } finally {
    await service.close()
    runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
