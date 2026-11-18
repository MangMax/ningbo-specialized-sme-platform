import core from './core/manifest'
import smeRoster from './sme-roster/manifest'

const appModules = [core, smeRoster] as const

export function getAppModules() {
  return appModules
}
