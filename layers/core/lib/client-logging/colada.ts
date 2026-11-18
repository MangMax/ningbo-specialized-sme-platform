import type { QueryCache, MutationCache } from '@pinia/colada'
import type { ClientPage } from './contract'
import { safeLibraryReporter, type ClientLibraryReporter } from './library-reporter'

/** Native Pinia action subscriptions, as used by Colada's installed query-hooks plugin. */
export function installColadaLogging(queryCache: QueryCache, mutationCache: MutationCache, report: ClientLibraryReporter, page: () => ClientPage): () => void {
  let active = true
  const latest = new WeakMap<object, object>()
  const emit = safeLibraryReporter(signal => { if (active) report(signal) })
  const capture = () => { try { const current = page(); return active && current !== 'logs' && current !== 'settings' } catch { return false } }
  const offQuery = queryCache.$onAction(({ name, args, after, onError }) => {
    // The log viewer/config is never an input to its own diagnostics. No keys/URLs inspected.
    if (!active) return
    if (name === 'cancel') { latest.delete(args[0]); return }
    if (name !== 'fetch' || !capture()) return
    const [entry] = args
    const owner = {}
    latest.set(entry, owner)
    after(state => {
      if (latest.get(entry) !== owner || state.status !== 'success') return
      emit('colada_query_success')
    })
    onError(error => {
      // Same native error identity guard as the official plugin: cancelled/replaced work is inert.
      if (latest.get(entry) !== owner || entry.state.value.status !== 'error' || entry.state.value.error !== error) return
      emit('colada_query_failure')
    })
  }, true)
  const offMutation = mutationCache.$onAction(({ name, after, onError }) => {
    if (name !== 'mutate' || !capture()) return
    after(() => emit('colada_mutation_success'))
    onError(() => emit('colada_mutation_failure'))
  }, true)
  return () => { active = false; offQuery(); offMutation() }
}
