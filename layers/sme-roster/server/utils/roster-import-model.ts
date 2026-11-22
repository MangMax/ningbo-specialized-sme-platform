import type { OfficialEventRow, RosterRecordRow } from './roster-event-version-model'
import type { PlatformProjectionSummary } from '../../lib/platform/business-record'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import type { platformExportRow as PlatformExportRowTable } from '../../../../db/postgresql/platform-tables'
import { record, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { isPageCapable } from '../../lib/roster/evidence-page'
import { normalizeUscc } from '../../lib/domain'
import { usccFormatVerdict } from '../../lib/roster/uscc-research'
import { PLATFORM_INTERFACE_VALUES, TITLE_ORDER } from '../../lib/labels'
import type { RosterImportAnnouncement, RosterImportEvidence, RosterImportEvent, RosterImportExportSnapshot, RosterImportItemResult, RosterImportPayload, RosterImportRequest, RosterImportSummary } from '../../lib/roster-import-client'
import type { OfficialCoordinate } from './official-evidence-claim-model'
import { legacyPlatformProvenanceItemsSchema } from '../../lib/platform/legacy-provenance'

// ---------------------------------------------------------------------------
// 校验用的取值集
// ---------------------------------------------------------------------------
//
// 这些集合**不重述取值** —— 一律从既有的冻结出处派生：
//  - 表列的枚举取自 `db/postgresql/ledger-tables.ts` 的 `*.enumValues`（drizzle 把 `text('c',{enum:[…]})`
//    的取值挂在列对象上），于是「表的枚举」与「写入侧的校验」不可能各自漂移；
//  - 没有表列的（称号、平台接口）取自 `layers/sme-roster/lib/labels.ts` / `db/titles.ts` 的既有常量。
// 旧写法是把 `not_queried` / `failed` / … 逐个再抄一遍，抄漏一个就成了静默放行。

/** 把一列已冻结的枚举取值变成校验集合。 */
export function enumSet(values: readonly string[]): Set<string> {
  return new Set(values)
}

/** 称号字典（`db/titles.ts` 的种子；不引 runtime）。 */
export const TITLE_CODES = new Set<string>(TITLE_ORDER)

const EVENT_TYPES = enumSet(recordEvent.eventType.enumValues)

const REVIEW_OUTCOMES = enumSet(recordEvent.reviewOutcome.enumValues)

export const SOURCES = enumSet(record.source.enumValues)

/** 平台接口取值集 = `layers/sme-roster/lib/labels.ts` 的唯一出处（契约 §2.4）。 */
export const PLATFORM_INTERFACE_SET = new Set<string>(PLATFORM_INTERFACE_VALUES)

// Correspondence decisions share the batch ledger, but are never a roster-import payload.
const IMPORT_SOURCE_KINDS = new Set<string>(['announcement', 'platform_export', 'platform_archive', 'alias_evidence'])

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function optionalInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.trunc(value)
}

/** Typed coordinates are verbatim; the old legacy grouping/write rules stay local. */
export function announcementEvidenceCoordinate(evidence: { sourceFile: string; attachment?: unknown; listNo?: unknown; page?: unknown; publishedRow?: unknown }, grouped = false): OfficialCoordinate {
  if (evidence.publishedRow !== undefined) return {
    sourceFile: evidence.sourceFile,
    attachment: typeof evidence.attachment === 'string' ? evidence.attachment : null,
    listNo: typeof evidence.listNo === 'number' ? evidence.listNo : null,
    page: typeof evidence.page === 'number' ? evidence.page : null,
  }
  const sourceFile = grouped ? optionalString(evidence.sourceFile) ?? evidence.sourceFile : evidence.sourceFile
  return { sourceFile, attachment: optionalString(evidence.attachment), listNo: optionalInt(evidence.listNo), page: isPageCapable(sourceFile) ? optionalInt(evidence.page) : null }
}

/** 一条 item 级错误。 */
export function failure(kind: string, ref: string, code: string, message: string, field?: string): RosterImportItemResult {
  return { ok: false, kind, ref, error: { code, ...(field ? { field } : {}), message } }
}

// ---------------------------------------------------------------------------
// 请求校验
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; value: RosterImportRequest }
  | { ok: false; status: number; message: string }

export function validateNativeImportRequest(raw: unknown): ValidateResult {
  return validateImportRequest(raw, (payload, sourceKind) => {
    const retired = retiredPlatformImportField(payload)
    if (retired) return retired + ' 已停用，历史平台原始资料请通过离线归档处理'
    if (sourceKind === 'platform_archive' && (!Array.isArray(payload.platformQueries) || !payload.platformQueries.length)) {
      return 'platform_archive requires platformQueries'
    }
    return null
  })
}

export function retiredPlatformImportField(payload: object) {
  return ['platformRecordObservations', 'platformLegacyProvenance'].find(field => Object.hasOwn(payload, field))
}

