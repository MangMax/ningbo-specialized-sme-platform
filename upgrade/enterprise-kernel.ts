import type Database from 'better-sqlite3'
import { normalizeReviewedUscc, usccFormatVerdict } from '../layers/core/public'
import { assertFinalPlatformRuntime, assertRosterFileClassificationSchema, assertApplicationSchema } from '../db/schema-phase'
import { ENTERPRISE_KERNEL_RUNTIME_VERSION, ENTERPRISE_KERNEL_VERSION, installEnterpriseAddressSchema, installEnterpriseKernelSchema } from '../db/enterprise-kernel-schema'
import { installEnterpriseDictionaries, type EnterpriseDictionaries } from './enterprise-dictionaries'

function enterpriseMigrationPreflight(db: Database.Database) {
  const terminals = new Map<number, number>()
  const ids = new Set(db.prepare('SELECT id FROM enterprise').pluck().all() as number[])
  const merges = new Map((db.prepare('SELECT from_enterprise_id AS source, into_enterprise_id AS target FROM enterprise_merge')
    .all() as { source: number; target: number }[]).map(({ source, target }) => [source, target]))
  for (const id of ids) {
    const path = new Set<number>()
    let cursor = id
    while (merges.has(cursor) && !terminals.has(cursor)) {
      if (path.has(cursor)) throw new Error(`Enterprise merge cycle at ${cursor}`)
      path.add(cursor)
      cursor = merges.get(cursor)!
    }
    if (!ids.has(cursor)) throw new Error(`Unknown merge target ${cursor}`)
    const target = terminals.get(cursor) ?? cursor
    for (const member of path) terminals.set(member, target)
    terminals.set(id, target)
  }

  const normalized = new Map<string, { id: number; original: string }[]>()
  for (const { id, uscc } of db.prepare('SELECT id, uscc_norm AS uscc FROM enterprise WHERE uscc_norm IS NOT NULL').all() as { id: number; uscc: string }[]) {
    const key = normalizeReviewedUscc(uscc)
    const rows = normalized.get(key) ?? []
    rows.push({ id, original: uscc })
    normalized.set(key, rows)
  }
  // Report actual legacy values and collisions without changing any legacy key.
  const legacyUscc = [...normalized].filter(([key, rows]) =>
    usccFormatVerdict(key) !== 'ok' || rows.length > 1 || rows.some(row => row.original !== key))
    .map(([normalizedUscc, rows]) => ({ normalizedUscc, rows }))
  return { terminals, legacyUscc }
}

function ensureEnterpriseAddresses(db: Database.Database) {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='enterprise_address'").get()
  if (!exists) installEnterpriseAddressSchema(db)
  assertApplicationSchema(db)
  return !exists
}

export function upgradeEnterpriseAddresses(db: Database.Database) {
  if (db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('Offline address upgrade requires its own transaction with foreign_keys=ON')
  }
  return db.transaction(() => {
    if (assertFinalPlatformRuntime(db) !== ENTERPRISE_KERNEL_RUNTIME_VERSION) {
      throw new Error('Address upgrade requires a database with the enterprise kernel installed')
    }
    return { migrated: ensureEnterpriseAddresses(db) }
  }).immediate()
}

