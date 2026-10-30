/** Local capacity ownership only. No HTTP, identity, SDK or cancellation policy. */
export type AdmissionState = 'pending' | 'ready' | 'closing' | 'closed'
export type CloseResult = { complete: true } | { complete: false; reason: 'cleanup_failed' }
export type InitializeResult<T> = { ok: true; value: T } | {
  ok: false
  reason: 'lease_unavailable' | 'factory_failed' | 'revoked'
}
export interface AdmissionSnapshot {
  pending: number
  ready: number
  closing: number
  total: number
  accepting: boolean
}
export interface AdmissionLease {
  readonly generation: bigint
  state(): AdmissionState
  initialize<T>(factory: () => T | Promise<T>, cleanup: (value: T) => void | Promise<void>): Promise<InitializeResult<T>>
  close(): Promise<CloseResult>
}
export type Reservation = { ok: true; lease: AdmissionLease } | {
  ok: false
  reason: 'shutdown' | 'session_capacity' | 'pending_capacity'
}

export function createSessionAdmission() {
  // This set owns only repository leases, never vendor transports/controllers.
  // Closed leases are removed; the registry cannot exceed 64 entries.
  const live = new Set<AdmissionLease>()
  let generation = 0n
  let accepting = true

  function snapshot(): AdmissionSnapshot {
    const counts: AdmissionSnapshot = { pending: 0, ready: 0, closing: 0, total: live.size, accepting }
    for (const lease of live) {
      const state = lease.state()
      if (state !== 'closed') counts[state]++
    }
    return counts
  }

  function reserve(): Reservation {
    if (!accepting) return { ok: false, reason: 'shutdown' }
    if (live.size >= 64) return { ok: false, reason: 'session_capacity' }
    if (snapshot().pending >= 8) return { ok: false, reason: 'pending_capacity' }
    let state: AdmissionState = 'pending'
    let started = false
    let dispose: (() => void | Promise<void>) | undefined
    let cleaning = false
    let finishClose!: (result: CloseResult) => void
    const closed = new Promise<CloseResult>(resolve => { finishClose = resolve })

    function release() {
      if (state === 'closed') return
      state = 'closed'
      dispose = undefined
      live.delete(lease)
      finishClose({ complete: true })
    }

    async function clean() {
      if (cleaning || !dispose) return
      cleaning = true // before calling user code, including reentrant close
      const cleanup = dispose
      dispose = undefined // never retain resource or raw failure after cleanup
      try {
        await cleanup()
        release()
      } catch {
        // Failed cleanup is not a released resource; no automatic retry.
        finishClose({ complete: false, reason: 'cleanup_failed' })
      }
    }

    const lease: AdmissionLease = Object.freeze({
      generation: ++generation,
      state: () => state,
      async initialize<T>(factory: () => T | Promise<T>, cleanup: (value: T) => void | Promise<void>): Promise<InitializeResult<T>> {
        if (started || state !== 'pending') return { ok: false, reason: 'lease_unavailable' }
        started = true
        let value: T
        try {
          value = await factory()
        } catch {
          const revoked = state !== 'pending'
          release() // factory produced no resource to clean
          return { ok: false, reason: revoked ? 'revoked' : 'factory_failed' }
        }
        dispose = () => cleanup(value)
        if (state !== 'pending') {
          await clean()
          return { ok: false, reason: 'revoked' }
        }
        state = 'ready' // same reservation, no second charge
        return { ok: true, value }
      },
      close() {
        if (state === 'closed' || state === 'closing') return closed
        state = 'closing' // revoke publication before any awaited work
        if (!started) release()
        else if (dispose) void clean()
        // A pending factory reconciles through initialize. Never fake release.
        return closed
      },
    })
    live.add(lease) // synchronous reservation before caller can invoke factory
    return { ok: true, lease }
  }

  function shutdown(): AdmissionSnapshot & { complete: boolean } {
    accepting = false
    for (const lease of live) void lease.close()
    const counts = snapshot()
    // Nonblocking status: repeat after completions; never hide stalled cleanup.
    return { complete: counts.total === 0, ...counts }
  }

  return Object.freeze({ reserve, snapshot, shutdown })
}
