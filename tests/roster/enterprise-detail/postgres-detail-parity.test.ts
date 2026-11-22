import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { expect, it } from 'vitest'
import { enterprise, platformCollectionPage, platformObservationAssignment } from '../../../db/schema'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster-sqlite'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { businessSource, nativeImportDb } from '../imports/fixtures/native-import'

const pgBin = process.env.TEST_ROSTER_DETAIL_PG_BIN

it.runIf(Boolean(pgBin))('preserves archived title scope, original identity and ordered qualification observations in enterprise detail', async () => {
  const dir = mkdtempSync('/tmp/roster-detail-pg-')
  const source = join(dir, 'source.sqlite')
  const pgData = join(dir, 'pg')
  const env = {
    PATH: process.env.PATH, LANG: 'C', PGHOST: dir, PGPORT: '5432', PGDATABASE: 'postgres',
    PGUSER: 'detail_fixture', PGSQL_BIN: join(pgBin!, 'psql'),
  }
  const runPg = (program: string, args: string[]) => execFileSync(join(pgBin!, program), args, { env })
  let started = false
  let client: pg.Client | undefined
  const sqlite = nativeImportDb()
  try {
    installLeadListSchema(sqlite.$client)
    const uscc = '91330110MA2GMDFH58'
    const subject = sqlite.insert(enterprise).values({ name: '合成企业', nameNorm: '合成企业', usccNorm: uscc }).returning().get()
    const queriedAt = '2026-05-31T00:00:00Z'
    const collection = submitNativePlatformQuery(sqlite, {
      ...businessSource(uscc, [
        { sequenceNo: 1, relationKey: 'giant-first', enterpriseId: subject.id, usccRaw: uscc, status: '终审通过', year: 2024, batch: '2024-1' },
        { sequenceNo: 2, relationKey: 'giant-second', enterpriseId: null, usccRaw: uscc, status: '待审核', year: 2025, batch: null },
        { sequenceNo: 3, relationKey: 'specialized', enterpriseId: subject.id, usccRaw: uscc, status: '已退回', year: 2025, batch: '2025-2' },
      ]),
      rdjb: '1,2,3', titleCode: null,
    })
    sqlite.insert(platformCollectionPage).values([
      { collectionId: collection.collectionId, ordinal: 0, source: 'businessList', rdjb: '3', pageNo: 1,
        fetchedCount: 2, status: 'success', sequenceStart: 1, sequenceEnd: 2, positionState: 'verified' },
      { collectionId: collection.collectionId, ordinal: 1, source: 'businessList', rdjb: '2', pageNo: 1,
        fetchedCount: 1, status: 'success', sequenceStart: 3, sequenceEnd: 3, positionState: 'verified' },
    ]).run()
    sqlite.insert(platformObservationAssignment).values({
      observationId: collection.observations[1]!.observationId, revision: 2, enterpriseId: null,
      usccRaw: '91330110MA2GMDFH59', matchBasis: 'none', verificationStatus: 'pending', origin: 'command',
      actor: { type: 'agent', id: 'fixture' }, basis: '更正匹配线索', recordedAt: '2026-06-01T00:00:00Z',
    }).run()
    const asOf = Date.parse('2026-06-02T00:00:00Z')
    const expected = getRosterEnterpriseDetail(sqlite, subject.id, asOf)!
    const observationRows = (detail: typeof expected, title: string) => detail.qualificationAssessment.titles
      .find(item => item.titleCode === title)!.platform.observations.find(item => item.queryId === collection.queryId)!.rows
    const giantRows = [
      { relationId: collection.relationIds[0], status: '终审通过', year: 2024, batch: '2024-1' },
      { relationId: collection.relationIds[1], status: '待审核', year: 2025, batch: null },
    ]
    expect(observationRows(expected, 'little_giant')).toEqual(giantRows)
    expect(observationRows(expected, 'specialized_sme')).toEqual([
      { relationId: collection.relationIds[2], status: '已退回', year: 2025, batch: '2025-2' },
    ])

    await sqlite.$client.backup(source)
    runPg('initdb', ['-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', env.PGUSER, '-D', pgData])
    runPg('pg_ctl', ['-w', '-D', pgData, '-l', join(dir, 'pg.log'), '-o', `-h '' -k ${dir}`, 'start'])
    started = true
    execFileSync(process.execPath, ['upgrade/pg/sqlite-import/stage-sqlite.mjs', source, 'staged'], { env, stdio: 'pipe' })
    for (const layer of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      runPg('psql', ['-Xqw', '-v', 'staging=staged', '-f', `upgrade/pg/sqlite-import/materialize-${layer}.sql`])
    }
    client = new pg.Client({ host: dir, port: 5432, database: env.PGDATABASE, user: env.PGUSER, options: '-c search_path=business,public' })
    await client.connect()
    const actual = await readPostgresRosterEnterpriseDetail(drizzle(client), subject.id, asOf)
    expect(observationRows(actual!, 'little_giant')).toEqual(giantRows)
    expect(JSON.parse(JSON.stringify(actual))).toStrictEqual(JSON.parse(JSON.stringify(expected)))
  } finally {
    sqlite.$client.close()
    try { await client?.end() }
    finally {
      if (started) runPg('pg_ctl', ['-D', pgData, '-w', '-m', 'fast', 'stop'])
      rmSync(dir, { recursive: true, force: true })
    }
  }
}, 30_000)
