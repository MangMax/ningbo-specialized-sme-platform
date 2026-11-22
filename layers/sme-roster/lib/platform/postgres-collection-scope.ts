import { sql, type SQLWrapper } from 'drizzle-orm'
import type { CollectionConditionFacts, CollectionConditionValue, CollectionUnfinishedPosition } from '../../../../db/postgresql/platform-collection-scope'
import type { DifferenceCollectionScopeRows } from './difference-collection-scope'

type Values = CollectionConditionFacts['values']

export function postgresCollectionConditionValues(facts: SQLWrapper) {
  return sql<Values | null>`${facts} -> 'values'`
}

export function projectPostgresConditionRows(values: Values | null): DifferenceCollectionScopeRows['conditions'] {
  if (values === null) return []
  return Object.keys(values).sort().map(name => {
    const condition = values[name]!
    return {
      name: name as DifferenceCollectionScopeRows['conditions'][number]['name'],
      valueKind: condition.kind,
      textValue: condition.kind === 'text' ? condition.value : null,
      integerValue: condition.kind === 'integer' || condition.kind === 'boolean' ? condition.value : null,
    }
  })
}

function comparisonValue(condition: CollectionConditionValue) {
  if (condition.kind === 'boolean') return Boolean(condition.value)
  return 'value' in condition ? condition.value : null
}

export function projectPostgresComparisonConditions(values: Values | null) {
  return values === null ? null : Object.fromEntries(
    Object.keys(values).sort().map(name => [name, comparisonValue(values[name]!)]),
  )
}
// Keep the historical field order used in qualification plan hashes.
export function projectPostgresUnfinishedPositions(collectionId: number, positions: CollectionUnfinishedPosition[]) {
  return positions.map(({ ordinal, source, rdjb, pageNo }) => ({ collectionId, ordinal, source, rdjb, pageNo }))
}