export function validateImportRequest(raw: unknown, validatePayload = validatePlatformProjectionPayload): ValidateResult {
  if (!isObject(raw)) return { ok: false, status: 400, message: '请求体必须是 JSON 对象' }

  const idempotencyKey = optionalString(raw.idempotencyKey)
  if (!idempotencyKey) {
    return { ok: false, status: 400, message: '缺少 idempotencyKey（幂等键）' }
  }
  const sourceKind = optionalString(raw.sourceKind)
  if (!sourceKind || !IMPORT_SOURCE_KINDS.has(sourceKind)) {
    return {
      ok: false,
      status: 400,
      message: `sourceKind 必须是 announcement / platform_export / platform_archive / alias_evidence 之一，收到：${sourceKind ?? '(空)'}`,
    }
  }
  const sourceIdentity = optionalString(raw.sourceIdentity)
  if (!sourceIdentity) {
    return { ok: false, status: 400, message: '缺少 sourceIdentity（来源身份：文件相对路径或逻辑标识）' }
  }
  if (!isObject(raw.payload)) {
    return { ok: false, status: 400, message: '缺少 payload（写入载荷）或它不是对象' }
  }
  const projectionError = validatePayload(raw.payload, sourceKind)
  if (projectionError) return { ok: false, status: 400, message: projectionError }

  return {
    ok: true,
    value: {
      idempotencyKey,
      sourceKind: sourceKind as RosterImportRequest['sourceKind'],
      sourceIdentity,
      sourceSha256: optionalString(raw.sourceSha256),
      payload: raw.payload as RosterImportPayload,
    },
  }
}

/** Strict additive field validation: malformed/empty projection commands cannot silently succeed. */
export function validatePlatformProjectionPayload(payload: Record<string, unknown>, sourceKind: string): string | null {
  if (Object.hasOwn(payload, 'platformLegacyProvenance')) {
    if (sourceKind !== 'platform_archive') return 'platformLegacyProvenance requires sourceKind=platform_archive'
    const parsed = legacyPlatformProvenanceItemsSchema.safeParse(payload.platformLegacyProvenance)
    if (!parsed.success) return `platformLegacyProvenance: ${parsed.error.issues.map(issue => issue.message).join('; ')}`
  }
  if (Object.hasOwn(payload, 'platformRecordObservations')) {
    const rows = payload.platformRecordObservations
    if (sourceKind !== 'platform_archive') return 'platformRecordObservations requires sourceKind=platform_archive'
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) return 'platformRecordObservations must contain 1..100 observations'
    const seen = new Set<number>()
    for (const row of rows) {
      if (!isObject(row) || Object.keys(row).length !== 1 || !Number.isSafeInteger(row.relationId) || (row.relationId as number) < 1) return 'platformRecordObservations items require only a positive safe integer relationId'
      if (seen.has(row.relationId as number)) return 'platformRecordObservations relationId must be unique per request'
      seen.add(row.relationId as number)
    }
  }
  if (sourceKind === 'platform_archive' && !Object.hasOwn(payload, 'platformLegacyProvenance') && !Object.hasOwn(payload, 'platformRecordObservations') && (!Array.isArray(payload.platformQueries) || !payload.platformQueries.length)) return 'platform_archive requires platformQueries, platformRecordObservations or platformLegacyProvenance'
  return null
}

/** 归一后的自然键（`queriedAt` 可空 = 要求 `(interface, queryKey, rdjb)` 唯一）。 */
export interface NormalizedRef {
  interface: string
  queryKey: string
  rdjb: string
  queriedAt: string | null
  sequenceNo: number | null
  /**
   * 关系的**权威锚点**（`RL-06` 增量：父代理 2026-10-16，两个复查代理都实测「平台的排序可能
   * 与其解析顺序不同，`sequenceNo` 只作参考」）。
   *
   * 给 `relationKey` 时：解析出的那条关系**必须**就是它；`sequenceNo` 同时给了却指到别的行
   * ⇒ **报错**（`relation_ref_mismatch`），**不按其中一个猜**。不给则保持原行为（按 `sequenceNo`）。
   */
  relationKey: string | null
}

export type RefError = { code: string; field: string; message: string }

/** 校验自然键的形状（不查库）。 */
export function normalizeRef(ref: unknown, field: string): { ok: true; value: NormalizedRef } | { ok: false; error: RefError } {
  if (!isObject(ref)) {
    return { ok: false, error: { code: 'ref_shape_invalid', field, message: `引用必须是对象 { interface, queryKey, rdjb?, queriedAt?, sequenceNo? }` } }
  }
  const iface = optionalString(ref.interface)
  if (!iface || !PLATFORM_INTERFACE_SET.has(iface)) {
    return { ok: false, error: { code: 'ref_interface_unknown', field: `${field}.interface`, message: `引用缺少 interface 或取值不在字典内：${String(ref.interface)}` } }
  }
  const queryKey = optionalString(ref.queryKey)
  if (!queryKey) {
    return { ok: false, error: { code: 'ref_query_key_required', field: `${field}.queryKey`, message: '引用缺少 queryKey' } }
  }
  return {
    ok: true,
    value: {
      interface: iface,
      queryKey,
      rdjb: optionalString(ref.rdjb) ?? '',
      queriedAt: optionalString(ref.queriedAt),
      sequenceNo: optionalInt(ref.sequenceNo),
      relationKey: optionalString(ref.relationKey),
    },
  }
}

export function describeRef(ref: NormalizedRef): string {
  const parts = [`interface=${ref.interface}`, `queryKey=${ref.queryKey}`, `rdjb=${ref.rdjb || "''"}`]
  if (ref.queriedAt) parts.push(`queriedAt=${ref.queriedAt}`)
  if (ref.sequenceNo != null) parts.push(`sequenceNo=${ref.sequenceNo}`)
  if (ref.relationKey) parts.push(`relationKey=${ref.relationKey}`)
  return parts.join(' ')
}

/** 一条已冻结的出处指针更新，供 commit 与显式 replay 执行同一计划。 */
export interface EvidenceRepointTarget {
  id: number
  recordId: number
  recordEventId: number
  fromSourceFile: string
  sourceFile: string
}

