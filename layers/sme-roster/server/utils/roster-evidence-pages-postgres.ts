import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import type { EvidencePageCandidate } from '../../lib/roster/evidence-page'
import { createPostgresLegacyEvidencePageAdapter } from './roster-evidence-correction-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'
import { handleEvidencePagesRequest, type EvidencePageContext, type EvidencePagesHttpRequest } from './roster-evidence-pages'

async function readPostgresEvidencePageCandidates(db: NodePgDatabase, sourceFiles: string[]): Promise<EvidencePageCandidate[]> {
  const wanted = sourceFiles.filter(path => !path.includes('\0') && path.isWellFormed())
  if (wanted.length === 0) return []
  return db.select({ evidenceId: recordEvidence.id, sourceFile: recordEvidence.sourceFile, listNo: recordEvidence.listNo,
    page: recordEvidence.page, enterpriseId: enterprise.id, enterpriseName: enterprise.name, district: record.district,
    enterpriseDistrict: enterprise.district,
  }).from(recordEvidence)
    .innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
    .innerJoin(record, eq(record.id, recordEvent.recordId))
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    // Drizzle inArray binds each path separately. Retain one bound array for an unrestricted import batch.
    .where(sql`${recordEvidence.sourceFile} = ANY(${sql.param(wanted)}::text[])`)
    .orderBy(recordEvidence.sourceFile, recordEvidence.id)
}

/** 入参里那些**来源文件**。用于把候选读窄,顺带做输入校验(非字符串/空的丢掉)。 */

export function handlePostgresEvidencePagesRequest(request: EvidencePagesHttpRequest, ctx: EvidencePageContext) {
  return handleEvidencePagesRequest(request, ctx, write => {
    const db = usePostgresRosterDb(write)
    return {
      candidates: paths => readPostgresEvidencePageCandidates(db, paths),
      applyPage: createPostgresLegacyEvidencePageAdapter(db, ctx.filesDir),
    }
  })
}
