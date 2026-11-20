import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { collectionInsertValues, parseNewCollectionInput, type NewCollectionTargetCommand } from './collection-target-command'
import type { ApplyTargetInput } from './apply-target-writer'
import { allocatePostgresPlatformAlias, bindPostgresArchive, sealPostgresArchive, writePostgresArchiveValue } from './postgres-archive-write'
import { encodePlatformExactCell, insertPostgresPlatformRow, postgresPlatformInsert } from './postgres-platform-insert'
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
  const collectionId = await insertPostgresPlatformRow(tx,schema.platformCollection,columns)
  const archive = new Map<string, Awaited<ReturnType<typeof writePostgresArchiveValue>>>()
  for (const [field, value] of [['request',command.queryText],['rawResponse',query.rawResponse ?? null],['collectionEvidence',command.evidenceText]] as const) {
    const stored = await writePostgresArchiveValue(tx,value,command.createdAt)
    await bindPostgresArchive(tx,{ kind: 'collection',ownerId: collectionId,field },stored.id)
    archive.set(field,stored)
  }
  await sealPostgresArchive(tx,{ kind: 'collection',ownerId: collectionId })
  const evidenceArchive = archive.get('collectionEvidence')!
  const witness = query.interface === 'recognized_list' && evidence ? witnessInput(evidence) : null
  if (witness) {
    await tx.execute(sql`UPDATE platform_collection SET witness_rule=${WITNESS_RULE},witness_state='captured',
      witness_archive_id=${evidenceArchive.id},witness_sha256=${evidenceArchive.sha256},witness_gate=${witness.gate}
      WHERE id=${collectionId}`)
  }
  for (const name of conditionNames) {
    const value = evidence?.effectiveConditions[name]
    const w = witness?.conditions[name as typeof witnessConditionNames[number]]
    await tx.execute(postgresPlatformInsert(schema.platformCollectionCondition,
      { collectionId, name, valueKind: value === undefined ? 'absent' : 'text', textValue: value ?? null },
      w ? { witness_kind: w.kind, ...encodePlatformExactCell('witness_value', w.value) } : {}))
  }
  const positions = new Map<number, Position>()
  const pageTitles = new Map<number, string | null>()
  let offset = 0
  for (const [ordinal,page] of (evidence?.pages ?? []).entries()) {
    const count = page.status === 'success' ? page.fetchedCount : 0
    const pageId = await insertPostgresPlatformRow(tx,schema.platformCollectionPage,{
      collectionId,ordinal,source:page.source,rdjb:page.rdjb,pageNo:page.page,maxPage:page.maxPage ?? null,
      maxPagePresent: Object.hasOwn(page,'maxPage') ? 1 : 0,fetchedCount:page.fetchedCount,declaredTotal:page.declaredTotal,
      status:page.status,errorCode:page.error?.code ?? null,errorMessage:page.error?.message ?? null,
      sequenceStart:count ? offset+1 : null,sequenceEnd:count ? offset+count : null,positionState:'verified',
    })
    for (let row = 1; row <= count; row++) {
      const sequenceNo = offset+row
      positions.set(sequenceNo,{ sequenceNo,pageId,pageRowNo:row,positionState:'verified' })
      pageTitles.set(sequenceNo,page.rdjb)
    }
    offset += count
  }
  for (const [ordinal,unfinished] of (evidence?.unfinished ?? []).entries()) {
    await tx.execute(postgresPlatformInsert(schema.platformCollectionUnfinished,
      { collectionId,ordinal,source:unfinished.source,rdjb:unfinished.rdjb,pageNo:unfinished.page }))
  }
  for (const rdjb of new Set(evidence?.titleScope.rdjb ?? [])) {
    await tx.execute(postgresPlatformInsert(schema.platformQueryTitleScope,{ collectionId,rdjb }))
  }
  const queryAlias = await allocatePostgresPlatformAlias(tx,'query',collectionId)
  const placement = (sequenceNo: number) => {
    const position = positions.get(sequenceNo) ?? { sequenceNo, positionState: 'unknown' as const }
    const rdjb = pageTitles.get(sequenceNo) ?? null
    const code = columns.rdjb.includes(',') ? RDJB_TITLE_CODES[rdjb ?? ''] ?? columns.titleCode : columns.titleCode ?? RDJB_TITLE_CODES[columns.rdjb]
    const candidateScopeMask = Object.entries(RDJB_TITLE_CODES).reduce((mask,[key,title]) =>
      code === title || code == null && columns.rdjb.split(',').includes(key) ? mask | 1 << (Number(key)-1) : mask,0)
    const candidate = { candidateScopeState: 'captured' as const,candidateScopeMask,candidateScopeRule:CANDIDATE_SCOPE_RULE,
      candidateScopeArchiveId:evidenceArchive.id,candidateScopeRdjb:columns.rdjb,candidateScopeTitleCode:columns.titleCode,
      candidateScopeSequenceNo:sequenceNo,candidateScopeError:null }
    const capture = witness ? captureWitnessPosition(witness,sequenceNo) : null
    const matched = capture?.state === 'matched'
    const witnessFields = capture ? {
      witnessRule:WITNESS_RULE,witnessCollectionId:collectionId,witnessSequenceNo:sequenceNo,
      witnessArchiveId:evidenceArchive.id,witnessSha256:evidenceArchive.sha256,witnessState:capture.state,
      witnessOrdinal:matched ? capture.ordinal : null,witnessRdjbKind:matched ? capture.rdjb.kind : null,
      witnessRdjbKey:matched && capture.rdjbKey !== null ? Buffer.from(capture.rdjbKey,'utf16le').toString('hex') : null,
      witnessPageKind:matched ? capture.page.kind : null,witnessErrorName:capture.errorName,witnessError:capture.error,
    } : {}
    const exact = capture ? { ...encodePlatformExactCell('witness_rdjb_value',matched ? capture.rdjb.value : null),
      ...encodePlatformExactCell('witness_page_value',matched ? capture.page.value : null) } : {}
    return { position,candidate,witnessFields,exact }
  }
  return { collectionId,queryAlias,query,placement,columns,rawArchive:archive.get('rawResponse')! }
}
