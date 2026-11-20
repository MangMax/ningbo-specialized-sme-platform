import { useDb } from '@db'
import { postgresOnlyRuntime } from '../../../../db/runtime-mode'
import { readAnnualWriteScope } from '../utils/annual-correspondence-read'
import { initializeAnnualCorrespondenceRunner } from '../utils/jobs/annual-correspondence'

export default defineNitroPlugin(() => {
  if (!postgresOnlyRuntime()) initializeAnnualCorrespondenceRunner(useDb(), readAnnualWriteScope)
})
