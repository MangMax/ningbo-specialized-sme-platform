import { defineEventHandler } from 'h3'
import { subscribeTaskCenterEvents } from '../../utils/task-center-events'

defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '后台任务实时刷新通知',
    responses: {
      200: { description: 'text/event-stream，ready 表示监听已就绪，changed 表示需要重取任务快照。' },
    },
  },
})

export default defineEventHandler(() => {
  const encoder = new TextEncoder()
  let cleanup: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      function write(frame: string) {
        if ((controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(frame))
        else close()
      }
      function close() {
        cleanup?.()
        controller.close()
      }
      const unsubscribe = subscribeTaskCenterEvents(name => {
        if (name === 'close') close()
        else write(`event: ${name}\ndata:\n\n`)
      })
      const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000)
      cleanup = () => {
        clearInterval(heartbeat)
        unsubscribe()
        cleanup = undefined
      }
      write('retry: 3000\n\n')
    },
    cancel() { cleanup?.() },
  }, { highWaterMark: 16 })
  return new Response(body, { headers: {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
  } })
})
