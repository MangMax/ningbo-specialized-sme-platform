import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../../../db/schema'

/**
 * 合并 main 后的导出请求迁移回归（#116 集成 r1）。
 *
 * 背景：spec116 分支的 `0023_current_export_requests.sql` 与 main 的
 * `0023_evidence_impact_113.sql` / `0024_evidence_review_114.sql` 序号相撞。
 * 合并时保留 main 23/24 的 idx/tag/when 不变，本分支迁移顺延为
 * `0025_current_export_requests`（when=1792400021006，紧接 main 的 …005）。
 *
 * 这些用例断言的是**真实库行为**（表/索引是否存在、唯一约束是否真的拒绝重复、
 * 旧数据是否还在），不是把 `_journal.json` 的数组抄一遍。
 *
 * drizzle 按 `when` 时间戳判断“已应用”（`max(created_at) < folderMillis`），
 * 所以三种库起点必须分别验证：
 *   1. 全新库 —— 全量迁移；
 *   2. 已应用过旧 0023 的历史库 —— 升级不得重复建索引、不得丢请求；
 *   3. 已在 main 线上的库 —— 补上导出索引，且不重跑 main 的迁移。
 */

const migrationsFolder = resolve('db/migrations')
interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
  version: number
  dialect: string
  entries: JournalEntry[]
}

/** 旧分支的导出迁移：文件名、tag、时间戳都不同于合并后的 0025。 */
const RETIRED_TAG = '0023_current_export_requests'
const RETIRED_WHEN = 1792400021004
const RETIRED_SQL = "CREATE UNIQUE INDEX job_export_request_uq ON job(kind, json_extract(params, '$.clientRequestId')) WHERE kind = 'current-roster-export';\n"

function objectNames(sqlite: Database.Database, type: 'table' | 'index') {
  return sqlite
    .prepare(`select name from sqlite_master where type='${type}' and name not like 'sqlite_%' order by name`)
    .all()
    .map(row => (row as { name: string }).name)
}

function assertCompleteSchema(sqlite: Database.Database) {
  const fresh = new Database(':memory:')
  try {
    fresh.pragma('foreign_keys = ON')
    migrate(drizzle(fresh, { schema }), { migrationsFolder })
    const definitions = (db: Database.Database) => db.prepare("select type,name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all().map(row => {
      const value = row as { type: string; name: string; sql: string | null }
      return { ...value, sql: value.sql?.replace(/IF NOT EXISTS /gi, '') }
    })
    expect(definitions(sqlite)).toEqual(definitions(fresh))
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  } finally { fresh.close() }
}

function ledger(sqlite: Database.Database) {
  return sqlite.prepare('select id, hash, created_at from __drizzle_migrations order by id').all() as { id: number; hash: string; created_at: number }[]
}

function insertExportJob(sqlite: Database.Database, id: string, clientRequestId: string) {
  sqlite
    .prepare(
      `insert into job(id,kind,params,state,progress,created_at) values (?, 'current-roster-export', ?, 'queued', '{}', '2026-01-01')`,
    )
    .run(id, JSON.stringify({ titleCode: 'little_giant', clientRequestId }))
}

/**
 * 造一个“历史库”迁移目录：真实迁移文件 + 一条被合并取代的旧导出迁移。
 * 旧迁移用的是没有 IF NOT EXISTS 的原始 SQL，所以升级路径必须靠合并后的
 * 迁移自身幂等，否则整批迁移会回滚。
 */
