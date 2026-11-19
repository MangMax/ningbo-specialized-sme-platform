/** Explicit offline native upgrade only; never imported by runtime initialization. */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assertFinalPlatformRuntime, assertNoRetiredPlatformSchema, PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION } from '../db/schema-phase'
import { parseRecognizedQualificationFields } from '../layers/sme-roster/lib/platform/recognized-projection'

const columns = ['source_recognized_at','source_valid_flag','source_invalidated_at','source_invalidation_reason','source_province_name','source_city_name','source_district_name','qualification_fields_rule']
type Options = { batchSize: number; beforeCommit?: (lastId: number) => void; onUnavailable?: (id: number, reason: string) => void }
type Row = { id: number; version_id: number | null; observation_id: number | null }
type Archive = { bytes: Buffer | null; byte_length: number | null; sha256: string | null; storage_class: string; sealed: number }

export function upgradeRecognizedQualification(s: Database.Database, options: Options) {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000) throw new Error('Batch size must be 1..1000')
  if (s.inTransaction) throw new Error('Offline upgrade requires its own transactions')
  s.pragma('foreign_keys=ON')
  // Admit the supported old native phase BEFORE the new runtime column check.
  if (s.pragma('user_version', { simple: true }) !== PLATFORM_RUNTIME_VERSION || !s.prepare('SELECT 1 FROM platform_runtime_completion WHERE id=1 AND rule=? AND schema_version=?').get(PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION)) throw new Error('Completed native predecessor required')
  assertNoRetiredPlatformSchema(s)
  s.prepare('SELECT exact_title_raw,source_validity_date,source_archive_id,version_id,observation_id FROM platform_recognized_projection LIMIT 0').all()
  // Catalog inspection belongs solely to this explicit DDL entry, never a reader.
  const installed = (s.prepare('PRAGMA table_info(platform_recognized_projection)').all() as { name: string }[]).map(c => c.name)
  const count = columns.filter(c => installed.includes(c)).length
  if (count !== 0 && count !== columns.length) throw new Error('Partial qualification schema is unsupported')
  s.transaction(() => {
    if (!count) s.exec(readFileSync(new URL('../db/migrations/0054_recognized_qualification_fields.sql', import.meta.url), 'utf8'))
    assertFinalPlatformRuntime(s)
  }).immediate()
  const update = s.prepare(`UPDATE platform_recognized_projection SET ${columns.map(c => `${c}=?`).join(',')} WHERE id=? AND qualification_fields_rule IS NULL`)
  let last = 0, captured = 0, unavailable = 0
  for (;;) {
    const batch = s.prepare('SELECT id,version_id,observation_id FROM platform_recognized_projection WHERE id>? AND qualification_fields_rule IS NULL ORDER BY id LIMIT ?').all(last, options.batchSize) as Row[]
    if (!batch.length) break
    const result = s.transaction(() => {
      let done = 0
      const gaps: { id: number; reason: string }[] = []
      for (const row of batch) {
        const version = row.version_id !== null
        const a = s.prepare(`SELECT a.bytes,a.byte_length,a.sha256,a.storage_class,r.sealed FROM ${version ? 'platform_version_archive_ref' : 'platform_observation_archive_ref'} r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field=?`).get(version ? row.version_id : row.observation_id, version ? 'canonicalRawJson' : 'rawFields') as Archive | undefined
        if (!a || a.sealed !== 1 || a.storage_class === 'null') { gaps.push({ id: row.id, reason: 'archived_raw_unavailable' }); continue }
        if (!Buffer.isBuffer(a.bytes) || a.bytes.length !== a.byte_length || createHash('sha256').update(a.bytes).digest('hex') !== a.sha256) throw new Error(`Archive digest mismatch: projection ${row.id}`)
        let raw: unknown
        try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(a.bytes)) } catch { gaps.push({ id: row.id, reason: 'archived_raw_invalid' }); continue }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { gaps.push({ id: row.id, reason: 'archived_row_not_object' }); continue }
        const p = parseRecognizedQualificationFields(raw)
        update.run(p.sourceRecognizedAt,p.sourceValidFlag,p.sourceInvalidatedAt,p.sourceInvalidationReason,p.sourceProvinceName,p.sourceCityName,p.sourceDistrictName,p.qualificationFieldsRule,row.id)
        done++
      }
      options.beforeCommit?.(batch.at(-1)!.id)
      return { done, gaps }
    }).immediate()
    captured += result.done; unavailable += result.gaps.length
    for (const gap of result.gaps) options.onUnavailable?.(gap.id, gap.reason)
    last = batch.at(-1)!.id
  }
  const foreignKeyViolations = s.pragma('foreign_key_check') as unknown[]
  if (foreignKeyViolations.length) throw new Error('Qualification upgrade foreign key conflict')
  return { captured, unavailable }
}