export type EvidenceContentHashIndex = Map<string, Set<string>>

export type EvidenceContentHashConflict = 'unknown' | 'mismatch'

export interface EvidenceRepointPlan {
  targets: EvidenceRepointTarget[]
  hashConflicts: Set<EvidenceContentHashConflict>
}

export function groupNewAnnouncementEvidence(
  announcement: RosterImportAnnouncement,
  records: readonly RosterImportAnnouncement['records'][number][],
  identity: (index: number, name: string) => { key: string; ambiguous?: boolean },
  alreadyStored: (recordIndex: number, titleCode: string, source: 'jxj' | 'miit', event: RosterImportEvent) => boolean,
): { eventsByRecord: Map<number, RosterImportEvent[]>; groupedOccurrences: Set<string> } {
  interface Occurrence {
    recordIndex: number
    eventIndex: number
    event: RosterImportEvent
  }

  const planned = new Map<number, RosterImportEvent[]>()
  const groupedOccurrences = new Set<string>()
  const groups = new Map<string, Occurrence[]>()
  for (const [recordIndex, record] of records.entries()) {
    const events = Array.isArray(record?.events) ? record.events : []
    planned.set(
      recordIndex,
      events.map((event) => {
        const candidate: unknown = event
        // Keep malformed array entries for planAnnouncementRecord's structured validation.
        // In particular, JSON null must not throw here before it can become an item error.
        if (!isObject(candidate)) return event
        const evidence = candidate.evidence
        return {
          ...candidate,
          evidence: Array.isArray(evidence) ? [...evidence] : (evidence ?? []),
        } as unknown as RosterImportEvent
      }),
    )

    const name = optionalString(record?.enterprise?.name)
    const titleCode = optionalString(record?.titleCode)
    const source = record?.source ?? announcement.sourceDocument?.source
    if (!name || !titleCode || !TITLE_CODES.has(titleCode) || !SOURCES.has(String(source))) continue
    const group = identity(recordIndex, name)
    events.forEach((event, eventIndex) => {
      if (!EVENT_TYPES.has(String(event?.eventType))) return
      const coordinates = eventCoordinates(0, event)
      const occurrence: Occurrence = {
        recordIndex,
        eventIndex,
        event,
      }

      // 一条不唯一的名称无法确认企业身份，不能按名称查询碰巧返回的第一家参与归组。
      // planAnnouncementRecord 会在任何写入解析前拒绝这条 name-only 记录。
      const identityKey = group.ambiguous ? `ambiguous:${recordIndex}:${eventIndex}` : group.key
      const key = JSON.stringify([identityKey, titleCode, source, coordinates])
      const occurrences = groups.get(key) ?? []
      occurrences.push(occurrence)
      groups.set(key, occurrences)
    })
  }

  for (const occurrences of groups.values()) {
    if (occurrences.length < 2) continue
    const first = occurrences[0]
    if (!first) continue
    const representative = records[first.recordIndex]
    if (!representative) continue
    const name = optionalString(representative?.enterprise?.name)
    const titleCode = optionalString(representative?.titleCode)
    const source = representative?.source ?? announcement.sourceDocument?.source
    if (!name || !titleCode || !SOURCES.has(String(source))) continue
    if (alreadyStored(first.recordIndex, titleCode, source, first.event)) continue

    const uniqueEvidence = new Map<string, RosterImportEvidence>()
    const invalidEvidence: unknown[] = []
    for (const occurrence of occurrences) {
      const evidenceValues: unknown[] = Array.isArray(occurrence.event.evidence) ? occurrence.event.evidence : []
      for (const rawEvidence of evidenceValues) {
        // Keep malformed entries in the planned event. The original payload is validated below,
        // and these entries must become structured record_evidence errors rather than disappear.
        if (!isObject(rawEvidence)) {
          invalidEvidence.push(rawEvidence)
          continue
        }
        if (typeof rawEvidence.sourceFile !== 'string' || !optionalString(rawEvidence.sourceFile)) {
          invalidEvidence.push(rawEvidence)
          continue
        }
        const normalized: RosterImportEvidence = {
          ...(rawEvidence.publishedRow !== undefined ? { publishedRow: rawEvidence.publishedRow as import('../../lib/roster-import-client').OfficialPublishedRow } : {}),
          ...announcementEvidenceCoordinate({ ...rawEvidence, sourceFile: rawEvidence.sourceFile }, true),
        }
        const key = JSON.stringify([
          normalized.sourceFile,
          normalized.attachment ?? null,
          normalized.listNo ?? null,
          normalized.page ?? null,
        ])
        uniqueEvidence.set(key, normalized)
      }
    }
    const mergedEvidence = [...uniqueEvidence.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, evidence]) => evidence)
    mergedEvidence.push(...(invalidEvidence as RosterImportEvidence[]))
    const [firstOccurrence, ...duplicates] = occurrences
    for (const occurrence of occurrences) groupedOccurrences.add(`${occurrence.recordIndex}:${occurrence.eventIndex}`)
    if (firstOccurrence) {
      const event = planned.get(firstOccurrence.recordIndex)?.[firstOccurrence.eventIndex]
      if (event) planned.get(firstOccurrence.recordIndex)![firstOccurrence.eventIndex] = { ...event, evidence: mergedEvidence }
    }
    for (const duplicate of duplicates) {
      const event = planned.get(duplicate.recordIndex)?.[duplicate.eventIndex]
      if (event) planned.get(duplicate.recordIndex)![duplicate.eventIndex] = { ...event, evidence: [] }
    }
  }

  return { eventsByRecord: planned, groupedOccurrences }
}

