// Business owners retain real child-process IPC without exercising the source Jiti launcher.
// Source entry and loader contracts remain in their dedicated owners.
import { vi } from 'vitest'

vi.mock('../../layers/sme-roster/server/utils/enterprise-read-worker-location', async () => {
  const { createEnterpriseReadProcess } = await import('../../layers/sme-roster/server/utils/enterprise-read-process')
  return { createEnterpriseWorker: () => createEnterpriseReadProcess(new URL('../../.output/server/enterprise-read-worker.mjs', import.meta.url)) }
})
