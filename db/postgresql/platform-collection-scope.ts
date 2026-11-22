export type CollectionConditionValue =
  | { kind: 'text'; value: string }
  | { kind: 'integer' | 'boolean'; value: number }
  | { kind: 'null' | 'real' | 'array' | 'object' }

export type CollectionConditionWitness = {
  kind: string | null
  storage: 'null' | 'text' | 'blob' | 'integer' | 'real'
  bytes: string | null
}

export type CollectionConditionFacts = {
  values: Record<string, CollectionConditionValue>
  witnesses?: Record<string, CollectionConditionWitness>
}

export type CollectionUnfinishedPosition = {
  ordinal: number
  source: string | null
  rdjb: string | null
  pageNo: number | null
}
