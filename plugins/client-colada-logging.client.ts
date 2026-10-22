import { useQueryCache, useMutationCache } from '@pinia/colada'
import { clientPage } from '~~/lib/client-logging/contract'
import { installColadaLogging } from '~~/lib/client-logging/colada'

export default defineNuxtPlugin({
  name: 'client-colada-logging',
  dependsOn: ['Pinia Colada', 'client-errors'],
  setup(nuxtApp) {
    const dispose = installColadaLogging(useQueryCache(), useMutationCache(),
      nuxtApp.$clientErrors.reportLibrarySignal, () => clientPage(nuxtApp.$router.currentRoute.value.path))
    nuxtApp.vueApp.onUnmount(dispose)
    if (import.meta.hot) import.meta.hot.dispose(dispose)
  },
})
