import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeDb } from '../../../db/client'
import { seedExport188DisconnectFixture } from '../../helpers/export-188-fixture'

it('rolls back a failed export fixture transaction before its child closes and rejects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'export-188-fixture-failure-'))
  const dbPath = join(dir, 'synthetic.db'), db = initializeDb({ create: true,  dbPath })
  try {
    db.$client.exec(`CREATE TRIGGER fail_fixture BEFORE INSERT ON enterprise
      WHEN NEW.name LIKE '合成断开1%' BEGIN SELECT RAISE(ABORT, 'synthetic fixture failure'); END`)
    await expect(seedExport188DisconnectFixture(dbPath)).rejects.toThrow('synthetic fixture failure')
    expect(db.$client.prepare('SELECT count(*) AS n FROM enterprise').get()).toEqual({ n: 0 })
    expect(db.$client.prepare('SELECT count(*) AS n FROM record').get()).toEqual({ n: 0 })
    expect(db.$client.prepare('SELECT count(*) AS n FROM record_event').get()).toEqual({ n: 0 })
    expect(db.$client.prepare('SELECT count(*) AS n FROM record_evidence').get()).toEqual({ n: 0 })
  } finally {
    db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
