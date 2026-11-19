import core from '../layers/core/lib/core/manifest'
import roster from '../layers/sme-roster/manifest'

import { leadListsManifest } from '../layers/lead-lists/public'

export const appManifests = [core, roster, leadListsManifest] as const