export function upgradeEnterpriseKernel(db: Database.Database, dictionaries: EnterpriseDictionaries) {
  if (db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('Offline cutover requires its own transaction with foreign_keys=ON')
  }
  return db.transaction(() => {
    assertFinalPlatformRuntime(db)
    assertRosterFileClassificationSchema(db)
    const preflight = enterpriseMigrationPreflight(db)
    const existing = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='enterprise_kernel_completion'").get()
    if (existing) {
      const addressMigration = ensureEnterpriseAddresses(db)
      const marker = db.prepare('SELECT region_sha256,industry_sha256 FROM enterprise_kernel_completion WHERE id=1').get() as
        { region_sha256: string | null; industry_sha256: string | null }
      if (marker.region_sha256 === dictionaries.regionSha256 && marker.industry_sha256 === dictionaries.industrySha256) {
        const linked = backfillAnnouncementSources(db, preflight.terminals)
        return { migrated: addressMigration || linked > 0, linked, legacyUscc: preflight.legacyUscc }
      }
      if (marker.region_sha256 !== null) throw new Error('Enterprise dictionaries already installed from different inputs')
    } else {
      installEnterpriseKernelSchema(db)
      db.exec(`INSERT INTO enterprise_former_name(alias_id,uscc)
        SELECT a.id,e.uscc_norm FROM enterprise_alias a JOIN enterprise e ON e.id=a.enterprise_id;
        INSERT INTO roster_legacy_member(enterprise_id) SELECT id FROM enterprise;`)
    }
    installEnterpriseDictionaries(db, dictionaries)
    db.exec(`INSERT INTO enterprise_directory(enterprise_id,district_code)
      SELECT e.id, (SELECT min(r.code) FROM enterprise_region r WHERE r.level=2 AND r.name=e.district HAVING count(*)=1)
      FROM enterprise e WHERE NOT EXISTS (SELECT 1 FROM enterprise_directory d WHERE d.enterprise_id=e.id);
      UPDATE enterprise_directory SET district_code = (
        SELECT min(r.code) FROM enterprise_region r JOIN enterprise e ON e.district=r.name
        WHERE e.id=enterprise_directory.enterprise_id AND r.level=2 HAVING count(*)=1)
      WHERE district_code IS NULL;`)
    const linked = backfillAnnouncementSources(db, preflight.terminals)
    db.prepare(`INSERT INTO enterprise_kernel_completion(id,version,region_sha256,industry_sha256) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET region_sha256=excluded.region_sha256,industry_sha256=excluded.industry_sha256`)
      .run(ENTERPRISE_KERNEL_VERSION, dictionaries.regionSha256, dictionaries.industrySha256)
    db.pragma(`user_version=${ENTERPRISE_KERNEL_RUNTIME_VERSION}`)
    assertApplicationSchema(db)
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Enterprise kernel foreign key conflict')
    return {
      migrated: true, linked, legacyUscc: preflight.legacyUscc,
      unmatchedDistricts: db.prepare(`SELECT e.district,count(*) AS count FROM enterprise e
        JOIN enterprise_directory d ON d.enterprise_id=e.id WHERE e.district IS NOT NULL AND d.district_code IS NULL
        GROUP BY e.district ORDER BY e.district`).all(),
    }
  }).immediate()
}

function backfillAnnouncementSources(db: Database.Database, terminals: ReadonlyMap<number, number>) {
  const references = db.prepare(`
    SELECT DISTINCT f.id AS fileId,f.sha256,coalesce(f.display_name,f.filename) AS title,c.source AS channel,r.enterprise_id AS enterpriseId
    FROM record_evidence e
    JOIN record_event v ON v.id=e.record_event_id JOIN record r ON r.id=v.record_id
    JOIN stored_file f ON f.rel_path=e.source_file AND f.removed_at IS NULL
    JOIN roster_file_classification c ON c.file_id=f.id AND c.source=r.source AND c.kind='announcement'
    WHERE c.source IN ('jxj','miit')
    ORDER BY f.id,r.enterprise_id
  `).all() as { fileId: number; sha256: string; title: string; channel: string; enterpriseId: number }[]
  const findSource = db.prepare(`SELECT id FROM enterprise_source
    WHERE module='sme-roster' AND list_type_code='announcement'
      AND file_id=@fileId AND channel_code=@channel AND sha256=@sha256
    ORDER BY id LIMIT 1`)
  const createSource = db.prepare(`INSERT INTO enterprise_source(module,business_table,version_key,channel_code,list_type_code,series,file_id,sha256)
    VALUES ('sme-roster','stored_file',CAST(@fileId AS TEXT),@channel,'announcement',@title,@fileId,@sha256)
    RETURNING id`)
  const link = db.prepare(`INSERT INTO enterprise_source_link(enterprise_id,source_id)
    SELECT @enterpriseId,@sourceId WHERE NOT EXISTS (
      SELECT 1 FROM enterprise_source_link l JOIN enterprise_source s ON s.id=l.source_id
      WHERE l.enterprise_id=@enterpriseId AND s.module='sme-roster' AND s.list_type_code='announcement'
        AND s.file_id=@fileId AND s.channel_code=@channel AND s.sha256=@sha256
    )`)
  const sourcesByFile = new Map<number, number>()
  let linked = 0
  for (const row of references) {
    let sourceId = sourcesByFile.get(row.fileId)
    if (sourceId === undefined) {
      const source = (findSource.get(row) ?? createSource.get(row)) as { id: number }
      sourceId = source.id
      sourcesByFile.set(row.fileId, sourceId)
    }
    linked += link.run({ ...row, sourceId, enterpriseId: terminals.get(row.enterpriseId) ?? row.enterpriseId }).changes
  }
  return linked
}
