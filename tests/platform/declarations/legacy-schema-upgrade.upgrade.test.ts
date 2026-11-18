import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { initializeDb, schema } from '../../../upgrade/legacy-client'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as currentSchema from '../../../db/schema'
import { getParse105 } from '../../../server/utils/parse-maintenance-105'
import { listStoredFiles } from '../../../server/utils/stored-files'
import { upgradeRosterFileClassification } from '../../../upgrade/roster-file-classification'

it("migrates legacy descriptors additively and serves durable identities without GET writes", async () => {
  const root = mkdtempSync('/tmp/migration681-'), migrations = join(root, 'migrations')
  mkdirSync(join(migrations, 'meta'), { recursive: true })
  for (const file of readdirSync('db/migrations').filter(f => f.endsWith('.sql') && !f.startsWith('0046'))) copyFileSync(join('db/migrations', file), join(migrations, file))
  const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8'))
  journal.entries = journal.entries.filter((e: {idx: number}) => e.idx < 46)
  writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify(journal))
  const dbPath = join(root, 'fixture.sqlite')
  const old = initializeDb({ create: true, dbPath, migrationsFolder: migrations })
  const f = old.insert(schema.storedFile).values({ relPath: 'legacy.pdf', filename: 'legacy.pdf', ext: 'pdf', bytes: 1, sha256: 'legacy-source' }).returning().get()
  const part = { titleCode: 'specialized_sme', eventKind: 'award' as const, year: null, batch: 2, attachment: null, rowCount: 41 }
  old.insert(schema.storedFilePart).values({ fileId: f.id, ...part, origin: 'legacy' }).run()
  const original = old.select().from(schema.storedFilePart).all()
  old.$client.close()
  const db = initializeDb({ dbPath })
  upgradeRosterFileClassification(db.$client)
  const changes = () => db.$client.prepare('select total_changes() as n').get()
  const before = changes()
  const currentDb = drizzle(db.$client, { schema: currentSchema })
  const server = createServer(toNodeListener(createApp().use(defineEventHandler(() => ({ state: getParse105(currentDb, f.id), list: listStoredFiles(currentDb, {}).rows })))) )
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('missing port')
    const url = `http://127.0.0.1:${address.port}`
    const first = await (await fetch(url)).json()
    expect(first.state.declarations).toHaveLength(1)
    expect(first.state.declarations[0]).toMatchObject({ declarationId: '68100000-0000-4000-8000-000000000001', displaySequence: 1, part, pageRanges: null })
    expect(first.list[0].registeredSummary).toEqual(first.state.registeredSummary)
    expect(await (await fetch(url)).json()).toEqual(first)
    expect(changes()).toEqual(before)
    expect(db.select().from(schema.storedFilePart).all()).toEqual(original)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close()
  }
})
