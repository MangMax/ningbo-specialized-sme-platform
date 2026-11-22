import { readEffectiveQualifications } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { listCurrentQualified, type CurrentQualifiedFilter } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import { listPostgresCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query-postgres'
import { expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import { schema } from '../../../db/client'
import { drizzle as sqliteDrizzle } from 'drizzle-orm/better-sqlite3'
import { currentDispositions, preflightDisposition, commitDisposition } from '../../../layers/sme-roster/server/utils/title-cycle-disposition'
import { readCurrentQualificationAssessment } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { readPostgresQueryCoverage } from '../../../layers/sme-roster/lib/roster/query-coverage-postgres'
import { readQueryCoverageBatch } from '../../../layers/sme-roster/lib/roster/query-assessment'
import { readTargetIdentityKeyVariants } from '../../../layers/sme-roster/lib/roster/current-identity-keys'
import { createTargetRecognizedWitnessReader } from '../../../layers/sme-roster/lib/roster/recognized-witness-target'
import { readPostgresRecognizedWitnesses } from '../../../layers/sme-roster/lib/roster/recognized-witness-postgres'
import { readPostgresCurrentCandidateIds } from '../../../layers/sme-roster/lib/roster/current-candidates-postgres'
import { createTargetCurrentCandidateReader } from '../../../layers/sme-roster/lib/roster/current-candidates-target'
import { targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { readPostgresCurrentQualification, readPostgresEffectiveQualifications, readPostgresEffectiveQualificationsBatch } from '../../../layers/sme-roster/public'
import { AS_OF_408, currentQualificationFixture, qualificationMatrix, qualificationReferenceLiterals } from '../fixtures/qualification-matrix'

const asOf = Date.parse(AS_OF_408)
const connectionString = process.env.TEST_QUALIFICATION_POSTGRES_URL

it.runIf(!!connectionString)('preserves three-title decisions and the public effective qualification projection', async () => {
  const sqlite = currentQualificationFixture()
  const client = new pg.Client({ connectionString })
  await client.connect()
  let schemaCreated = false
  try {
    const matrix = qualificationMatrix(sqlite.sqlite)
    const db = sqliteDrizzle(sqlite.sqlite, { schema })
    const giant = matrix.formal('保留原认定', [{ eventType: 'award', year: 2019, decidedYear: 2019, batchSeq: 1 }], { title: 'little_giant' })
    const disposed = matrix.formal('生效处置', undefined, { title: 'little_giant' })
    const sourceFile = qualificationReferenceLiterals(sqlite.sqlite).officialFile()
    const award = disposed.events[0]!
    const evidence = db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, award.id)).get()!
    db.update(schema.recordEvent).set({ formalValidity: {
      evidenceId: evidence.id, sourceSha256: sourceFile.sha256!, statementPages: [1],
      interval: { validFrom: '2025-01-01', validThrough: '2026-06-03' },
    } }).where(eq(schema.recordEvent.id, award.id)).run()
    const fact = {
      kind: 'not_applied', source: { fileId: sourceFile.id, sha256: sourceFile.sha256, reference: '第1页', statement: '未申请' },
      cycle: { eventId: award.id, revision: award.revision },
      observed: { precision: 'day', value: '2026-06-01' }, effective: { precision: 'day', value: '2026-06-02' },
      effectiveBasis: '原周期自2026-06-02终止',
    }
    function decide(key: string, operations: unknown[]) {
      const request = {
        idempotencyKey: key, expectedVersion: currentDispositions(db, [disposed.enterprise.id]).version,
        actor: { type: 'agent', id: 'postgres-fixture' }, basis: '已核对公布来源', operations,
      }
      return commitDisposition(db, { request, planHash: preflightDisposition(db, request).planHash })
    }
    const asserted = decide('postgres-fixture-assert', [{ action: 'assert', enterpriseId: disposed.enterprise.id, fact }])
    decide('postgres-fixture-confirm', [{ action: 'confirm', id: asserted.ids[0], revision: 1 }])
    const expired = sqlite.formalEnterprise('旧周期待复核', true)
    const unclear = matrix.formal('原周期缺失', [{ eventType: 'award', year: null, decidedYear: null, batchSeq: null }])
    const recovered = matrix.formal('失败后重新认定', [
      { eventType: 'award', year: 2019, decidedYear: 2019, batchSeq: 1 },
      { eventType: 'review', year: 2019, decidedYear: 2022, batchSeq: 1, reviewOutcome: 'failed' },
      { eventType: 'award', year: 2024, decidedYear: 2024, batchSeq: 2 },
    ], { title: 'little_giant' })
    const mergedFrom = db.insert(schema.enterprise).values({ name: '已归并', nameNorm: '已归并' }).returning().get()
    db.insert(schema.enterpriseMerge).values({ fromEnterpriseId: mergedFrom.id, intoEnterpriseId: recovered.enterprise.id,
      basis: '确认归并', recordedAt: AS_OF_408 }).run()
    db.insert(schema.enterpriseFactRevision).values({
      enterpriseId: mergedFrom.id, factId: 1, revision: 1, status: 'confirmed',
      fact: { kind: 'cancelled', source: { reference: 'fixture', statement: '已确认注销' },
        effective: { precision: 'day', value: '2026-01-01' }, observed: { precision: 'day', value: '2026-01-01' }, city: null },
      action: 'assert', actor: { type: 'agent', id: 'fixture' }, basis: '确认依据', createdAt: AS_OF_408,
    }).run()
    const platformOnly = db.insert(schema.enterprise).values({
      name: '平台资格', nameNorm: '平台资格', usccNorm: '91330110MA2GMDFH58', city: '宁波市',
    }).returning().get()
    submitSyntheticRecognizedCollection(db, { rdjb: '2', queriedAt: '2026-04-01T00:00:00Z', rows: [{
      enterpriseId: null, raw: { id: 'qual-' + platformOnly.id, qymc: '旧平台名称', tyshxydm: platformOnly.usccNorm!,
        rdjb: '2', rdtime: '2025-01-01', rddqrq: '2026-06-01', sfyx: '0', szsmc: '宁波市' },
    }] })
    for (const [enterprise, rdjb] of [[platformOnly, '2'], [unclear.enterprise, '1']] as const) {
      const rawCode = enterprise.id === platformOnly.id
        ? ' ' + enterprise.usccNorm!.slice(0, 6).toLowerCase() + '\u200b' + enterprise.usccNorm!.slice(6).toLowerCase()
        : enterprise.usccNorm!
      submitSyntheticRecognizedCollection(db, {
        rdjb, queriedAt: '2026-05-01T00:00:00Z', rows: [{ enterpriseId: null, raw: {
          id: 'qual-' + enterprise.id, qymc: '平台原名', tyshxydm: rawCode, rdjb,
          rdtime: '2025-01-01', rddqrq: '2026-06-01', sfyx: enterprise.id === platformOnly.id ? 1 : '1', szsmc: '宁波市',
        } }],
      })
    }
    const recognized = submitSyntheticRecognizedCollection(db, { rdjb: '1', queriedAt: '2026-05-03T00:00:00Z',
      conditions: { uscc: platformOnly.usccNorm!, rddqrq: '2026', whpcyear: '2025', whpc: '2' }, rows: [{ enterpriseId: platformOnly.id,
        raw: { id: 'witness-' + platformOnly.id, qymc: '平台原名', tyshxydm: platformOnly.usccNorm!,
          rdjb: '1', rddqrq: '2026-06-01', whpc: '2025-2' } }],
    })
    const coverageIds = [platformOnly, unclear.enterprise]
    const subjects = coverageIds.map(enterprise => ({ id: enterprise.id, name_norm: enterprise.nameNorm, uscc_norm: enterprise.usccNorm }))
    const titles = ['specialized_sme', 'innovative_sme'] as const
    const expectedCoverage = readQueryCoverageBatch(db, subjects.flatMap(({ id }) => titles.map(titleCode =>
      ({ enterpriseId: id, titleCode, direction: 'missing_in_miit' as const }))), readTargetIdentityKeyVariants(sqlite.sqlite, 'queries'))
    const witnessReader = createTargetRecognizedWitnessReader(sqliteDrizzle(sqlite.sqlite, { schema: targetSchema }))
    const witnessInput = { enterpriseId: platformOnly.id, uscc: platformOnly.usccNorm, relationIds: recognized.relationIds }
    const expectedWitnesses = witnessReader.readMany(witnessInput)
    expect([...expectedWitnesses.values()]).toEqual([expect.objectContaining({ kind: 'available',
      source: expect.objectContaining({ rawValid: '2026-06-01', rawMaintenanceBatch: '2025-2' }) })])
    const empty = sqlite.sqlite.prepare('insert into enterprise (name, name_norm) values (?, ?) returning id').get('无称号', '无称号') as { id: number }

    await client.query('CREATE SCHEMA business')
    schemaCreated = true
    await client.query('SET search_path TO business, public')
    await copyQualificationsFixture(client, sqlite.sqlite)
    const postgres = drizzle(client)
    await expect(postgres.transaction(tx => readPostgresEffectiveQualifications(tx, giant.enterprise.id, asOf)))
      .rejects.toThrow('PostgreSQL qualification requires a repeatable-read or serializable transaction')
    await postgres.transaction(async tx => {
      const candidates = createTargetCurrentCandidateReader(sqliteDrizzle(sqlite.sqlite, { schema: targetSchema }))
      for (const title of ['innovative_sme', 'specialized_sme', 'little_giant'] as const) {
        for (const sort of ['id_asc', 'name_asc', 'name_desc'] as const) {
          expect(await readPostgresCurrentCandidateIds(tx, title, sort)).toEqual([...candidates.iterate(title, sort)].map(row => row.id))
        }
      }
      expect(await readPostgresQueryCoverage(tx, subjects, titles)).toEqual(expectedCoverage)
      expect((await readPostgresRecognizedWitnesses(tx, witnessInput.relationIds))(witnessInput)).toEqual(expectedWitnesses)
      expect(await readPostgresEffectiveQualifications(tx, 999, asOf)).toBeNull()
      expect(await readPostgresEffectiveQualifications(tx, empty.id, asOf)).toEqual([])
      const qualification = await readPostgresCurrentQualification(tx, giant.enterprise.id, asOf)
      expect(qualification?.titles.map(title => [title.titleCode, title.effectiveQualification.status, title.effectiveQualification.supportingTitle])).toEqual([
        ['little_giant', 'effective', undefined],
        ['specialized_sme', 'effective', 'little_giant'],
        ['innovative_sme', 'effective', 'little_giant'],
      ])
      for (const id of [giant.enterprise.id, disposed.enterprise.id, expired.enterprise.id, unclear.enterprise.id, mergedFrom.id, platformOnly.id]) {
        expect(await readPostgresEffectiveQualifications(tx, id, asOf)).toEqual(readEffectiveQualifications(sqlite.sqlite, id, asOf))
        const actual = await readPostgresCurrentQualification(tx, id, asOf)
        const expected = readCurrentQualificationAssessment(sqlite.sqlite, id, asOf)
        for (const [index, title] of actual!.titles.entries()) {
          const { titleCode, group, cycles, officialQualification, subject, region, evidence, sourceVersions, shadow } = expected.titles[index]!
          expect(title).toMatchObject({ titleCode, group, cycles, officialQualification, subject, region, evidence, sourceVersions, shadow })
        }
      }
      expect((await readPostgresCurrentQualification(tx, expired.enterprise.id, asOf))?.titles[2]).toMatchObject({
        group: 'excluded', effectiveQualification: { status: 'expired' },
        officialQualification: { group: 'excluded' },
      })
      expect((await readPostgresCurrentQualification(tx, unclear.enterprise.id, asOf))?.titles[2]).toMatchObject({
        group: 'excluded', effectiveQualification: { status: 'expired' },
        officialQualification: { group: 'excluded' }, applicablePublication: true, fieldGaps: expect.arrayContaining([expect.objectContaining({ field: 'year', valueState: 'unknown' })]),
        evidence: [{ year: null, decidedYear: null, batchSeq: null }],
      })
      expect((await readPostgresCurrentQualification(tx, mergedFrom.id, asOf))?.titles.map(title => title.effectiveQualification.status))
        .toEqual(['terminated', 'terminated', 'terminated'])
      expect((await readPostgresCurrentQualification(tx, platformOnly.id, asOf))?.titles[1]).toMatchObject({
        group: 'eligible', applicablePublication: false,
        effectiveQualification: { status: 'effective', source: { source: 'recognized_list', statusRaw: 1 } },
      })
      expect((await readPostgresCurrentQualification(tx, disposed.enterprise.id, asOf))?.titles[0]).toMatchObject({
        group: 'eligible', sourceVersions: [{ sha256: sourceFile.sha256 }],
        evidence: [{ formalValidity: { interval: { validThrough: '2026-06-03' } }, validityInvalid: false }],
      })
      expect(await readPostgresEffectiveQualifications(tx, disposed.enterprise.id, asOf + 16 * 3600000)).toEqual([])
      const sampled = [giant.enterprise.id, disposed.enterprise.id, expired.enterprise.id, unclear.enterprise.id,
        mergedFrom.id, recovered.enterprise.id, platformOnly.id, empty.id]
      const ids = [giant.enterprise.id, ...Array.from({ length: 130 }, (_, index) => index + 1000), ...sampled]
      const qualifications = await readPostgresEffectiveQualificationsBatch(tx, ids, asOf)
      expect(qualifications).toEqual(new Map(sampled.map(id => [id, readEffectiveQualifications(sqlite.sqlite, id, asOf)])))
      expect(await readPostgresEffectiveQualificationsBatch(tx, sampled, asOf)).toEqual(qualifications)
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    const filters: CurrentQualifiedFilter[] = [
      { titleCode: 'little_giant', status: 'effective', pageSize: 2 },
      { titleCode: 'specialized_sme', sort: 'name_desc', pageSize: 2 },
      { titleCode: 'specialized_sme', q: platformOnly.name, validYear: 2026 },
      { titleCode: 'innovative_sme', status: 'unrecognized', sort: 'name_asc', pageSize: 2, page: 2 },
      { titleCode: 'innovative_sme', recognitionFrom: '2019-02-01', recognitionTo: '2025-01-01', pageSize: 1 },
    ]
    for (const filter of filters) {
      const actual = await listPostgresCurrentQualified(postgres, filter, asOf)
      vi.setSystemTime(new Date(asOf))
      try { expect(actual, JSON.stringify(filter)).toEqual(listCurrentQualified(sqlite.sqlite, filter)) }
      finally { vi.useRealTimers() }
    }
  } finally {
    sqlite.close()
    try {
      if (schemaCreated) await client.query('DROP SCHEMA business CASCADE')
    } finally {
      await client.end()
    }
  }
})

async function copyQualificationsFixture(client: pg.Client, sqlite: ReturnType<typeof currentQualificationFixture>['sqlite']) {
  const tables = [
    'enterprise', 'enterprise_merge', 'enterprise_alias', 'enterprise_fact_revision',
    'record', 'record_event', 'record_evidence', 'stored_file', 'title_cycle_disposition_revision',
    'official_evidence_row_revision', 'platform_collection', 'platform_business_observation',
    'platform_recognized_projection', 'platform_business_projection', 'platform_apply_projection',
    'platform_observation_assignment', 'platform_legacy_query_alias', 'platform_legacy_relation_alias',
    'platform_collection_page', 'platform_collection_condition', 'platform_collection_unfinished',
    'platform_query_title_scope', 'platform_collection_archive_ref', 'platform_observation_archive_ref', 'platform_archive_value',
    'platform_business_record', 'record_correspondence', 'difference_reason', 'title', 'platform_export_row', 'platform_export_batch',
    'service_credential',
  ]
  for (const table of tables) {
    const columns = sqlite.pragma(`table_info(${table})`) as { name: string; type: string }[]
    const fields = columns.map(column => '"' + column.name + '"')
    const mixedColumns = table === 'platform_recognized_projection' ? ['source_valid_flag']
      : table === 'platform_collection_condition' ? ['witness_value'] : table === 'platform_business_projection' ? ['stored_status', 'exact_status', 'exact_year', 'exact_batch'] : []
    fields.push(...mixedColumns.map(name => 'typeof(' + name + ')'))
    const targetFields = columns.map(({ name, type }) => `"${name}" ${/int/i.test(type) ? 'bigint' : /blob/i.test(type) ? 'bytea' : 'text'}`)
    targetFields.push(...mixedColumns.map(name => name + '_sqlite_storage text'))
    if (table === 'official_evidence_row_revision') {
      targetFields.push('name_raw_json text', 'uscc_raw_json text', 'district_raw_json text')
    }
    await client.query(`create table "${table}" (${targetFields.join(', ')})`)
    for (const raw of sqlite.prepare(`select ${fields.join(', ')} from "${table}"`).raw().all()) {
      const row = raw as unknown[]
      for (const [offset, name] of mixedColumns.entries()) {
        const storage = row[columns.length + offset]
        const index = columns.findIndex(column => column.name === name)
        if (storage === 'integer' || storage === 'real') {
          const bytes = Buffer.alloc(8)
          if (storage === 'integer') bytes.writeBigInt64BE(BigInt(row[index] as number))
          else bytes.writeDoubleBE(row[index] as number)
          row[index] = bytes
        } else if (storage === 'text') row[index] = Buffer.from(row[index] as string)
      }
      await client.query(`insert into "${table}" values (${fields.map((_, i) => '$' + (i + 1)).join(', ')})`, row)
    }
  }
}
