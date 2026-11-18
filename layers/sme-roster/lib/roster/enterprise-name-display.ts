import { normalizeName } from '../domain'

/** Names that are genuine historical names for display, excluding the current name. */
export function historicalAliasNamesForDisplay(aliasNames: readonly string[], currentName: string): string[] {
  const normalizedCurrentName = normalizeName(currentName)
  return aliasNames.filter((alias) => normalizeName(alias) !== normalizedCurrentName)
}
