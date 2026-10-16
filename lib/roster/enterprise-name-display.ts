/** Names that are genuine historical names for display, excluding the current name. */
export function historicalAliasNamesForDisplay(aliasNames: readonly string[], currentName: string): string[] {
  return aliasNames.filter((alias) => alias !== currentName)
}
