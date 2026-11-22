import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { expect, it } from 'vitest'
import { decisionHistory102, internalDecisionCommand102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102'
import {
  currentPostgresDecisions102, historyPostgresDecision102, readPostgresDecision102,
  readPostgresQualificationDecisionHeads,
} from '../../../layers/sme-roster/server/utils/decision-lifecycle-102/postgres-reads'
import { savePostgresDecision102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102/postgres-writes'

const pgBin = process.env.TEST_IMPORT_RECEIPTS_PG_BIN

it.runIf(!!pgBin)('keeps withdrawn decision versions and original scope order in PostgreSQL', async () => {
  const dir = mkdtempSync('/tmp/roster-decision-pg-')
  const cluster = join(dir, 'cluster')
  const run = (name: string, args: string[]) => execFileSync(join(pgBin!, name), args, { stdio: 'pipe' })
  let started = false
  let pool: pg.Pool | undefined
  try {
    run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8'])
    run('pg_ctl', ['-D', cluster, '-l', join(dir, 'pg.log'), '-o', "-h '' -k " + dir, '-w', 'start'])
    started = true
    pool = new pg.Pool({ host: dir, database: 'postgres', user: 'fixture', options: '-c search_path=business,public' })
    await pool.query(`
      CREATE SCHEMA business;
      CREATE TABLE enterprise (id bigint PRIMARY KEY, name_norm text NOT NULL, uscc_norm text);
      INSERT INTO enterprise VALUES (7, 'synthetic-enterprise', NULL);
      CREATE TABLE platform_collection (id bigint, public_id bigint);
      CREATE TABLE platform_business_observation (id bigint, public_id bigint);
      ${readFileSync(new URL('../../../db/postgresql/roster-review-schema.sql', import.meta.url), 'utf8')}
    `)
    const db = drizzle({ client: pool })
    const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' } as const
    const empty = { ...scope, direction: 'extra_in_miit' } as const
    const command = internalDecisionCommand102.parse({
      ...scope, action: 'replace', expectedCurrentId: null, idempotencyKey: 'decision-create',
      actor: { type: 'agent', id: 'fixture-agent' }, basis: '已核对合成证据', ruleVersion: 'fixture-v1', effectiveAt: '2026-11-10T01:02:03Z',
      decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' },
    })
    const created = await savePostgresDecision102(db, command)
    const id = created.versionId as number
    expect(id).toBeTypeOf('number')
    expect(await savePostgresDecision102(db, command)).toEqual(created)
    expect(await currentPostgresDecisions102(db, [empty, scope, empty])).toEqual([
      { ...empty, versionId: null, current: null },
      { ...scope, versionId: id, current: expect.objectContaining({
        id, isCurrent: true, actor: command.actor, status: 'confirmed_no_diff',
        evidenceQueryId: null, evidenceRelationId: null,
      }) },
      { ...empty, versionId: null, current: null },
    ])
    const withdraw = internalDecisionCommand102.parse({
      ...command, action: 'withdraw', expectedCurrentId: id, idempotencyKey: 'decision-withdraw', decision: undefined,
    })
    const withdrawn = await savePostgresDecision102(db, withdraw)
    expect(withdrawn).toMatchObject({ action: 'withdraw', previousId: id, currentId: null })
    expect(await currentPostgresDecisions102(db, [scope])).toEqual([{ ...scope, versionId: withdrawn.versionId, current: null }])
    expect(await readPostgresQualificationDecisionHeads(db, 7, ['specialized_sme'])).toEqual([
      expect.objectContaining({ id: withdrawn.versionId, lifecycleAction: 'withdraw' }),
    ])
    expect(await readPostgresDecision102(db, id)).toMatchObject({ id, isCurrent: false })
    expect(await historyPostgresDecision102(db, decisionHistory102.parse({ id, page: 1, pageSize: 1 }))).toMatchObject({
      total: 2, page: 1, pageSize: 1, rows: [{ id: withdrawn.versionId, isCurrent: true, lifecycleAction: 'withdraw' }],
    })
  } finally {
    try { await pool?.end() }
    finally {
      if (started) run('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop'])
      rmSync(dir, { recursive: true, force: true })
    }
  }
}, 20_000)
