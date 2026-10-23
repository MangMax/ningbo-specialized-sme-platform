import { useDb } from '@db'
import { readAnnualWriteScope } from '../utils/annual-correspondence-read'
import { initializeAnnualCorrespondenceRunner } from '../utils/jobs/annual-correspondence'

export default defineNitroPlugin(() => {
  initializeAnnualCorrespondenceRunner(useDb(), readAnnualWriteScope)
})
