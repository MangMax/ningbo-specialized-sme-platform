import { and, desc, eq, sql } from 'drizzle-orm'
import { platformBusinessObservation as observation, platformCollection as collection,
  platformObservationAssignment as assignment } from '../../../../../db/postgresql/platform-tables'
import { refreshRelationFields } from '../../../../../layers/sme-roster/lib/platform/difference-hash-keys'
import { snapshotSchema } from '../../../../../layers/sme-roster/lib/platform/evidence-snapshot-model'
import type { PostgresQualificationTransaction as Tx } from '../../../../../layers/sme-roster/lib/roster/current-qualification-postgres'

function restoreJsonEscapes(text: string, quoted: boolean | null) {
  return quoted ? text.replace(/\\\\\|(u[0-9a-fA-F]{4})?\|/g, (_, escape: string | undefined) => escape ? '\\' + escape : '\\\\') : text
}

function relationMaterial(snapshot: unknown, match_basis: string | null, verification_status: string, business: string | null, quoted: boolean | null) {
  const cells = new Map(snapshotSchema.parse(snapshot).fields.map(cell => [cell.name, cell]))
  const original = (name: string) => {
    const cell = cells.get(name)
    if (!cell || cell.storageClass === 'null') return null
    const value = Buffer.from(cell.hex, 'hex').toString('utf8')
    if (cell.storageClass === 'integer' || cell.storageClass === 'real') return Number(value)
    if (cell.storageClass === 'blob') throw new Error('Difference refresh cannot hash a binary relation field')
    return value
  }
  const fields = { ...Object.fromEntries(refreshRelationFields.map(name => [name, original(name)])), match_basis, verification_status }
  if (business === null) return fields
  if (business === '{') return { ...fields, sourceBusinessMalformed: true }
  return { ...fields, sourceBusiness: JSON.parse(restoreJsonEscapes(business, quoted)) }
}

export async function readLegacyPlatformRefreshFacts(tx: Tx, selected: ReturnType<typeof sql>) {
  const current = tx.select({ matchBasis: assignment.matchBasis, verificationStatus: assignment.verificationStatus })
    .from(assignment).where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('current_assignment')
  const sources = await tx.select({
    collectionId: observation.collectionId, matchBasis: current.matchBasis, verificationStatus: current.verificationStatus,
    facts: sql<{ fields: unknown; business: string | null; quoted: boolean | null }>`business.platform_business_observation.refresh_facts`,
  }).from(observation)
    .innerJoinLateral(current, sql`true`)
    .where(and(sql`${observation.collectionId} = any(${selected})`, sql`business.platform_business_observation.refresh_facts IS NOT NULL`))
  const relations = Map.groupBy(sources.map(row => ({
    collectionId: row.collectionId,
    material: relationMaterial({ encoding: 't05a-sqlite-cells-v1', fields: row.facts!.fields },
      row.matchBasis, row.verificationStatus, row.facts!.business, row.facts!.quoted),
  })), row => row.collectionId)
  const metadataRows = await tx.select({ collectionId: collection.id, metadata: sql<{ json: string | null; quoted: boolean | null } | null>`business.platform_collection.refresh_metadata` })
    .from(collection).where(sql`${collection.id} = any(${selected})`)
  const metadata = new Map(metadataRows.map(({ collectionId, metadata }) => [collectionId,
    metadata?.json == null ? null : restoreJsonEscapes(metadata.json, metadata.quoted)]))
  return { relations, metadata }
}
