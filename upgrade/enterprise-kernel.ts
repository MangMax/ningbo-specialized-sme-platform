import type Database from 'better-sqlite3'
import { normalizeReviewedUscc, usccFormatVerdict } from '../layers/core/public'
import { assertFinalPlatformRuntime, assertRosterFileClassificationSchema, assertApplicationSchema } from '../db/schema-phase'
import { ENTERPRISE_KERNEL_RUNTIME_VERSION, ENTERPRISE_KERNEL_VERSION, installEnterpriseKernelSchema } from '../db/enterprise-kernel-schema'
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
      assertApplicationSchema(db)
      const marker = db.prepare('SELECT region_sha256,industry_sha256 FROM enterprise_kernel_completion WHERE id=1').get() as
        { region_sha256: string | null; industry_sha256: string | null }
      if (marker.region_sha256 === dictionaries.regionSha256 && marker.industry_sha256 === dictionaries.industrySha256) {
        return { migrated: false, legacyUscc: preflight.legacyUscc }
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
    const sources = existing ? { linked: 0, unresolvedEvidenceIds: [] } : seedAnnouncementSources(db, preflight.terminals)
    db.prepare(`INSERT INTO enterprise_kernel_completion(id,version,region_sha256,industry_sha256) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET region_sha256=excluded.region_sha256,industry_sha256=excluded.industry_sha256`)
      .run(ENTERPRISE_KERNEL_VERSION, dictionaries.regionSha256, dictionaries.industrySha256)
    db.pragma(`user_version=${ENTERPRISE_KERNEL_RUNTIME_VERSION}`)
    assertApplicationSchema(db)
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Enterprise kernel foreign key conflict')
    return {
      migrated: true, ...sources, legacyUscc: preflight.legacyUscc,
      unmatchedDistricts: db.prepare(`SELECT e.district,count(*) AS count FROM enterprise e
        JOIN enterprise_directory d ON d.enterprise_id=e.id WHERE e.district IS NOT NULL AND d.district_code IS NULL
        GROUP BY e.district ORDER BY e.district`).all(),
    }
  }).immediate()
}

function seedAnnouncementSources(db: Database.Database, terminals: ReadonlyMap<number, number>) {
  // A captured, version-bound row takes precedence over legacy path evidence.
  // A legacy path needs a single declaration and registered announcement bytes.
  const captures = db.prepare(`
    WITH committed_announcement AS MATERIALIZED (
      SELECT source_identity, max(source_sha256) AS sha256
      FROM import_batch
      WHERE source_kind='announcement' AND status='committed'
      GROUP BY source_identity HAVING count(DISTINCT source_sha256)=1
    ),
    legacy_original AS MATERIALIZED (
      SELECT d.id, d.path, d.source, d.title, f.id AS fileId, f.sha256
      FROM source_document d
      JOIN stored_file f ON f.rel_path=d.path
      JOIN roster_file_classification c ON c.file_id=f.id AND c.kind='announcement' AND c.source=d.source
      JOIN committed_announcement b ON b.source_identity=d.path AND b.sha256=f.sha256
      WHERE d.source IN ('jxj','miit')
        AND (SELECT count(*) FROM source_document x WHERE x.path=d.path AND x.source=d.source)=1
    )
    SELECT h.evidence_id AS evidenceId,r.enterprise_id AS enterpriseId,d.id AS documentId,d.source,
      d.title,h.stored_file_id AS fileId,h.sha256
    FROM official_evidence_row_revision h
    JOIN record_event v ON v.id=h.event_id JOIN record r ON r.id=v.record_id
    JOIN source_document d ON d.id=h.source_document_id
    WHERE h.source_binding_known=1 AND d.source IN ('jxj','miit')
    UNION ALL
    SELECT e.id,r.enterprise_id,d.id,d.source,d.title,d.fileId,d.sha256
    FROM legacy_original d
    JOIN record_evidence e ON e.source_file=d.path
    JOIN record_event v ON v.id=e.record_event_id
    JOIN record r ON r.id=v.record_id AND r.source=d.source
    WHERE NOT EXISTS (SELECT 1 FROM official_evidence_row_revision h WHERE h.evidence_id=e.id)
  `).all() as { evidenceId: number; enterpriseId: number; documentId: number; source: string; title: string; fileId: number | null; sha256: string }[]
  const insert = db.prepare(`INSERT INTO enterprise_source(module,business_table,version_key,channel_code,list_type_code,series,file_id,sha256)
    VALUES ('sme-roster','source_document',?,?,'announcement',?,?,?)
    ON CONFLICT(module,business_table,version_key) DO UPDATE SET file_id=coalesce(enterprise_source.file_id,excluded.file_id)
    RETURNING id`)
  const link = db.prepare('INSERT INTO enterprise_source_link VALUES (?,?) ON CONFLICT DO NOTHING')
  const resolved = new Set<number>()
  let linked = 0
  for (const row of captures) {
    const { id } = insert.get(`${row.documentId}:${row.sha256}`, row.source, row.title, row.fileId, row.sha256) as { id: number }
    linked += link.run(terminals.get(row.enterpriseId) ?? row.enterpriseId, id).changes
    resolved.add(row.evidenceId)
  }
  const unresolvedEvidenceIds = (db.prepare('SELECT id FROM record_evidence ORDER BY id').pluck().all() as number[]).filter(id => !resolved.has(id))
  return { linked, unresolvedEvidenceIds }
}
