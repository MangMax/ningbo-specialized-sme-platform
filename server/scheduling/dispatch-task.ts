import { defineTask } from 'nitro/task'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { dispatchScheduledJob } from './scheduled-jobs'

export default defineTask({
  async run({ name }) {
    return { result: await dispatchScheduledJob(name, useRuntimeConfig().filesDir) }
  },
})
