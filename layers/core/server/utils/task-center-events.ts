import pg from 'pg'
import { usePostgresJobsDb } from './postgres-jobs'

const channel = 'task_center_changed'

type Subscriber = (event: 'ready' | 'changed' | 'close') => void
type Listener = { client: pg.Client; subscribers: Set<Subscriber>; ready: boolean }

let listener: Listener | undefined
let closing: Promise<void> | undefined

function closeListener(current: Listener) {
  if (listener !== current) return
  listener = undefined
  const pending = current.client.end().catch(() => {})
  closing = Promise.all([closing, pending]).then(() => {})
  for (const subscriber of current.subscribers) subscriber('close')
  current.subscribers.clear()
  return closing
}

export async function closeTaskCenterEvents() {
  if (listener) closeListener(listener)
  await closing
}

async function listen(current: Listener) {
  try {
    await closing
    if (listener !== current) return
    await current.client.connect()
    const installation = await current.client.query(
      `SELECT 1 FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'business.job'::regclass
         AND tgname = $1 AND tgenabled IN ('O', 'A')`,
      [channel],
    )
    if (!installation.rowCount) throw new Error('Task center notification trigger is unavailable')
    await current.client.query(`LISTEN ${channel}`)
    if (listener !== current) return
    current.ready = true
    for (const subscriber of current.subscribers) subscriber('ready')
  } catch {
    await closeListener(current)
  }
}

export function subscribeTaskCenterEvents(subscriber: Subscriber) {
  if (!listener) {
    usePostgresJobsDb()
    const url = new URL(process.env.NUXT_POSTGRES_DIRECTORY_URL!)
    url.searchParams.delete('options')
    url.searchParams.set('application_name', 'task-center-events')
    const client = new pg.Client({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    })
    const current: Listener = { client, subscribers: new Set(), ready: false }
    listener = current
    client.on('error', () => void closeListener(current))
    client.on('end', () => void closeListener(current))
    client.on('notification', notice => {
      if (!current.ready || notice.channel !== channel) return
      for (const receive of current.subscribers) receive('changed')
    })
    void listen(current)
  }
  const current = listener
  current.subscribers.add(subscriber)
  if (current.ready) queueMicrotask(() => {
    if (current.subscribers.has(subscriber)) subscriber('ready')
  })
  return () => {
    current.subscribers.delete(subscriber)
    if (!current.subscribers.size) void closeListener(current)
  }
}
