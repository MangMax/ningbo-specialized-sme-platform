import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readPostgresDecisionHead102 } from './decision-lifecycle-102/postgres-reads'
import { z } from 'zod'
import { decisionScope102, DecisionError102 } from './decision-lifecycle-102/contract'

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
type PreviewInput = z.infer<typeof legacyPreviewInput102>
type Candidate = { id:number; name:string; uscc:string | null }
type Head = Pick<NonNullable<Awaited<ReturnType<typeof readPostgresDecisionHead102>>>, 'id'|'status'|'lifecycleAction'>

function legacyPage(path: string,input: PreviewInput) {
  const annotations = legacyFile(path)
  const keys = input.legacyKey ? Object.hasOwn(annotations,input.legacyKey) ? [input.legacyKey] : [] : Object.keys(annotations).sort()
  const rows = keys.slice((input.page-1)*input.pageSize,input.page*input.pageSize).map(legacyKey=>{
    const conflicts = ['legacy_not_equivalent']
    const annotation = annotations[legacyKey]
    const note = annotation && typeof annotation==='object' && !Array.isArray(annotation) ? annotation as Record<string,unknown> : null
    const text = (key:string) => typeof note?.[key]==='string' ? (note[key] as string).slice(0,4000) : null
    if (!note) conflicts.push('invalid_legacy_annotation')
    if (['note','by','at'].some(key=>typeof note?.[key]==='string' && (note[key] as string).length>4000)) conflicts.push('legacy_summary_truncated')
    let key:unknown
    try { key = JSON.parse(legacyKey) } catch { /* Invalid keys are evidence for manual review. */ }
    const tuple = z.tuple([z.string().min(1),decisionScope102.shape.titleCode,decisionScope102.shape.direction]).safeParse(key)
    return { legacyKey,legacy:{note:text('note'),by:text('by'),at:text('at')},conflicts,tuple:tuple.success ? tuple.data : null }
  })
  return { rows,total:keys.length }
}

type LegacyRow = ReturnType<typeof legacyPage>['rows'][number]
function projectRow({legacyKey,legacy,conflicts,tuple}: LegacyRow, candidates: Candidate[], current?: Head | null) {
  if (!tuple) return {legacyKey,legacy,enterpriseId:null,equivalentToConfirmedNoDiff:false,conflicts:[...conflicts,'invalid_legacy_key'],candidates:[]}
  const [,titleCode,direction] = tuple
  const enterpriseId = candidates.length===1 ? candidates[0]!.id : null
  if (!candidates.length) conflicts.push('enterprise_not_found')
  if (candidates.length>1) conflicts.push('ambiguous_enterprise')
  if (current && current.lifecycleAction!=='withdraw') conflicts.push('formal_decision_exists')
  else if (current?.id) conflicts.push('formal_withdrawal_exists')
  return { legacyKey,legacy,enterpriseId,titleCode,direction,candidates,currentVersionId:current?.id ?? null,
    currentStatus:current?.lifecycleAction==='withdraw' ? null : current?.status ?? null,equivalentToConfirmedNoDiff:false,conflicts }
}

function boundedPreview(rows: ReturnType<typeof projectRow>[],total:number,input:PreviewInput) {
  const preview = { rows,total,page:input.page,pageSize:input.pageSize,migrationApplied:false }
  if (Buffer.byteLength(JSON.stringify(preview))>256*1024) throw new DecisionError102(413,'preview_response_too_large','Preview exceeds 256 KiB; request a smaller page or an exact legacyKey')
  return preview
}

export async function previewPostgresLegacyDecision102(db: Pick<NodePgDatabase,'execute' | 'select'>,path:string,input:PreviewInput) {
  const page = legacyPage(path,input)
  const rows = []
  for (const row of page.rows) {
    if (!row.tuple) { rows.push(projectRow(row,[])); continue }
    const [identity,titleCode,direction] = row.tuple
    const candidates = await db.select({ id: enterprise.id, name: enterprise.name, uscc: enterprise.usccNorm })
      .from(enterprise).where(identity.startsWith('name:')
        ? eq(enterprise.nameNorm, identity.slice(5))
        : eq(enterprise.usccNorm, identity))
      .orderBy(enterprise.id).limit(2)
    const current = candidates.length===1 ? await readPostgresDecisionHead102(db,{enterpriseId:candidates[0]!.id,titleCode,direction}) : null
    rows.push(projectRow(row,candidates,current))
  }
  return boundedPreview(rows,page.total,input)
}
