import { sql, type SQLWrapper } from 'drizzle-orm'

export const EVENT_ARCHIVE_RULE_VERSION = 'event-archive-212-v1'

/** Same whitespace set as domain.normalizeUscc, evaluated before the bounded select. */
export function normalizedUscc(column: SQLWrapper) {
  let value = sql`upper(coalesce(${column}, ''))`
  for (const character of '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b\u200c\u200d\u2028\u2029\u202f\u205f\u3000\ufeff') value = sql`replace(${value}, ${character}, '')`
  return value
}
