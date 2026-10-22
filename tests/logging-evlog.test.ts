import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appLog, applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../lib/logging'
it('routes standalone worker events through the real evlog pipeline with safe explicit context', async () => {
  const directory = mkdtempSync(join(tmpdir(),'evlog181-'))
  const previous = process.env.NUXT_LOG_DIR; process.env.NUXT_LOG_DIR = directory
  try {
    initializeWorkerLogging()
    appLog({ source:'worker',operation:'worker.fixture',outcome:'failure',error:new Error('PRIVATE181_ERROR /Users/private'), errorCode:'fixture_failure' }, { taskId:'task-181',requestId:'req-181',traceId:'trace-181' })
    await applicationLogs().flush()
    const { rows } = await applicationLogs().list({taskId:'task-181'})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({requestId:'req-181',traceId:'trace-181',level:'error',outcome:'failure'})
    const detail = await applicationLogs().detail(rows[0]!.id)
    expect(detail?.errorCode).toBe('fixture_failure')
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE181|\/Users\/|stack|message/)
  } finally {
    await closeApplicationLogging()
    if(previous===undefined) delete process.env.NUXT_LOG_DIR; else process.env.NUXT_LOG_DIR=previous
    rmSync(directory,{recursive:true,force:true})
  }
})