/** 对象键及集合数组顺序不影响公告载荷的快照指纹;重复项仍按重数保留。 */
function canonicalEvidencePlanJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEvidencePlanJson).sort().join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalEvidencePlanJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 同一幂等键若被复用于不同公告载荷或默认来源,不应复用旧的收敛目标快照。 */
export function evidenceRepointPlanFingerprint(request: RosterImportRequest): string {
  return createHash('sha256')
    .update(canonicalEvidencePlanJson(request.payload?.announcement ?? null))
    .digest('hex')
}

export function hasOfficialFactInput(request: RosterImportRequest): boolean {
  const payload = request.payload
  return ['officialEvidenceAppends', 'officialEvidenceCorrections', 'officialEvidencePlanHash'].some(key => Object.hasOwn(payload, key)) || (Array.isArray(payload.announcement?.records) && payload.announcement.records.some(record => Array.isArray(record?.events) && record.events.some(event => Array.isArray(event?.evidence) && event.evidence.some(evidence => evidence && Object.hasOwn(evidence, 'publishedRow')))))
}

/**
 * Validate the two announcement-only values whose malformed forms can change identity or evidence
 * meaning. Generic `optionalInt` remains shared by years and batch fields and is not changed here.
 */
export function validateAnnouncementIdentityAndEvidence(
  announcement: RosterImportAnnouncement | null | undefined,
): RosterImportItemResult[] {
  if (!announcement || !Array.isArray(announcement.records)) return []

  const errors: RosterImportItemResult[] = []
  announcement.records.forEach((record, recordIndex) => {
    const enterprise = isObject(record?.enterprise) ? record.enterprise : null
    const rawUscc = enterprise?.uscc
    const hasNonblankUscc =
      rawUscc !== null &&
      rawUscc !== undefined &&
      (typeof rawUscc !== 'string' || normalizeUscc(rawUscc) !== '')
    if (hasNonblankUscc) {
      const verdict = usccFormatVerdict(rawUscc)
      if (verdict !== 'ok') {
        const why =
          verdict === 'length' ? '长度不是 18 位' : verdict === 'charset' ? '含字符集外的字符' : '校验位不符'
        errors.push(
          failure(
            'record',
            `record:${recordIndex}`,
            'uscc_format_invalid',
            `统一社会信用代码不合法（${why}）：${String(rawUscc)}`,
            'enterprise.uscc',
          ),
        )
      }
    }

    const events = Array.isArray(record?.events) ? record.events : []
    events.forEach((event, eventIndex) => {
      const evidence = Array.isArray(event?.evidence) ? event.evidence : []
      evidence.forEach((item, evidenceIndex) => {
        if (!isObject(item)) return
        const sourceFile = optionalString(item.sourceFile)
        if (!sourceFile || item.page === null || item.page === undefined) return
        const ref = `record:${recordIndex}#${eventIndex}/e${evidenceIndex}`
        if (!isPageCapable(sourceFile)) {
          errors.push(
            failure(
              'record_evidence',
              ref,
              'not_page_capable',
              `${sourceFile} 不是 PDF，不能提供可复核的实际页码；请移除 page 或设为 null`,
              'evidence.page',
            ),
          )
          return
        }
        const page = item.page
        if (typeof page !== 'number' || !Number.isFinite(page) || !Number.isInteger(page) || page < 1) {
          errors.push(
            failure(
              'record_evidence',
              ref,
              'page_invalid',
              `PDF 出处 page 必须是正整数，收到：${String(page)}`,
              'evidence.page',
            ),
          )
        }
      })
    })
  })

  return errors
}

// --- 公布文件 --------------------------------------------------------------

export function validateAnnouncementRecord(
  announcement: RosterImportAnnouncement, record: RosterImportAnnouncement['records'][number], index: number,
) {
  const ref = `record:${index}`
  const name = optionalString(record?.enterprise?.name)
  if (!name) {
    return { error: failure('record', ref, 'enterprise_name_required', '记录缺少企业名称', 'records[].enterprise.name') } as const
  }
  const titleCode = optionalString(record.titleCode)
  if (!titleCode || !TITLE_CODES.has(titleCode)) {
    return { error: failure('record', ref, 'title_unknown', `称号不在字典内：${titleCode ?? '(空)'}`, 'titleCode') } as const
  }
  const source = record.source ?? announcement.sourceDocument.source
  if (!SOURCES.has(String(source))) {
    return { error: failure('record', ref, 'source_unknown', `来源必须是 jxj / miit，收到：${String(source)}`, 'source') } as const
  }
  const events = Array.isArray(record.events) ? record.events : []
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    const eventRef = `record:${index}#${i}`
    if (!EVENT_TYPES.has(String(event?.eventType))) {
      return { error: failure('record_event', eventRef, 'event_type_unknown', `事件类型不在字典内：${String(event?.eventType)}`, 'eventType') } as const
    }
    if (event.reviewOutcome != null && !REVIEW_OUTCOMES.has(String(event.reviewOutcome))) {
      return { error: failure('record_event', eventRef, 'review_outcome_unknown', `复核结论必须是 passed / failed，收到：${String(event.reviewOutcome)}`, 'reviewOutcome') } as const
    }
    const evidence = Array.isArray(event.evidence) ? event.evidence : []
    for (let k = 0; k < evidence.length; k += 1) {
      if (!optionalString(evidence[k]?.sourceFile)) {
        return { error: failure('record_evidence', `${eventRef}/e${k}`, 'source_file_required', '出处缺少 sourceFile', 'evidence.sourceFile') } as const
      }
    }
  }

  return { name, titleCode, source, events }
}

