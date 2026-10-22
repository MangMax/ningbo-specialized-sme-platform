import { isNavigationFailure, NavigationFailureType, type Router } from 'vue-router'
import { safeLibraryReporter, type ClientLibraryReporter } from './library-reporter'

export function installRouterLogging(router: Router, report: ClientLibraryReporter): () => void {
  let active = true
  const emit = safeLibraryReporter(signal => { if (active) report(signal) })
  const offAfter = router.afterEach((_to, _from, failure) => {
    if (!failure) emit('router_navigation_success')
    else if (isNavigationFailure(failure, NavigationFailureType.aborted)) emit('router_navigation_aborted')
    else if (isNavigationFailure(failure, NavigationFailureType.cancelled)) emit('router_navigation_cancelled')
    else if (isNavigationFailure(failure, NavigationFailureType.duplicated)) emit('router_navigation_duplicated')
    else emit('router_navigation_failure')
  })
  const offError = router.onError(() => emit('router_navigation_error'))
  return () => { active = false; offAfter(); offError() }
}
