import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { assertApplicationSchema } from '../../../db/schema-phase'
import { createRuntimeSchema } from '../../../db/create-runtime'

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
    db.pragma('foreign_keys = ON')
    createRuntimeSchema(db)
    // Restore the previous runtime shape by removing the additive objects only.
    const extension = db.prepare(`SELECT name,type FROM sqlite_schema
      WHERE name IN ('roster_announcement_intake','enterprise_kernel_completion','enterprise_directory','enterprise_former_name',
        'enterprise_source_link','enterprise_source','enterprise_source_channel','enterprise_source_list_type','enterprise_region','enterprise_industry',
        'enterprise_former_name_insert','enterprise_former_name_reassign','enterprise_former_name_uscc',
        'enterprise_directory_identity_revision','enterprise_source_follow_merge')
      ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END,
        CASE name WHEN 'enterprise_source_link' THEN 0 WHEN 'enterprise_source' THEN 1 WHEN 'enterprise_directory' THEN 2 ELSE 3 END`).all() as { name: string; type: string }[]
    for (const { name, type } of extension) db.exec(`DROP ${type} ${name}`)
    db.pragma('user_version = 71613')
    db.exec(`INSERT INTO enterprise(id,name,name_norm,district) VALUES (11,'企业甲','企业甲','前湾新区'),(31,'企业乙','企业乙','未知区');
      INSERT INTO enterprise_alias(id,enterprise_id,name,name_norm,source_kind,created_at) VALUES (41,11,'旧名','旧名','manual','2026-01-01');
      INSERT INTO enterprise_merge VALUES(31,11,'已核','2026-01-01'),(11,31,'合并环','2026-01-01')`)
    const dictionaries = {
      regionSha256: 'a'.repeat(64), industrySha256: 'b'.repeat(64),
      regions: [{ code: '330200', name: '宁波市', parent: null, level: 1 }, { code: '3302821', name: '前湾新区', parent: '330200', level: 2 }],
      industries: [{ code: 'A', inputId: '1', name: '行业', parent: null, level: 0 }],
    }
    expect(() => assertApplicationSchema(db)).toThrow('Enterprise kernel missing')
    expect(() => upgradeEnterpriseKernel(db, dictionaries)).toThrow('merge cycle')
    db.exec('DELETE FROM enterprise_merge WHERE from_enterprise_id=11')
    const broken = { ...dictionaries, industries: [...dictionaries.industries, { code: 'B', inputId: '1', name: '重复', parent: null, level: 0 }] }
    expect(() => upgradeEnterpriseKernel(db, broken)).toThrow('UNIQUE constraint failed')
    expect(() => assertApplicationSchema(db)).toThrow('Enterprise kernel missing')
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='enterprise_region'").get()).toBeUndefined()
    expect(upgradeEnterpriseKernel(db, dictionaries)).toMatchObject({ migrated: true, unmatchedDistricts: [{ district: '未知区', count: 1 }] })
    expect(upgradeEnterpriseKernel(db, dictionaries)).toMatchObject({ migrated: false })
    expect(db.prepare('SELECT enterprise_id,district_code FROM enterprise_directory ORDER BY enterprise_id').all()).toEqual([
      { enterprise_id: 11, district_code: '3302821' }, { enterprise_id: 31, district_code: null },
    ])
    expect(db.prepare('SELECT id,enterprise_id,name FROM enterprise_alias').get()).toEqual({ id: 41, enterprise_id: 11, name: '旧名' })
    db.prepare("UPDATE enterprise SET uscc_norm='91330226MA2CL6FP2U' WHERE id=11").run()
    expect(db.prepare('SELECT alias_id,uscc,renamed_year FROM enterprise_former_name').get())
      .toEqual({ alias_id: 41, uscc: '91330226MA2CL6FP2U', renamed_year: null })
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {
    db.close()
  }
})
