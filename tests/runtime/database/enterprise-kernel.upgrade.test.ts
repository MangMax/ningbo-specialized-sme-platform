import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { assertApplicationSchema } from '../../../db/schema-phase'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { createPreEnterpriseKernelFixture, syntheticEnterpriseDictionaries } from '../../support/pre-enterprise-kernel'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { allRosterEnterprises, listRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { addEnterprise } from '../../../layers/core/server/utils/enterprise-kernel'

test('a native database is admitted with the enterprise kernel installed', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    createRuntimeSchema(db)
    expect(() => assertApplicationSchema(db)).not.toThrow()
    expect(db.prepare('SELECT name FROM enterprise_source_channel WHERE code = ?').get('direct'))
      .toEqual({ name: '直接添加' })
  } finally {
    db.close()
  }
})

test('cold upgrade keeps legacy aliases and rejects both a merge cycle and partially installed dictionaries', async () => {
  const { upgradeEnterpriseKernel } = await import('../../../upgrade/enterprise-kernel')
  const db = new Database(':memory:')
  try {
    createPreEnterpriseKernelFixture(db)
    db.exec(`INSERT INTO enterprise(id,name,name_norm,district) VALUES (11,'企业甲','企业甲','前湾新区'),(31,'企业乙','企业乙','未知区');
      INSERT INTO enterprise_alias(id,enterprise_id,name,name_norm,source_kind,created_at) VALUES (41,11,'旧名','旧名','manual','2026-01-01');
      INSERT INTO enterprise_merge VALUES(31,11,'已核','2026-01-01')`)
    const dictionaries = {
      regionSha256: 'a'.repeat(64), industrySha256: 'b'.repeat(64),
      regions: [{ code: '330200', name: '宁波市', parent: null, level: 1 }, { code: '3302821', name: '前湾新区', parent: '330200', level: 2 }],
      industries: [{ code: 'A', inputId: '1', name: '行业', parent: null, level: 0, description: null }],
    }
    expect(() => assertApplicationSchema(db)).toThrow('Enterprise kernel missing')
    const cyclic = new Database(db.serialize())
    try {
      cyclic.pragma('foreign_keys = ON')
      cyclic.exec("DROP TRIGGER enterprise_merge_insert; INSERT INTO enterprise_merge VALUES(11,31,'合并环','2026-01-01')")
      expect(() => upgradeEnterpriseKernel(cyclic, dictionaries)).toThrow('merge cycle')
      expect(() => assertApplicationSchema(cyclic)).toThrow('Enterprise kernel missing')
    } finally { cyclic.close() }
    const broken = { ...dictionaries, industries: [...dictionaries.industries, { code: 'B', inputId: '1', name: '重复', parent: null, level: 0, description: null }] }
    expect(() => upgradeEnterpriseKernel(db, broken)).toThrow('UNIQUE constraint failed')
    expect(() => assertApplicationSchema(db)).toThrow('Enterprise kernel missing')
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='enterprise_region'").get()).toBeUndefined()
    expect(upgradeEnterpriseKernel(db, dictionaries)).toMatchObject({ migrated: true, unmatchedDistricts: [{ district: '未知区', count: 1 }] })
    expect(upgradeEnterpriseKernel(db, dictionaries)).toMatchObject({ migrated: false })
    expect(db.prepare('SELECT enterprise_id,district_code FROM enterprise_directory ORDER BY enterprise_id').all()).toEqual([
      { enterprise_id: 11, district_code: '3302821' }, { enterprise_id: 31, district_code: null },
    ])
    expect(db.prepare('SELECT id,enterprise_id,name FROM enterprise_alias').get()).toEqual({ id: 41, enterprise_id: 11, name: '旧名' })
    const repository = drizzle(db, { schema })
    const direct = addEnterprise(repository, { name: '新基础库企业' })
    expect(listRosterEnterprises(repository, { pageSize: 1 })).toMatchObject({
      rows: [{ enterpriseId: 11 }], counts: { total: 1, titlePairs: 0 },
    })
    expect(allRosterEnterprises(repository, { q: direct.name }).rows).toEqual([])
    db.prepare("UPDATE enterprise SET uscc_norm='91330226MA2CL6FP2U' WHERE id=11").run()
    expect(db.prepare('SELECT alias_id,uscc,renamed_year FROM enterprise_former_name').get())
      .toEqual({ alias_id: 41, uscc: '91330226MA2CL6FP2U', renamed_year: null })
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {
    db.close()
  }
})

test('cold upgrade links a legacy announcement only when its committed byte identity is unique', async () => {
  const { upgradeEnterpriseKernel } = await import('../../../upgrade/enterprise-kernel')
  const db = new Database(':memory:')
  const registered = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  try {
    createPreEnterpriseKernelFixture(db)
    db.exec(`
      INSERT INTO enterprise(id,name,name_norm) VALUES (1,'甲','甲'),(2,'乙','乙');
      INSERT INTO record(id,enterprise_id,title_code,source) VALUES
        (1,1,'specialized_sme','jxj'),(2,2,'specialized_sme','jxj');
      INSERT INTO record_event(id,record_id,event_type,year) VALUES (1,1,'award',2025),(2,2,'award',2025);
      INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES
        (1,1,'unique.pdf',1),(2,2,'conflict.pdf',1);
      INSERT INTO source_document(id,source,title,path) VALUES
        (1,'jxj','唯一版本','unique.pdf'),(2,'jxj','冲突版本','conflict.pdf');
      INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES
        (1,'unique.pdf','unique.pdf','pdf',1,'${registered}','2025-01-01'),
        (2,'conflict.pdf','conflict.pdf','pdf',1,'${registered}','2025-01-01');
      INSERT INTO roster_file_classification(file_id,source,kind) VALUES
        (1,'jxj','announcement'),(2,'jxj','announcement');
    `)
    const batch = db.prepare(`INSERT INTO import_batch
      (idempotency_key,source_kind,source_identity,source_sha256,status,created_at)
      VALUES (?,'announcement',?,?,?,'2025-01-01')`)
    batch.run('unique', 'unique.pdf', registered, 'committed')
    batch.run('duplicate', 'unique.pdf', registered, 'committed')
    batch.run('unknown-hash', 'unique.pdf', null, 'committed')
    batch.run('uncommitted', 'unique.pdf', other, 'preflight')
    batch.run('first', 'conflict.pdf', registered, 'committed')
    batch.run('second', 'conflict.pdf', other, 'committed')

    expect(upgradeEnterpriseKernel(db, syntheticEnterpriseDictionaries)).toMatchObject({
      migrated: true, linked: 1, unresolvedEvidenceIds: [2],
    })
    expect(db.prepare(`SELECT l.enterprise_id, s.file_id, s.version_key
      FROM enterprise_source_link l JOIN enterprise_source s ON s.id=l.source_id`).all())
      .toEqual([{ enterprise_id: 1, file_id: 1, version_key: `1:${registered}` }])
  } finally {
    db.close()
  }
})