function retiredBaseline(dir: string) {
  const baseline = join(dir, 'retired')
  mkdirSync(join(baseline, 'meta'), { recursive: true })
  const entries: JournalEntry[] = []
  for (const entry of journal.entries) {
    if (entry.tag === '0023_evidence_impact_113') {
      entries.push({ idx: 23, version: '6', when: RETIRED_WHEN, tag: RETIRED_TAG, breakpoints: true })
      break
    }
    entries.push(entry)
  }
  for (const entry of entries) {
    if (entry.tag === RETIRED_TAG) writeFileSync(join(baseline, `${entry.tag}.sql`), RETIRED_SQL)
    else cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(baseline, `${entry.tag}.sql`))
  }
  writeFileSync(join(baseline, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  return baseline
}

/** 已在 main 线上的库：合并前的全部迁移都跑过了，只差导出索引。 */
function mainBaseline(dir: string) {
  const baseline = join(dir, 'mainline')
  mkdirSync(join(baseline, 'meta'), { recursive: true })
  const entries = journal.entries.filter(entry => entry.idx < 25)
  for (const entry of entries) cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(baseline, `${entry.tag}.sql`))
  writeFileSync(join(baseline, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  return baseline
}

it('applies main evidence migrations and the export-request unique index on a fresh database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'export025-fresh-'))
  const sqlite = new Database(join(dir, 'fresh.db'))
  try {
    sqlite.pragma('foreign_keys = ON')
    migrate(drizzle(sqlite, { schema }), { migrationsFolder })

    // main 的 23/24 没有被丢掉：#113 / #114 的表真的建出来了。
    expect(objectNames(sqlite, 'table')).toEqual(
      expect.arrayContaining([
        'evidence_revision_113',
        'evidence_semantic_head_113',
        'evidence_impact_progress_113',
        'explanation_impact_113',
        'evidence_impact_link_113',
        'evidence_revision_event_113',
        'evidence_scope_version_113',
        'evidence_review_receipt_114',
        'evidence_rule_release_114',
      ]),
    )
    // 导出请求的唯一索引真的存在，而且只有一条。
    expect(objectNames(sqlite, 'index').filter(name => name === 'job_export_request_uq')).toHaveLength(1)

    // 唯一约束真的生效：同一 clientRequestId 被拒绝，不同的被接受。
    insertExportJob(sqlite, 'J1', 'same-key')
    expect(() => insertExportJob(sqlite, 'J2', 'same-key')).toThrow(/UNIQUE/)
    expect(() => insertExportJob(sqlite, 'J3', 'other-key')).not.toThrow()

    // 重跑迁移是幂等的：账本不增行。
    assertCompleteSchema(sqlite)
    const before = ledger(sqlite)
    migrate(drizzle(sqlite, { schema }), { migrationsFolder })
    expect(ledger(sqlite)).toEqual(before)
  } finally {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('restores skipped evidence schema on the retired export lineage while retaining requests and artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'export025-retired-'))
  const sqlite = new Database(join(dir, 'retired.db'))
  try {
    sqlite.pragma('foreign_keys = ON')
    // 历史库：只有旧分支的迁移跑过（含旧的 0023 导出迁移，没有 IF NOT EXISTS）。
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: retiredBaseline(dir) })
    const before = ledger(sqlite)
    insertExportJob(sqlite, 'OLD1', 'legacy-1')
    insertExportJob(sqlite, 'OLD2', 'legacy-2')
    sqlite.prepare(`insert into job(id,kind,params,state,progress,created_at) values ('OTHER','ocr','{}','queued','{}','2026-01-01')`).run()

    sqlite.prepare("update job set state='done', result=?, finished_at='2026-01-02' where id='OLD1'").run(JSON.stringify({ artifacts: [{ id: 'artifact-1', relativePath: 'synthetic/export.xlsx', sha256: 'fixture-digest', expiresAt: '2026-01-09' }] }))
    const jobsBefore = sqlite.prepare('select * from job order by id').all()

    // 升级到合并后的迁移目录：不得因为索引已存在而整批回滚。
    expect(() => migrate(drizzle(sqlite, { schema }), { migrationsFolder })).not.toThrow()

    assertCompleteSchema(sqlite)
    expect(sqlite.prepare('select * from job order by id').all()).toEqual(jobsBefore)

    // 旧账本原样保留，只追加新迁移。
    const after = ledger(sqlite)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.length).toBeGreaterThan(before.length)

    // 导出请求一条不少，别的 kind 也不受影响。
    expect(sqlite.prepare(`select id from job where kind='current-roster-export' order by id`).all()).toEqual([{ id: 'OLD1' }, { id: 'OLD2' }])
    expect(sqlite.prepare(`select json_extract(params,'$.clientRequestId') as k from job where kind='current-roster-export' order by id`).all()).toEqual([{ k: 'legacy-1' }, { k: 'legacy-2' }])
    expect(sqlite.prepare(`select count(*) as n from job`).get()).toEqual({ n: 3 })

    // 索引仍然只有一条，唯一性仍然生效。
    expect(objectNames(sqlite, 'index').filter(name => name === 'job_export_request_uq')).toHaveLength(1)
    expect(() => insertExportJob(sqlite, 'OLD3', 'legacy-1')).toThrow(/UNIQUE/)
    expect(() => insertExportJob(sqlite, 'OLD4', 'legacy-3')).not.toThrow()
    migrate(drizzle(sqlite, { schema }), { migrationsFolder })
    expect(ledger(sqlite)).toEqual(after)
    assertCompleteSchema(sqlite)
  } finally {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('adds the export-request index to a database already on the main line without re-running main migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'export025-mainline-'))
  const sqlite = new Database(join(dir, 'mainline.db'))
  try {
    sqlite.pragma('foreign_keys = ON')
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: mainBaseline(dir) })
    sqlite.prepare("insert into evidence_scope_version_113 values ('retained-scope', 7, 2)").run()
    const before = ledger(sqlite)
    expect(objectNames(sqlite, 'index')).not.toContain('job_export_request_uq')

    migrate(drizzle(sqlite, { schema }), { migrationsFolder })

    assertCompleteSchema(sqlite)

    // main 的迁移没有被重跑，账本只追加了导出迁移及其后的增量迁移。
    const after = ledger(sqlite)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.length).toBe(before.length + journal.entries.filter(entry => entry.idx >= 25).length)
    expect(objectNames(sqlite, 'table')).toEqual(expect.arrayContaining(['evidence_revision_113', 'evidence_review_receipt_114']))
    expect(objectNames(sqlite, 'index').filter(name => name === 'job_export_request_uq')).toHaveLength(1)

    expect(sqlite.prepare("select * from evidence_scope_version_113 where scope_key='retained-scope'").get()).toEqual({ scope_key: 'retained-scope', latest_revision_id: 7, pending_count: 2 })
    migrate(drizzle(sqlite, { schema }), { migrationsFolder })
    expect(ledger(sqlite)).toEqual(after)
    insertExportJob(sqlite, 'M1', 'main-line-key')
    expect(() => insertExportJob(sqlite, 'M2', 'main-line-key')).toThrow(/UNIQUE/)
  } finally {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
