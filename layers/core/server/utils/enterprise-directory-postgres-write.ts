import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'
import { normalizeReviewedUscc } from '../../lib/enterprise-uscc'
import { EnterpriseKernelError, type EnterpriseFields, type EnterpriseSource, type enterpriseDetailsSchema } from './enterprise-kernel'
import { readPostgresEnterpriseDetails } from './enterprise-directory-postgres'
import type { z } from 'zod'

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Codes = Pick<EnterpriseFields, 'districtCode' | 'townshipCode' | 'industryCode'>

function conflict(code: string, message: string): never {
  throw new EnterpriseKernelError(409, code, message)
}

async function validateCodes(tx: Transaction, { districtCode, townshipCode, industryCode }: Codes) {
  if (!districtCode && !townshipCode && !industryCode) return
  const { rows } = await tx.execute<{ district: boolean; township: boolean; industry: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM enterprise_region WHERE code = ${districtCode ?? null} AND level = 2) AS district,
           EXISTS (SELECT 1 FROM enterprise_region WHERE code = ${townshipCode ?? null} AND level = 3
                   AND parent_code = ${districtCode ?? null}) AS township,
           EXISTS (SELECT 1 FROM enterprise_industry WHERE code = ${industryCode ?? null} AND level = 3) AS industry`)
  const valid = rows[0]!
  if (districtCode && !valid.district) conflict('unknown_district', 'District code is absent from the supplied dictionary')
  if (townshipCode && !valid.township) conflict('township_district_mismatch', 'Township code must belong to the selected district')
  if (industryCode && !valid.industry) conflict('unknown_industry', 'Industry detail code is absent from the supplied dictionary')
}

async function checkedEnterprise(tx: Transaction, id: number, revision: number, operation: 'details' | 'membership') {
  await tx.execute(sql`SELECT id FROM enterprise WHERE id = ${id} FOR UPDATE`)
  const before = await readPostgresEnterpriseDetails(tx, id)
  if (!before) {
    throw new EnterpriseKernelError(404, 'enterprise_not_found', operation === 'details' ? '未找到企业。' : 'Enterprise not found')
  }
  if (before.mergedInto !== null || before.revision !== revision) {
    conflict('enterprise_changed', operation === 'details'
      ? '企业资料已变更，请重新打开后再编辑。'
      : 'Enterprise target or revision changed')
  }
  return before
}

async function saveCodes(tx: Transaction, id: number, revision: number, fields: Codes) {
  await tx.execute(sql`INSERT INTO enterprise_directory (enterprise_id, district_code, township_code, industry_code, revision)
    VALUES (${id}, ${fields.districtCode ?? null}, ${fields.townshipCode ?? null}, ${fields.industryCode ?? null}, ${revision})
    ON CONFLICT (enterprise_id) DO UPDATE SET district_code = excluded.district_code, township_code = excluded.township_code,
      industry_code = excluded.industry_code, revision = excluded.revision`)
}

async function matchingIdentityExists(tx: Transaction, name: string, uscc: string | null) {
  if (uscc === null) {
    const result = await tx.execute(sql`SELECT id FROM enterprise WHERE name_norm = ${name} LIMIT 1`)
    return result.rows.length > 0
  }
  const { rows } = await tx.execute<{ uscc: string }>(sql`SELECT uscc_norm AS uscc FROM enterprise
    WHERE uscc_norm = ${uscc} OR uscc_norm COLLATE "C" ~ '[^A-Z0-9]'`)
  return rows.some(row => normalizeReviewedUscc(row.uscc) === uscc)
}

export async function registerPostgresEnterpriseSource(tx: Transaction, input: EnterpriseSource, enterpriseIds: readonly number[]) {
  const { module, businessTable, versionKey, channel, listType, acquiredOn, series, fileId, sha256 } = input
  const { rows } = await tx.execute<{ id: string }>(sql`INSERT INTO enterprise_source
    (module, business_table, version_key, channel_code, list_type_code, acquired_on, series, file_id, sha256)
    VALUES (${module}, ${businessTable}, ${versionKey}, ${channel}, ${listType}, ${acquiredOn}, ${series}, ${fileId}, ${sha256})
    ON CONFLICT (module, business_table, version_key) DO NOTHING RETURNING id`)
  let id = rows[0]?.id
  if (id === undefined) {
    const prior = await tx.execute<{ id: string; channel: string; listType: string; series: string; sha256: string | null }>(sql`
      SELECT id, channel_code AS channel, list_type_code AS "listType", series, sha256
      FROM enterprise_source
      WHERE module = ${module} AND business_table = ${businessTable} AND version_key = ${versionKey}`)
    const existing = prior.rows[0]
    if (!existing || existing.channel !== channel || existing.listType !== listType
      || existing.series !== series || existing.sha256 !== sha256) {
      conflict('source_conflict', 'This source version already has different provenance')
    }
    id = existing.id
  }
  if (enterpriseIds.length) {
    await tx.execute(sql`INSERT INTO enterprise_source_link (enterprise_id, source_id)
      VALUES ${sql.join(enterpriseIds.map(enterpriseId => sql`(${enterpriseId}, ${id})`), sql`, `)}
      ON CONFLICT DO NOTHING`)
  }
  return Number(id)
}

export function addPostgresEnterprise(db: NodePgDatabase, fields: EnterpriseFields & { name: string }) {
  return db.transaction(async tx => {
    await validateCodes(tx, fields)
    const name = normalizeEnterpriseName(fields.name)
    const uscc = fields.uscc ?? null
    // Serialize matching submissions, including legacy rows whose stored codes are not normalized.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('enterprise:name:' || ${name}, 0))`)
    if (uscc) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('enterprise:uscc:' || ${uscc}, 0))`)
    }
    if (await matchingIdentityExists(tx, name, uscc)) {
      conflict('existing_subject', 'A matching identity already exists; confirm an enterprise ID')
    }
    const inserted = await tx.execute<{ id: string }>(sql`INSERT INTO enterprise (name, name_norm, uscc_norm, quality_flags)
      VALUES (${fields.name}, ${name}, ${uscc}, ${JSON.stringify(uscc ? [] : ['uscc_missing'])}) RETURNING id`)
    const id = Number(inserted.rows[0]!.id)
    await saveCodes(tx, id, 1, fields)
    await registerPostgresEnterpriseSource(tx, {
      module: 'core', businessTable: 'enterprise', versionKey: String(id), channel: 'direct', listType: 'direct',
      acquiredOn: new Date().toISOString().slice(0, 10), series: '直接添加', fileId: null, sha256: null,
    }, [id])
    return (await readPostgresEnterpriseDetails(tx, id))!
  })
}

export function savePostgresEnterpriseDetails(db: NodePgDatabase, id: number, input: z.infer<typeof enterpriseDetailsSchema>) {
  return db.transaction(async tx => {
    const { expectedRevision, registeredAddress, operatingAddress, ...fields } = input
    const before = await checkedEnterprise(tx, id, expectedRevision, 'details')
    if (before.removedReason !== null) conflict('enterprise_removed', '企业已移出基础库。')
    const next = { ...before, ...fields }
    await validateCodes(tx, next)
    await saveCodes(tx, id, before.revision + 1, next)
    await tx.execute(sql`DELETE FROM enterprise_address WHERE enterprise_id = ${id}`)
    const values = [
      { kind: 'registered', address: registeredAddress },
      { kind: 'operating', address: operatingAddress },
    ].filter(row => row.address !== null)
    if (values.length) {
      await tx.execute(sql`INSERT INTO enterprise_address (enterprise_id, kind, address) VALUES ${sql.join(
        values.map(row => sql`(${id}, ${row.kind}, ${row.address})`), sql`, `,
      )}`)
    }
    return (await readPostgresEnterpriseDetails(tx, id))!
  })
}

export function setPostgresEnterpriseRemoved(db: NodePgDatabase, id: number, revision: number, reason: string | null) {
  return db.transaction(async tx => {
    const before = await checkedEnterprise(tx, id, revision, 'membership')
    await tx.execute(sql`INSERT INTO enterprise_directory (enterprise_id, revision, removed_reason)
      VALUES (${id}, ${before.revision + 1}, ${reason})
      ON CONFLICT (enterprise_id) DO UPDATE SET revision = excluded.revision, removed_reason = excluded.removed_reason`)
    return (await readPostgresEnterpriseDetails(tx, id))!
  })
}
