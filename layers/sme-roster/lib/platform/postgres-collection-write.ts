import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/postgresql/platform-tables'
import type { CollectionConditionFacts } from '../../../../db/postgresql/platform-collection-scope'
import { platformQueryTitleScope } from '../../../../db/postgresql/platform-query-scope-tables'
import { collectionInsertValues, parseNewCollectionInput, type NewCollectionTargetCommand } from './collection-command-input'
import type { ApplyTargetInput } from './apply-target-writer'
import { capturePostgresCollectionFacts } from './postgres-platform-facts'
import { platformCollectionReuseSha256 } from './collection-reuse-digest'
import { encodePlatformExactCell } from './postgres-platform-insert'
import { witnessConditionNames, WITNESS_RULE, captureWitnessPosition, type captureWitnessInputs } from './recognized-witness-capture'
import { CANDIDATE_SCOPE_RULE } from './candidate-scope-capture'
import { RDJB_TITLE_CODES } from './recognized-evidence'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Position = ApplyTargetInput['position']
type Evidence = NonNullable<ReturnType<typeof parseNewCollectionInput>['collectionEvidence']>
const conditionNames = ['name','uscc','combination','sqsj','rddqrq','whpcyear','whpc','szq','orderField','orderDirection'] as const

function witnessInput(evidence: Evidence) {
  const conditions = Object.fromEntries(witnessConditionNames.map(name => {
    const value = evidence.effectiveConditions[name]
    return [name, { value: value ?? null, kind: value === undefined ? 'absent' : value === null ? 'null' : 'text' }]
  })) as ReturnType<typeof captureWitnessInputs>['conditions']
  const gate = evidence.source === 'queryBusList' && evidence.status === 'success' && evidence.completeness === 'complete' &&
    evidence.fullRange && evidence.effectiveConditions.combination === 'and'
  return { state: 'captured' as const, gate: Number(gate), pages: JSON.stringify(evidence.pages), conditions, errorName: null, error: null }
}

export async function writePostgresCollectionHeader(tx: Tx, command: NewCollectionTargetCommand) {
  const query = parseNewCollectionInput(command)
  const evidence = query.collectionEvidence
  const columns = collectionInsertValues(query,command.createdAt)
  const coverage = evidence ? (({ rows, dataRows, rawData, ...metadata }) => metadata)(evidence) : null
  const rawResponse = query.rawResponse ?? null
  const witness = query.interface === 'recognized_list' && command.evidenceText !== null && evidence ? witnessInput(evidence) : null
  const conditionFacts: CollectionConditionFacts = { values: {} }
  for (const name of conditionNames) {
    const value = evidence?.effectiveConditions[name]
    if (value !== undefined) conditionFacts.values[name] = { kind: 'text', value }
  }
  if (witness) {
    conditionFacts.witnesses = Object.fromEntries(witnessConditionNames.map(name => {
      const { value, kind } = witness.conditions[name]
      const { witnessValue, witnessValueSqliteStorage } = encodePlatformExactCell('witnessValue', value)
      return [name, { kind, storage: witnessValueSqliteStorage, bytes: witnessValue?.toString('base64') ?? null }]
    }))
  }
  const unfinishedPositions = (evidence?.unfinished ?? []).map(({ source, rdjb, page }, ordinal) => ({
    ordinal, source, rdjb, pageNo: page,
  }))
  const [collection] = await tx.insert(schema.platformCollection).values({
    ...columns, conditionFacts, unfinishedPositions, sourceCoverage: coverage, reusableContentSha256: evidence ? platformCollectionReuseSha256(evidence) : null,
    rawResponseSha256: rawResponse === null ? null : createHash('sha256').update(rawResponse).digest('hex'),
  }).returning({ id: schema.platformCollection.id, publicId: schema.platformCollection.publicId })
  const collectionId = collection!.id
  const evidenceArchive = command.evidenceText === null ? undefined
    : { id: collectionId, sha256: createHash('sha256').update(command.evidenceText).digest('hex') }
  await tx.update(schema.platformCollection)
    .set(capturePostgresCollectionFacts(command.evidenceText, rawResponse, evidenceArchive))
    .where(eq(schema.platformCollection.id, collectionId))
  if (witness) {
    await tx.update(schema.platformCollection).set({
      witnessRule: WITNESS_RULE, witnessState: 'captured', witnessArchiveId: evidenceArchive!.id,
      witnessSha256: evidenceArchive!.sha256, witnessGate: witness.gate,
    }).where(eq(schema.platformCollection.id, collectionId))
  }
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
    const candidate = { candidateScopeState: 'captured' as const,candidateScopeMask,candidateScopeRule:CANDIDATE_SCOPE_RULE,
      candidateScopeArchiveId:collectionId,candidateScopeRdjb:columns.rdjb,candidateScopeTitleCode:columns.titleCode,
      candidateScopeSequenceNo:sequenceNo,candidateScopeError:null }
    const capture = witness ? captureWitnessPosition(witness,sequenceNo) : null
    const matched = capture?.state === 'matched'
    const witnessFields = capture ? {
      witnessRule:WITNESS_RULE,witnessCollectionId:collectionId,witnessSequenceNo:sequenceNo,
      witnessArchiveId:evidenceArchive!.id,witnessSha256:evidenceArchive!.sha256,witnessState:capture.state,
      witnessOrdinal:matched ? capture.ordinal : null,witnessRdjbKind:matched ? capture.rdjb.kind : null,
      witnessRdjbKey:matched && capture.rdjbKey !== null ? Buffer.from(capture.rdjbKey,'utf16le').toString('hex') : null,
      witnessPageKind:matched ? capture.page.kind : null,witnessErrorName:capture.errorName,witnessError:capture.error,
    } : {}
    const exact = capture ? { ...encodePlatformExactCell('witnessRdjbValue',matched ? capture.rdjb.value : null),
      ...encodePlatformExactCell('witnessPageValue',matched ? capture.page.value : null) } : {}
    return { position,candidate,witnessFields,exact }
  }
  return { collectionId,queryId,query,placement,columns }
}
