/** An explicit decision on this observation. Never inherited by another observation. */
export interface AnnualDecisionRef {
  id: number
  relationId: number
  revision: number
  status: 'candidate' | 'confirmed' | 'rejected' | 'unlinked'
  requiresRevalidation: boolean
}
export interface AnnualFinalQualification {
  stepId: string | null
  status: 'confirmed' | 'eligible' | 'blocked' | 'none'
  decisionRefs: AnnualDecisionRef[]
  reasons: string[]
}
