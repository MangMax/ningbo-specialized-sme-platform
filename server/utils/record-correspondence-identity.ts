import { normalizeUscc } from '../../lib/domain'

type Identity = { enterpriseId?: number | null; uscc: string | null }
/** Shared by full source validation and narrow refs, including unassigned rows. */
export function correspondenceIdentityProblem(left: Identity, right: Identity, confirmed: boolean): { code: 'identity_conflict' | 'ambiguous_candidate'; message: string } | null {
  const a = normalizeUscc(left.uscc), b = normalizeUscc(right.uscc)
  if (a && b && a !== b) return { code: 'identity_conflict', message: 'Source USCC values conflict' }
  if (left.enterpriseId && right.enterpriseId && left.enterpriseId !== right.enterpriseId) return { code: 'identity_conflict', message: 'Source enterprise IDs conflict' }
  const sameOwner = left.enterpriseId && right.enterpriseId && left.enterpriseId === right.enterpriseId
  if (confirmed && (!a || !b) && !sameOwner) return { code: 'ambiguous_candidate', message: 'No verified row-level enterprise identity' }
  if (!a && !b && !sameOwner) return { code: 'ambiguous_candidate', message: 'Candidate has no enterprise identity anchor' }
  return null
}