/**
 * 事件的**坐标**(重放判重与收敛比对共用同一份取值)。
 *
 * 为什么抽出来:预检(算「将要更新几行」)与执行(真的改哪几行)必须**同一条判据** ——
 * 两处各算一次迟早会漂,而漂了以后预检报的就不再是提交真会发生的事(本文件开头的承诺)。
 */
export interface EventCoordinates {
  recordId: number
  eventType: string
  year: number | null
  batchSeq: number | null
  reviewOutcome: string | null
  decidedYear: number | null
}

/** 由载荷里的一条事件 + 它所属记录算出坐标。 */
export function eventCoordinates(recordId: number, event: RosterImportEvent): EventCoordinates {
  return {
    recordId,
    eventType: String(event.eventType),
    year: optionalInt(event.year),
    batchSeq: optionalInt(event.batchSeq),
    reviewOutcome: event.reviewOutcome == null ? null : String(event.reviewOutcome),
    decidedYear: optionalInt(event.decidedYear),
  }
}

/** 一行 `record_event` 是不是这个坐标。 */
export function matchesEventCoordinates(row: EventCoordinates, values: EventCoordinates): boolean {
  return (
    row.recordId === values.recordId &&
    row.eventType === values.eventType &&
    (row.year ?? null) === values.year &&
    (row.batchSeq ?? null) === values.batchSeq &&
    (row.reviewOutcome ?? null) === values.reviewOutcome &&
    (row.decidedYear ?? null) === values.decidedYear
  )
}

// ---------------------------------------------------------------------------
// 重放时的**出处指针收敛**(RL-16)
// ---------------------------------------------------------------------------
//
// 背景:来源文件入库后,同一份内容的标识从**库外路径**变成**库内路径**。若重放既有事件时
// 只「跳过」,`record_evidence.source_file` 就永远指着库外路径,名录行点开预览解析不到文件。
//
// 三条边界(为什么这样做是安全的):
//  1. **事件事实不变**。事件坐标(类型/年份/批次/结论/结论年份)逐字相同才进入这条路径,
//     事件与出处行一行不加、一行不删；只收敛来源指针,并按目标文件类型清理不可靠页码。
//  2. 附件、序号逐字匹配；页码只对目标 PDF 参与匹配。目标格式没有稳定分页时,两侧 page 都归一为
//     null,且只有事件内唯一的 (附件, 序号) 行才允许收敛；多个候选视为歧义并跳过,不把一行错配给另一行。
//     非 PDF 目标还会清理历史伪页码；PDF 的既有实际页码原样保留。路径只是「同一份文档在库里的位置」,不是身份。
//     旧路径与目标路径还必须各自有唯一可验证的 SHA-256 且完全相同;缺失 / 冲突 / 不同都报告冲突并保留旧出处。
//  3. **收敛的触发权在幂等键上**。键含来源标识(见 `layers/sme-roster/lib/roster/little-giant-import.ts`):
//     只有携带**同一份来源内容**、且来源标识变了的批次才会走到这里。

/** 出处行的坐标字段(路径不参与 —— 它正是要被收敛的那一项)。 */
interface EvidenceCoordinateRow {
  id: number
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}

/** 收集只与其精确路径身份绑定的 SHA-256；逻辑身份不能替另一条出处路径背书。 */
export function indexedEvidenceHashes(request: RosterImportRequest, sources: readonly { path: string; sha256: string | null }[]) {
  const index: EvidenceContentHashIndex = new Map()
  const add = (path: string | null | undefined, rawHash: unknown) => {
    const sha256 = optionalString(rawHash)
    if (!path || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) return
    const hashes = index.get(path) ?? new Set<string>()
    hashes.add(sha256.toLowerCase())
    index.set(path, hashes)
  }

  for (const { path, sha256 } of sources) add(path, sha256)
  add(request.sourceIdentity, request.sourceSha256)
  return index
}

function verifiedEvidenceContentHash(index: EvidenceContentHashIndex, path: string): string | null {
  const hashes = index.get(path)
  return hashes?.size === 1 ? [...hashes][0] ?? null : null
}

export function evidenceContentHashMatch(
  index: EvidenceContentHashIndex,
  oldPath: string,
  targetPath: string,
): EvidenceContentHashConflict | 'same' {
  const oldHash = verifiedEvidenceContentHash(index, oldPath)
  const targetHash = verifiedEvidenceContentHash(index, targetPath)
  if (!oldHash || !targetHash) return 'unknown'
  return oldHash === targetHash ? 'same' : 'mismatch'
}

interface CandidateEvidencePaths {
  pathsByRow: Map<number, Set<string>>
  hashConflicts: Set<EvidenceContentHashConflict>
}

/** 页码只在目标来源是 PDF 时作为坐标；其它格式把请求值和存储值都归一成 null。 */
function evidencePageCoordinate(sourceFile: string, page: unknown): number | null {
  return isPageCapable(sourceFile) ? (optionalInt(page) ?? null) : null
}

/** 已存在出处行的格式化坐标是否与载荷里的那条出处相同。 */
function matchesEvidenceCoordinates(row: EvidenceCoordinateRow, wanted: RosterImportEvidence): boolean {
  return (
    (row.attachment ?? null) === (optionalString(wanted.attachment) ?? null) &&
    (row.listNo ?? null) === (optionalInt(wanted.listNo) ?? null) &&
    evidencePageCoordinate(wanted.sourceFile, row.page) === evidencePageCoordinate(wanted.sourceFile, wanted.page)
  )
}

