import type { Writable } from 'node:stream'

/** No private queue: one bounded line may cross the high-water mark; then wait for drain. */
export function boundedLogOutput(stream: Writable, maxLineBytes: number, maxPerSecond = 10) {
  let blocked = false, failed = false, closed = false, attached = false, pending = 0
  let at = 0, count = 0
  const drain = () => { blocked = false }
  const fault = () => { failed = true; if (closed) detach() }
  function detach() {
    if (!attached) return
    attached = false
    stream.off('drain', drain); stream.off('error', fault); stream.off('close', fault)
  }
  function attach() {
    if (attached) return
    attached = true
    stream.on('drain', drain); stream.on('error', fault); stream.on('close', fault)
  }
  return {
    write(line: string): boolean {
      if (closed || failed || blocked || stream.destroyed || !stream.writable || Buffer.byteLength(line) > maxLineBytes) return false
      if (Date.now() - at >= 1000) { at = Date.now(); count = 0 }
      if (count++ >= maxPerSecond) return false
      attach(); pending++
      try {
        const ready = stream.write(line, error => {
          pending--
          if (error) failed = true
          // Node emits error after the write callback. Retain the handler through that turn.
          if (closed && pending === 0) setImmediate(detach)
        })
        if (!ready) blocked = true
        return true
      } catch { pending--; failed = true; return false }
    },
    close() {
      closed = true
      stream.off('drain', drain)
      // An outstanding write can still emit EPIPE. Keep only its terminal fault handlers.
      if (pending === 0 || failed || stream.destroyed) setImmediate(detach)
    },
  }
}
