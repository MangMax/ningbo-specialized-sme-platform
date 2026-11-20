import { appManifests } from './installed-manifests'
import { installAppModules } from './app-modules'

export function installApplicationUi(): void {
  installAppModules(appManifests)
}
