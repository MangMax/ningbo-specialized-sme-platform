import { defineTask, useRuntimeConfig } from 'nitropack/runtime'
import { dispatchScheduledJob } from './scheduled-jobs'

export default defineTask({
  async run({ name }) {
    return { result: await dispatchScheduledJob(name, useRuntimeConfig().filesDir) }
  },
})
