import { defineEventHandler, sendNoContent, setResponseHeaders } from 'h3'
import { subscribeTaskCenterEvents } from '../../utils/task-center-events'
import { postgresJobStorageEnabled } from '../../utils/postgres-jobs'

defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '后台任务实时刷新通知',
    responses: {
      200: { description: 'text/event-stream，ready 表示监听已就绪，changed 表示需要重取任务快照。' },
      204: { description: 'SQLite 模式继续使用任务列表轮询。' },
    },
  },
})

export default defineEventHandler(event => {
  if (!postgresJobStorageEnabled()) {
    setResponseHeaders(event, { 'cache-control': 'no-store' })
    return sendNoContent(event)
  }

  const res = event.node.res
  function close() {
    clearInterval(heartbeat)
    res.off('close', close)
    unsubscribe()
    res.end()
  }
  function write(frame: string) {
    if (!res.write(frame)) {
      close()
      res.destroy()
    }
  }

  const unsubscribe = subscribeTaskCenterEvents(name => {
    if (name === 'close') close()
    else write(`event: ${name}\ndata:\n\n`)
  })
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000)
  res.once('close', close)
  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
  })
  write('retry: 3000\n\n')
})
