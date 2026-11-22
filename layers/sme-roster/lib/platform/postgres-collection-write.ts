import { createHash } from 'node:crypto'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/postgresql/platform-tables'
import type { CollectionConditionFacts } from '../../../../db/postgresql/platform-collection-scope'
import { recognizedYearCondition, type RecognizedSourceScope, type RecognizedSourcePosition } from '../../../../db/postgresql/recognized-source-scope'
import { platformQueryTitleScope } from '../../../../db/postgresql/platform-query-scope-tables'
import { collectionInsertValues, parseNewCollectionInput, type NewCollectionTargetCommand } from './collection-command-input'
import type { ApplyTargetInput } from './apply-target-writer'
import { capturePostgresCollectionFacts } from './postgres-platform-facts'
import { platformCollectionReuseSha256 } from './collection-reuse-digest'
import { RDJB_TITLE_CODES } from './recognized-evidence'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Position = ApplyTargetInput['position']
const conditionNames = ['name','uscc','combination','sqsj','rddqrq','whpcyear','whpc','szq','orderField','orderDirection'] as const

export async function writePostgresCollectionHeader(tx: Tx, command: NewCollectionTargetCommand) {
  const query = parseNewCollectionInput(command)
  const evidence = query.collectionEvidence
  const columns = collectionInsertValues(query,command.createdAt)
  const coverage = evidence ? (({ rows, dataRows, rawData, ...metadata }) => metadata)(evidence) : null
  const rawResponse = query.rawResponse ?? null
  let recognizedScope: RecognizedSourceScope | null = null
  if (query.interface === 'recognized_list' && query.status === 'success') {
    if (command.evidenceText === null || !evidence) recognizedScope = { state: 'gap', reason: 'unsupported_capture_rule' }
    else if (evidence.source !== 'queryBusList' || evidence.status !== 'success' ||
      evidence.completeness !== 'complete' || !evidence.fullRange || evidence.effectiveConditions.combination !== 'and') recognizedScope = { state: 'not_applicable' }
    else recognizedScope = {
      state: 'captured',
      conditions: {
        validYear: recognizedYearCondition(evidence.effectiveConditions.rddqrq),
        maintenanceYear: recognizedYearCondition(evidence.effectiveConditions.whpcyear),
      },
    }
  }
  const conditionFacts: CollectionConditionFacts = { values: {} }
  for (const name of conditionNames) {
    const value = evidence?.effectiveConditions[name]
    if (value !== undefined) conditionFacts.values[name] = { kind: 'text', value }
  }
  const unfinishedPositions = (evidence?.unfinished ?? []).map(({ source, rdjb, page }, ordinal) => ({
    ordinal, source, rdjb, pageNo: page,
  }))
  const [collection] = await tx.insert(schema.platformCollection).values({
    ...columns, ...capturePostgresCollectionFacts(command.evidenceText, rawResponse), recognizedScope, conditionFacts, unfinishedPositions, sourceCoverage: coverage, reusableContentSha256: evidence ? platformCollectionReuseSha256(evidence) : null,
    rawResponseSha256: rawResponse === null ? null : createHash('sha256').update(rawResponse).digest('hex'),
  }).returning({ id: schema.platformCollection.id, publicId: schema.platformCollection.publicId })
  const collectionId = collection!.id
  const positions = new Map<number, Position>()
  const pageTitles = new Map<number, string | null>()
  let offset = 0
  for (const [ordinal,page] of (evidence?.pages ?? []).entries()) {
    const count = page.status === 'success' ? page.fetchedCount : 0
    const [savedPage] = await tx.insert(schema.platformCollectionPage).values({
      collectionId,ordinal,source:page.source,rdjb:page.rdjb,pageNo:page.page,maxPage:page.maxPage ?? null,
      maxPagePresent: Object.hasOwn(page,'maxPage') ? 1 : 0,fetchedCount:page.fetchedCount,declaredTotal:page.declaredTotal,
      status:page.status,errorCode:page.error?.code ?? null,errorMessage:page.error?.message ?? null,
      sequenceStart:count ? offset+1 : null,sequenceEnd:count ? offset+count : null,positionState:'verified',
    }).returning({ id: schema.platformCollectionPage.id })
    const pageId = savedPage!.id
    for (let row = 1; row <= count; row++) {
      const sequenceNo = offset+row
      positions.set(sequenceNo,{ sequenceNo,pageId,pageRowNo:row,positionState:'verified' })
      pageTitles.set(sequenceNo,page.rdjb)
    }
    offset += count
  }
  for (const rdjb of new Set(evidence?.titleScope.rdjb ?? [])) {
    await tx.insert(platformQueryTitleScope).values({ collectionId,rdjb })
  }
  const queryId = collection!.publicId
  const placement = (sequenceNo: number) => {
    const position = positions.get(sequenceNo) ?? { sequenceNo, positionState: 'unknown' as const }
    const rdjb = pageTitles.get(sequenceNo) ?? null
    const code = columns.rdjb.includes(',') ? RDJB_TITLE_CODES[rdjb ?? ''] ?? columns.titleCode : columns.titleCode ?? RDJB_TITLE_CODES[columns.rdjb]
    const candidateScopeMask = Object.entries(RDJB_TITLE_CODES).reduce((mask,[key,title]) =>
      code === title || code == null && columns.rdjb.split(',').includes(key) ? mask | 1 << (Number(key)-1) : mask,0)
    const recognizedPosition: RecognizedSourcePosition | null = recognizedScope?.state !== 'captured' ? null
      : positions.has(sequenceNo) ? { state: 'matched', rdjbKey: rdjb ? Buffer.from(rdjb, 'utf16le').toString('hex') : null }
      : { state: 'unmatched' }
    return { position, candidateScopeMask, recognizedPosition }
  }
  return { collectionId,queryId,query,placement,columns }
}
