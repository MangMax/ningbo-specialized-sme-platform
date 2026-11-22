import type { PlatformStoredRelation } from './read'

export type DifferenceObservation = Pick<PlatformStoredRelation,
  'id' | 'queryId' | 'sequenceNo' | 'relationKey' | 'enterpriseId' | 'nameRaw' | 'aliasNameRaw' |
  'verificationStatus' | 'matchBasis'> & {
  observationId: number
  collectionId: number
  versionId: number | null
  uscc: string | null
}

export { projectDifferenceCollectionScope, type DifferenceCollectionScopeRows } from './difference-collection-scope'

export interface DifferenceCollectionTarget {
  enterpriseId: number
  titleCode: string
  rdjb: string
  queryKeys: readonly string[]
  uscc: string | null
}
