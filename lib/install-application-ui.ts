import { appManifests } from './installed-manifests'
import { installAppModules } from './app-modules'
import { installFileCategoryUi } from './app-file-category-ui'
import { rosterFileCategoryUi } from '../layers/sme-roster/lib/sme-roster/file-category-ui'

export function installApplicationUi(): void {
  installAppModules(appManifests)
  installFileCategoryUi([rosterFileCategoryUi])
}
