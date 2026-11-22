import { normalizeUscc } from '../../lib/domain'
import { correspondenceIdentityProblem } from './record-correspondence-identity'

export interface CorrespondenceAttribution {
  type: string; enterpriseId: number | null;
  relationEnterpriseId: number | null; relationStatus: string | null; relationUscc: string | null;
  ownerId: number | null; ownerUscc: string | null;
  targetId: number | null; targetUscc: string | null; targetTitle: string | null;
}

export function correspondenceAttributionChanged(row: CorrespondenceAttribution) {
  if (row.relationEnterpriseId && row.relationUscc && (!row.ownerId || row.ownerUscc && normalizeUscc(row.ownerUscc) !== normalizeUscc(row.relationUscc))) return true
  return row.type === 'later_process' && (
    !row.targetId || !row.targetTitle ||
    correspondenceIdentityProblem({ enterpriseId: row.enterpriseId, uscc: row.targetUscc }, { enterpriseId: row.relationEnterpriseId, uscc: row.relationUscc }, true) !== null ||
    !normalizeUscc(row.relationUscc) && row.relationStatus !== 'confirmed'
  )
}
