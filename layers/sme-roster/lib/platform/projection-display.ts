/** A rule exists only when this exact content version has a source projection. */
export function projectionDisplay<T>(
  version: { ruleVersion: string | null },
  value: T,
  format?: (value: NonNullable<T>) => string,
): string {
  if (version.ruleVersion == null) return '业务字段未同步'
  if (value == null || value === '') return '原文未提供'
  return format ? format(value) : String(value)
}