/**
 * 算出**这次要改哪几条出处行**。一进一出各一条、按行一一对应(同一条已存在的行不会被
 * 两条载荷出处重复认领),且只在 `source_file` 真的不同时才改。
 */
function repointTargets(
  recordId: number,
  recordEventId: number,
  existing: readonly EvidenceCoordinateRow[],
  wanted: readonly RosterImportEvidence[],
  taken: Set<number> = new Set(),
  ambiguous: ReadonlySet<number> = new Set(),
  evidenceContentHashes: EvidenceContentHashIndex,
): EvidenceRepointPlan {
  const { pathsByRow: targetPathsByRow, hashConflicts } = candidateTargetPathsByRow(existing, wanted, evidenceContentHashes)
  const existingById = new Map(existing.map((row) => [row.id, row]))
  const out: EvidenceRepointTarget[] = []
  for (const [id, paths] of targetPathsByRow) {
    // 一条既有行若有多个不同目标路径或已被整份载荷判为冲突，不按载荷顺序猜一个。
    if (taken.has(id) || ambiguous.has(id) || paths.size !== 1) continue
    const [sourceFile] = paths
    if (!sourceFile) continue
    const current = existingById.get(id)
    if (!current) continue
    taken.add(id)
    out.push({ id, recordId, recordEventId, fromSourceFile: current.sourceFile, sourceFile })
  }
  return { targets: out, hashConflicts }
}

/** 每个唯一坐标行收集本组载荷里实际需要改到的路径；同路径 no-op 不参与认领。 */
function candidateTargetPathsByRow(
  existing: readonly EvidenceCoordinateRow[],
  wanted: readonly RosterImportEvidence[],
  evidenceContentHashes: EvidenceContentHashIndex,
): CandidateEvidencePaths {
  const targetPathsByRow = new Map<number, Set<string>>()
  const hashConflicts = new Set<EvidenceContentHashConflict>()
  for (const rawCandidate of wanted as readonly unknown[]) {
    if (!isObject(rawCandidate)) continue
    const candidate = rawCandidate as unknown as RosterImportEvidence
    const sourceFile = optionalString(candidate.sourceFile)
    if (!sourceFile) continue
    // 按目标格式归一坐标后必须只命中一行。非 PDF 的 page 不参与坐标；PDF 页号仍精确参与。
    // 同路径候选是 no-op，不认领该行；这样后续有效路径仍可更新它。
    const matches = existing.filter((row) => matchesEvidenceCoordinates(row, candidate))
    if (matches.length !== 1) continue
    const [hit] = matches
    if (!hit || hit.sourceFile === sourceFile) continue
    const hashMatch = evidenceContentHashMatch(evidenceContentHashes, hit.sourceFile, sourceFile)
    if (hashMatch !== 'same') {
      hashConflicts.add(hashMatch)
      continue
    }
    const paths = targetPathsByRow.get(hit.id) ?? new Set<string>()
    paths.add(sourceFile)
    targetPathsByRow.set(hit.id, paths)
  }
  return { pathsByRow: targetPathsByRow, hashConflicts }
}

export function ambiguousAnnouncementRepoints(records: readonly RosterImportAnnouncement['records'][number][],
  recordIdByIndex: ReadonlyMap<number, number>, eventRows: OfficialEventRow[],
  evidenceRows: readonly (EvidenceCoordinateRow & { recordEventId: number })[], evidenceContentHashes: EvidenceContentHashIndex) {
  const eventsByRecord = new Map<number, typeof eventRows>()
  for (const row of eventRows) {
    const rows = eventsByRecord.get(row.recordId) ?? []
    rows.push(row)
    eventsByRecord.set(row.recordId, rows)
  }
  const evidenceByEvent = new Map<number, EvidenceCoordinateRow[]>()
  for (const row of evidenceRows) {
    const rows = evidenceByEvent.get(row.recordEventId) ?? []
    rows.push(row)
    evidenceByEvent.set(row.recordEventId, rows)
  }

  const targetPathsByEvidence = new Map<number, Set<string>>()
  for (const [index, recordId] of recordIdByIndex) {
    const storedEvents = eventsByRecord.get(recordId) ?? []
    const requestEvents = Array.isArray(records[index]?.events) ? records[index]!.events! : []
    for (const rawEvent of requestEvents) {
      // Invalid event elements must reach planAnnouncementRecord's structured validation.
      if (!isObject(rawEvent)) continue
      const event = rawEvent as unknown as RosterImportEvent
      const coords = eventCoordinates(recordId, event)
      const existingEvent = storedEvents.find((row) => matchesEventCoordinates(row, coords))
      if (!existingEvent) continue
      const candidates = candidateTargetPathsByRow(
        evidenceByEvent.get(existingEvent.id) ?? [],
        Array.isArray(event.evidence) ? event.evidence : [],
        evidenceContentHashes,
      )
      for (const [evidenceId, paths] of candidates.pathsByRow) {
        const allPaths = targetPathsByEvidence.get(evidenceId) ?? new Set<string>()
        for (const path of paths) allPaths.add(path)
        targetPathsByEvidence.set(evidenceId, allPaths)
      }
    }
  }

  return new Set([...targetPathsByEvidence].filter(([, paths]) => paths.size > 1).map(([id]) => id))
}

