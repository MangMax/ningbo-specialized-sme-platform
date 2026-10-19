import * as s from '../../db/schema'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { latestDecisionHead102, decisionScope102, DecisionError102, type DecisionDb } from './decision-lifecycle-102'

export const legacyPreviewInput102 = z.strictObject({ legacyKey: z.string().min(1).max(1000).optional(), page: z.number().int().positive().max(1000000).default(1), pageSize: z.number().int().positive().max(50).default(50) })
const MAX_BYTES = 2 * 1024 * 1024
function legacyFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  // Bound the actual read, including a concurrently replaced/growing legacy file.
  const fd = openSync(path, 'r'); const buffer = Buffer.alloc(MAX_BYTES + 1)
  let length = 0
  try {
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null)
      if (!read) break
      length += read
    }
  } finally { closeSync(fd) }
  if (length > MAX_BYTES) throw new DecisionError102(413, 'legacy_file_too_large', 'Legacy preview supports at most 2 MiB; prepare an explicitly authorized bounded source separately')
  let parsed: unknown
  try { parsed = JSON.parse(buffer.subarray(0, length).toString('utf8')) } catch { throw new DecisionError102(422, 'invalid_legacy_file', 'Legacy annotation file is invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DecisionError102(422, 'invalid_legacy_file', 'Legacy annotation file must be an object')
  if (Object.keys(parsed).length > 10000) throw new DecisionError102(413, 'legacy_file_too_large', 'Legacy preview supports at most 10000 keys')
  return parsed as Record<string, unknown>
}
export function previewLegacyDecision102(db: DecisionDb, path: string, input: z.infer<typeof legacyPreviewInput102>) {
  const annotations = legacyFile(path)
  const keys = input.legacyKey ? Object.hasOwn(annotations, input.legacyKey) ? [input.legacyKey] : [] : Object.keys(annotations).sort()
  const rows = keys.slice((input.page - 1) * input.pageSize, input.page * input.pageSize).map(legacyKey => {
    const conflicts = ['legacy_not_equivalent']
    const annotation = annotations[legacyKey]
    const note = annotation && typeof annotation === 'object' && !Array.isArray(annotation) ? annotation as Record<string, unknown> : null
    const text = (key: string) => typeof note?.[key] === 'string' ? (note[key] as string).slice(0,4000) : null
    if (!note) conflicts.push('invalid_legacy_annotation')
    if (['note','by','at'].some(key => typeof note?.[key] === 'string' && (note[key] as string).length > 4000)) conflicts.push('legacy_summary_truncated')
    let key: unknown
    try { key = JSON.parse(legacyKey) } catch { /* Invalid keys are evidence for manual review. */ }
    const tuple = z.tuple([z.string().min(1), decisionScope102.shape.titleCode, decisionScope102.shape.direction]).safeParse(key)
    if (!tuple.success) return { legacyKey, legacy: { note: text('note'), by: text('by'), at: text('at') }, enterpriseId: null, equivalentToConfirmedNoDiff: false, conflicts: [...conflicts, 'invalid_legacy_key'], candidates: [] }
    const [identity,titleCode,direction] = tuple.data
    const fields = { id: s.enterprise.id, name: s.enterprise.name, uscc: s.enterprise.usccNorm }
    const candidates = db.select(fields).from(s.enterprise).where(identity.startsWith('name:') ? eq(s.enterprise.nameNorm, identity.slice(5)) : eq(s.enterprise.usccNorm, identity)).orderBy(s.enterprise.id).limit(2).all()
    const enterpriseId = candidates.length === 1 ? candidates[0]!.id : null
    if (!candidates.length) conflicts.push('enterprise_not_found')
    if (candidates.length > 1) conflicts.push('ambiguous_enterprise')
    const current = enterpriseId ? latestDecisionHead102(db, { enterpriseId,titleCode,direction }) : null
    if (current && current.lifecycleAction !== 'withdraw') conflicts.push('formal_decision_exists')
    else if (current?.id) conflicts.push('formal_withdrawal_exists')
    return { legacyKey, legacy: { note: text('note'), by: text('by'), at: text('at') }, enterpriseId, titleCode, direction, candidates, currentVersionId: current?.id ?? null, currentStatus: current?.lifecycleAction === 'withdraw' ? null : current?.status ?? null, equivalentToConfirmedNoDiff: false, conflicts }
  })
  const preview = { rows, total: keys.length, page: input.page, pageSize: input.pageSize, migrationApplied: false }
  if (Buffer.byteLength(JSON.stringify(preview)) > 256 * 1024) throw new DecisionError102(413, 'preview_response_too_large', 'Preview exceeds 256 KiB; request a smaller page or an exact legacyKey')
  return preview
}
