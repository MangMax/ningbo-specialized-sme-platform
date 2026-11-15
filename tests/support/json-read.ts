/** Decode JSON at the same place a real HTTP/MCP client does. Route modules may
 * return a transferable JSON buffer; tool handlers may return JSON text directly. */
export function decodeJsonRead<T>(handler: (event: never) => unknown): (event: unknown) => Promise<T> {
  return (event) => {
    // Preserve synchronous parameter guards while awaiting successful IO.
    const result = handler(event as never)
    return Promise.resolve(result).then(value => JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value)) as T)
  }
}
