import { clientPage, type ClientInteraction } from '~~/lib/client-logging/contract'
import { createClientErrorTransport } from '~~/lib/client-logging/transport'
import { clientLibraryReporterKey, type ClientLibraryReporter } from '~~/lib/client-logging/library-reporter'
import { installRouterLogging } from '~~/lib/client-logging/router'

export default defineNuxtPlugin({ name: 'client-errors', setup(nuxtApp) {
  const transport = createClientErrorTransport()
  // No error/message/reason/stack, URL, DOM node or arbitrary context is inspected.
  const page = () => clientPage(nuxtApp.$router.currentRoute.value.path)
  const reportLibrary: ClientLibraryReporter = signal => transport.reportLibrary(signal, page())
  nuxtApp.vueApp.provide(clientLibraryReporterKey, reportLibrary)
  const removeRouterHooks = installRouterLogging(nuxtApp.$router, reportLibrary)
  const scriptError = () => transport.report('script_error', page())
  const rejection = () => transport.report('unhandled_rejection', page())
  const online = () => { void transport.flush() }
  window.addEventListener('error', scriptError)
  window.addEventListener('unhandledrejection', rejection)
  window.addEventListener('online', online)
  const removeVueHook = nuxtApp.hook('vue:error', () => { transport.report('vue_error', page()) })
  const dispose = () => {
    window.removeEventListener('error', scriptError)
    window.removeEventListener('unhandledrejection', rejection)
    window.removeEventListener('online', online)
    removeVueHook()
    removeRouterHooks()
    transport.dispose()
  }
  nuxtApp.vueApp.onUnmount(dispose)
  if (import.meta.hot) import.meta.hot.dispose(dispose)
  // Deliberate opt-in seam for known interaction failures; no catch/toast sweep.
  return { provide: { clientErrors: {
    reportInteractionFailure: (interaction: ClientInteraction, relatedRequestId?: string) => transport.report('interaction_failure', page(), 'error', relatedRequestId, interaction),
    reportLibrarySignal: reportLibrary,
    status: transport.status,
  } } }
} })
