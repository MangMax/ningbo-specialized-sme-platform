import pg, { type QueryResult } from 'pg'
import { vi } from 'vitest'

export function observeJobSelects() {
  const queries: { sql: string; fields: string[]; bytes: number }[] = []
  const original = pg.Client.prototype.query
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
    this: pg.Client, ...args: Parameters<typeof original>
  ) {
    const request = args[0] as string | { text?: string }
    const sql = typeof request === 'string' ? request : request.text
    if (!sql || !/^select\b/i.test(sql)) return Reflect.apply(original, this, args)
    const record = (result: QueryResult) => {
      queries.push({ sql, fields: result.fields.map(field => field.name), bytes: Buffer.byteLength(JSON.stringify(result.rows)) })
      return result
    }
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      return Reflect.apply(original, this, [...args.slice(0, -1), (error: Error, result: QueryResult) => {
        if (!error) record(result)
        return Reflect.apply(callback, this, [error, result])
      }])
    }
    const output = Reflect.apply(original, this, args) as Promise<QueryResult> | undefined
    return typeof output?.then === 'function' ? output.then(record) : output
  })
  return { queries, close: () => spy.mockRestore() }
}
