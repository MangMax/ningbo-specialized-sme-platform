import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { createLogService } from '../../../layers/core/lib/logging/service'

it('keeps historical events unmarked and combines module with other list and clear filters', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'log-module-migration-'))
  const seed = createLogService({ directory })
  const event = { source: 'http', operation: 'http.request', outcome: 'success' } as const
  const oldId = seed.emit(event)
  await seed.flush()
  await seed.close()

  // Recreate the pre-module shape and preserve the original indexed ID and JSON.
  const db = new Database(join(directory, 'events.db'))
  const columns = db.pragma('table_info(log_events)') as { name: string }[]
  if (columns.some(column => column.name === 'module')) {
    db.exec('DROP INDEX log_module; ALTER TABLE log_events DROP COLUMN module')
    db.exec("UPDATE log_events SET summary=json_remove(summary,'$.module'), detail=json_remove(detail,'$.module')")
  }
  db.close()
  const service = createLogService({ directory })
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
    rmSync(directory, { recursive: true, force: true })
  }
})