/** 将重复出现的同一事件坐标合并，之后一次性按出处行解析目标与歧义。 */
function groupEventEvidenceById(
  events: readonly RosterImportEvent[],
  eventIdFor: (event: RosterImportEvent) => number | undefined,
): Map<number, RosterImportEvidence[]> {
  const byEvent = new Map<number, RosterImportEvidence[]>()
  for (const event of events) {
    const eventId = eventIdFor(event)
    if (eventId == null) continue
    const evidence = byEvent.get(eventId) ?? []
    evidence.push(...(event.evidence ?? []))
    byEvent.set(eventId, evidence)
  }
  return byEvent
}

export function projectAnnouncementRepoints(recordId: number, events: readonly RosterImportEvent[],
  eventRows: readonly OfficialEventRow[], evidenceRows: readonly (EvidenceCoordinateRow & { recordEventId: number })[],
  taken: Set<number>, ambiguous: ReadonlySet<number>, evidenceContentHashes: EvidenceContentHashIndex) {
  const byEvent = new Map<number, EvidenceCoordinateRow[]>()
  for (const row of evidenceRows) {
    const list = byEvent.get(row.recordEventId)
    if (list) list.push(row)
    else byEvent.set(row.recordEventId, [row])
  }

  const targets: EvidenceRepointTarget[] = []
  const hashConflicts = new Set<EvidenceContentHashConflict>()
  const wantedByEvent = groupEventEvidenceById(events, (event) => {
    const coords = eventCoordinates(recordId, event)
    return eventRows.find((row) => matchesEventCoordinates(row, coords))?.id
  })
  for (const [eventId, wanted] of wantedByEvent) {
    const plan = repointTargets(recordId, eventId, byEvent.get(eventId) ?? [], wanted, taken, ambiguous, evidenceContentHashes)
    for (const conflict of plan.hashConflicts) hashConflicts.add(conflict)
    targets.push(...plan.targets)
  }
  return { targets, hashConflicts }
}

export function exportSnapshotRowConflict(rows: NonNullable<RosterImportExportSnapshot['rows']>, stored: ReadonlyMap<number, typeof PlatformExportRowTable.$inferSelect>) {
  for (const row of rows) {
    const original = stored.get(row.sourceRowNo)
    if (!original) return failure('export_row', `export:row:${row.sourceRowNo}`, 'export_row_set_conflict', 'Existing file cannot acquire new source rows', 'rows')
    for (const field of ['nameRaw', 'usccRaw', 'district', 'province', 'city', 'regStatus', 'rawFields'] as const) {
      if (!Object.hasOwn(row, field)) continue
      const value = field === 'rawFields' ? row[field] ?? null : optionalString(row[field])
      if (!isDeepStrictEqual(original[field], value)) return failure('export_row', `export:row:${row.sourceRowNo}`, 'export_row_payload_conflict', `Existing file row has different ${field}`, `rows.${field}`)
    }
  }
  return null
}

export function projectExportSnapshotRow(batchId: number, row: NonNullable<RosterImportExportSnapshot['rows']>[number]) {
  return {
    batchId,
    sourceRowNo: optionalInt(row.sourceRowNo)!,
    usccRaw: optionalString(row.usccRaw),
    nameRaw: optionalString(row.nameRaw),
    district: optionalString(row.district),
    province: optionalString(row.province),
    city: optionalString(row.city),
    regStatus: optionalString(row.regStatus),
    rawFields: row.rawFields == null ? null : JSON.stringify(row.rawFields),
    createdAt: new Date().toISOString(),
  }
}

export function validateExportSnapshot(snapshot: RosterImportExportSnapshot): RosterImportItemResult | null {
  const ref = 'export:snapshot'
  if (!TITLE_CODES.has(String(snapshot?.titleCode))) {
    return failure('export_batch', ref, 'title_unknown', `称号不在字典内：${String(snapshot?.titleCode)}`, 'titleCode')
  }
  if (!optionalInt(snapshot.year) || !optionalString(snapshot.collectedOn) || !optionalString(snapshot.originalFilename) || !optionalString(snapshot.sha256)) {
    return failure('export_batch', ref, 'export_identity_incomplete', '快照缺少 year / collectedOn / originalFilename / sha256', 'exportSnapshot')
  }
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  const seen = new Set<number>()
  for (let i = 0; i < rows.length; i += 1) {
    const rowNo = optionalInt(rows[i]?.sourceRowNo)
    if (rowNo == null) {
      return failure('export_row', `export:row:${i}`, 'source_row_no_required', '快照行缺少 sourceRowNo', 'rows[].sourceRowNo')
    }
    if (seen.has(rowNo)) {
      return failure('export_row', `export:row:${rowNo}`, 'source_row_no_duplicate', `快照行号重复：${rowNo}`, 'rows[].sourceRowNo')
    }
    seen.add(rowNo)
  }

  return null
}

// --- 归并与回填（契约 §5.2）------------------------------------------------

