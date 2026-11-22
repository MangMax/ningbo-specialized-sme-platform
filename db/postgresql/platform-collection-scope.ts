export type CollectionConditionValue =
  | { kind: 'text'; value: string }
  | { kind: 'integer' | 'boolean'; value: number }
  | { kind: 'null' | 'real' | 'array' | 'object' }

export type CollectionConditionFacts = {
  values: Record<string, CollectionConditionValue>
}

export type CollectionUnfinishedPosition = {
  ordinal: number
  source: string | null
  rdjb: string | null
  pageNo: number | null
}
