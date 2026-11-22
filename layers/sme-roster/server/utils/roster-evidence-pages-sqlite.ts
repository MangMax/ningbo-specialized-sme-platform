import { eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import type { EvidencePageCandidate } from '../../lib/roster/evidence-page'
import { createLegacyEvidencePageAdapter } from './roster-evidence-correction'
import { handleEvidencePagesRequest as handle, type EvidencePagesHttpRequest, type EvidencePageContext } from './roster-evidence-pages'
export type { EvidencePagesHttpRequest } from './roster-evidence-pages'

type Db = BetterSQLite3Database<typeof schema>

export function readEvidencePageCandidates(db: Db, sourceFiles: readonly string[]): EvidencePageCandidate[] {
  const wanted = [...new Set(sourceFiles.filter((f) => typeof f === 'string' && f !== ''))]
  if (wanted.length === 0) return []

  return db
    .select({
      evidenceId: schema.recordEvidence.id,
      sourceFile: schema.recordEvidence.sourceFile,
      listNo: schema.recordEvidence.listNo,
      page: schema.recordEvidence.page,
      enterpriseId: schema.enterprise.id,
      enterpriseName: schema.enterprise.name,
      district: schema.record.district,
      // 企业自身属地也带上:界面上显示的有效属地是它优先(见 `EvidencePageCandidate`)。
      enterpriseDistrict: schema.enterprise.district,
    })
    .from(schema.recordEvidence)
    .innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId))
    .innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId))
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(inArray(schema.recordEvidence.sourceFile, wanted))
    .all()
}

export function handleEvidencePagesRequest(request: EvidencePagesHttpRequest, ctx: EvidencePageContext & { db: Db }) {
  return handle(request, ctx, () => ({
    candidates: paths => readEvidencePageCandidates(ctx.db, paths),
    applyPage: createLegacyEvidencePageAdapter(ctx.db, ctx.filesDir),
  }))
}
