/** A browser claim, never trusted execution context. No coercion, truncation or free text. */
export function clientRequestReference(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined
}