/** 归并血缘：from → to，以及迁了哪些 record / event / evidence。 */
export interface MergeLineage {
  fromEnterpriseId: number
  fromEnterpriseName: string
  intoEnterpriseId: number
  intoUscc: string
  /** 规范行**最终**的名字（给了 `merges[].canonicalName` 就是导出表侧的名字）。 */
  canonicalName: string
  /**
   * **主名称改名**（§5.3 ①）：给 `canonicalName` 且与原名不同时记下 `from → to`，
   * 以及被顶掉原名落成的那条别名 id；没改名是 `null`。
   */
  rename: { from: string; to: string; aliasId: number | null } | null
  aliasId: number | null
  /** 支撑本次归并的查询证据（裸 id 或自然键解析所得）；未给为 null。 */
  evidenceQueryId: number | null
  childRowsMoved: { aliases: number; differences: number; relations: number; records: number }
  /** 直接改指规范行的记录 id（无同坐标冲突）。 */
  recordsMoved: number[]
  /** 折进规范行同坐标记录的记录 id → 规范行记录 id。 */
  recordsFolded: Array<{ fromRecordId: number; intoRecordId: number; fromRecordSnapshot?: RosterRecordRow; eventIds?: number[] }>
  /** 被并企业名下（原）事件 id —— 事件一条都没删，只是记录变了。 */
  eventsMoved: number[]
  /** 随之归入规范行的出处 id（含页码，供回溯「第几页」）。 */
  evidenceMoved: number[]
}

/** Keep replay snapshots in the batch ledger, but expose only caller-facing item details. */
export function publicRosterImportItems(items: readonly RosterImportItemResult[], batchId?: number): RosterImportItemResult[] {
  return items.map((item, itemIndex) => {
    if (!item.detail) return item
    const detail = { ...item.detail }
    const lineage = detail.lineage as MergeLineage | undefined
    if (Array.isArray(lineage?.recordsFolded) && lineage.recordsFolded.some(fold => isObject(fold) && (fold.fromRecordSnapshot !== undefined || fold.eventIds !== undefined))) {
      detail.lineage = { ...lineage, recordsFolded: lineage.recordsFolded.map(fold => { if (!isObject(fold)) return fold; const { fromRecordSnapshot: _snapshot, eventIds: _events, ...old } = fold; return old }), ...(batchId !== undefined ? { snapshotRef: { source: 'private_batch', batchId, itemIndex } } : {}) }
    }
    delete detail.evidenceRepointTargets
    delete detail.evidenceRepointPlanFingerprint
    if (Object.keys(detail).length === Object.keys(item.detail).length && detail.lineage === item.detail.lineage) return item
    const publicItem = { ...item }
    delete publicItem.detail
    return Object.keys(detail).length > 0 ? { ...publicItem, detail } : publicItem
  })
}

// ---------------------------------------------------------------------------
// 出处指针收敛的**重放**（RL-19，契约 §8.9.3）
// ---------------------------------------------------------------------------

/**
 * 收敛重放的记账键：`<原幂等键>#repoint`。
 *
 * 为什么不是原键：`import_batch.idempotency_key` 唯一，而原键那条批次已经 `committed`；
 * 重放是**同一个请求的第二次动作**，它既要能重复跑（可重试），又要留下自己的账目。
 * 派生键确定了这个派生是**确定性的** —— 同一份请求重放多少次都是同一行记账，
 * 且一眼能看出它是哪一批的收敛。
 */
export function replayBatchKey(idempotencyKey: string): string {
  return `${idempotencyKey}#repoint`
}

/** 从原提交批次读取目标快照；旧批次没有快照时返回 undefined，保留兼容重算路径。 */
export function evidenceRepointPlanFromItems(items: unknown, fingerprint: string): EvidenceRepointTarget[] | undefined {
  if (!Array.isArray(items)) return undefined
  let hasPlan = false
  let samePayload = true
  const targets: EvidenceRepointTarget[] = []
  for (const item of items) {
    if (!isObject(item) || !isObject(item.detail) || !Array.isArray(item.detail.evidenceRepointTargets)) continue
    hasPlan = true
    if (item.detail.evidenceRepointPlanFingerprint !== fingerprint) samePayload = false
    for (const raw of item.detail.evidenceRepointTargets) {
      if (!isObject(raw)) continue
      const { id, recordId, recordEventId, fromSourceFile, sourceFile } = raw
      if (
        typeof id === 'number' && Number.isInteger(id) &&
        typeof recordId === 'number' && Number.isInteger(recordId) &&
        typeof recordEventId === 'number' && Number.isInteger(recordEventId) &&
        typeof fromSourceFile === 'string' && typeof sourceFile === 'string'
      ) {
        targets.push({ id, recordId, recordEventId, fromSourceFile, sourceFile })
      }
    }
  }
  return hasPlan && samePayload ? targets : undefined
}

// ---------------------------------------------------------------------------
// 往返一致性（写入后可用它查回「写了什么」）-------------------------------
// ---------------------------------------------------------------------------

/**
 * 读回 `import_batch.summary`，把**本票之前**提交的批次缺的 `evidenceRepointed` 补成 0。
 *
 * 摘要 JSON 是**当次**写下的：RL-19 引入 `evidenceRepointed` 之前提交的行里没有这一项，
 * 而类型里它是必填 —— 不补，调用方就会拿到 `undefined` 并静默算错。缺这一项恰好等价于
 * 「那一批没收敛过任何出处行」，所以补 0 是**事实**，不是猜测。没有摘要则返回 `null`
 * （预检批还没提交过，与既有口径一致）。
 */
export function readSummaryOf(raw: unknown): RosterImportSummary | null {
  if (!isObject(raw)) return null
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    written: num(raw.written),
    skipped: num(raw.skipped),
    failed: num(raw.failed),
    evidenceRepointed: num(raw.evidenceRepointed),
    ...(isObject(raw.platformFields) ? { platformFields: raw.platformFields as unknown as RosterImportSummary['platformFields'] } : {}),
    ...(isObject(raw.canonicalProjection) ? { canonicalProjection: raw.canonicalProjection as unknown as PlatformProjectionSummary } : {}),
  }
}
