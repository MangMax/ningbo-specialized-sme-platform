import { EventEmitter, getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEnterpriseReadExecutor, enterpriseReads } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { captureReaderError, restoreReaderError, type RecognitionReadInput } from '../../../layers/sme-roster/lib/roster/offmain-read-protocol'
import { createError, isError } from 'h3'

class Transport extends EventEmitter {
  sent: any[] = []
  postMessage(input: unknown) { this.sent.push(input) }
  ref() {} unref() {}
  terminate = vi.fn(async () => {})
  ready() { this.emit('message', { type: 'ready', heap: 1 }) }
  chunk(payload: unknown, id = this.sent.at(-1).id) { this.emit('message', { type: 'chunk', id, payload }) }
  end(bytes = 2, id = this.sent.at(-1).id) { this.emit('message', { type: 'result', id, metrics: { bytes, heap: 1, rss: 1 } }) }
}
const recognitionInput: RecognitionReadInput = { operation: 'recognitions', dbPath: '/synthetic/owner.db', owner: { dbPath: '/synthetic/owner.db', realpath: '/synthetic/owner.db', dev: 1, ino: 2 }, filter: {} }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function setup(maxPending?: number) {
  const worker = new Transport(), createWorker = vi.fn(() => worker)
  const executor = createEnterpriseReadExecutor({ createWorker, maxPending })
  cleanup.push(() => executor.close())
  return { worker, executor, createWorker }
}

describe.each(['recognitions', 'differences', 'summary'] as const)('%s original-reader policy', operation => {
const input = { ...recognitionInput, operation, ...(operation === 'summary' ? { options: { curatedPath: '/synthetic/curated.json', reconcilePath: '/synthetic/reconcile.json', showCurated: false, page: 1, pageSize: 25 } } : {}) }
const execute = (executor: ReturnType<typeof createEnterpriseReadExecutor>, value: typeof input, signal?: AbortSignal) => operation === 'recognitions'
  ? executor.recognitions({ ...value, operation: 'recognitions' }, signal)
  : operation === 'summary' ? executor.summary({ ...value, operation: 'summary', options: value.options! }, signal)
    : executor.differences({ ...value, operation: 'differences' }, signal)

it.each(['active','partial-chunk'])('new-consumer %s abort settles caller but holds the worker until its real terminal message', async stage => {
  const { worker, executor } = setup(), controller = new AbortController()
  const cancelled = execute(executor, input, controller.signal)
  worker.ready(); if(stage==='partial-chunk')worker.chunk(Buffer.from('partial'))
  const enterprise = executor.list('/synthetic/enterprise.db')
  controller.abort()
  expect(await cancelled).toEqual({ type: 'cancelled' })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(worker.terminate).not.toHaveBeenCalled()
  expect(worker.sent).toHaveLength(1)
  worker.chunk(Buffer.from('ignored')); worker.end(999)
  expect(worker.sent.map(x => x.operation)).toEqual([operation, 'list'])
  worker.chunk(Buffer.from('{"counts":{"total":7}}')); worker.end()
  expect(await enterprise).toEqual({ counts: { total: 7 } })
  // Late terminal messages cannot release the next active worker slot.
  const next = execute(executor, input), queued = execute(executor, input)
  worker.end(999, worker.sent[0].id)
  expect(worker.sent).toHaveLength(3)
  worker.chunk(Buffer.from('{}')); worker.end()
  expect(await next).toEqual({ type: 'complete', body: Buffer.from('{}') })
  worker.chunk(Buffer.from('{}')); worker.end()
  expect(await queued).toEqual({ type: 'complete', body: Buffer.from('{}') })
})

it('queued and pre-admission cancellation releases only its own metadata and never starts or rejects a new-consumer job', async () => {
  const { worker, executor } = setup(1), a = new AbortController(), b = new AbortController()
  a.abort()
  expect(await execute(executor, input, a.signal)).toEqual({ type: 'cancelled' })
  expect(worker.sent).toEqual([])
  const first = execute(executor, input); worker.ready()
  const queued = execute(executor, input, b.signal)
  expect(await execute(executor, input)).toEqual({ type: 'fallback' })
  b.abort(); expect(await queued).toEqual({ type: 'cancelled' })
  expect(getEventListeners(b.signal,'abort')).toHaveLength(0)
  const retained = execute(executor, input)
  worker.chunk(Buffer.from('{}')); worker.end(); await first
  worker.chunk(Buffer.from('{}')); worker.end(); await retained
  expect(worker.sent).toHaveLength(2)
})

it.each(['failure', 'exit', 'error', 'decode', 'truncated', 'send'] as const)('post-ready %s failure returns private fallback and drops partial bytes', async fault => {
  const { worker, executor } = setup()
  const start=executor.start(); worker.ready(); await start
  if (fault === 'send') worker.postMessage = () => { throw new Error('synthetic send failure') }
  const pending=execute(executor, input)
  if (fault !== 'send') {
    worker.chunk(Buffer.from('partial'))
    if (fault === 'failure') worker.emit('message', { type: 'failure', id: worker.sent[0].id, code: 'open_failed' })
    else if (fault === 'decode') worker.chunk('not a buffer')
    else if (fault === 'truncated') worker.end(1000)
    else worker.emit(fault, new Error('synthetic transport fault'))
  }
  expect(await pending).toEqual({ type: 'fallback' })
})

it('a child creation failure after successful readiness returns private fallback without changing the original ready promise',async()=>{
  const worker=new Transport();let starts=0
  const executor=createEnterpriseReadExecutor({createWorker:()=>{if(++starts===1)return worker;throw new Error('post-ready create failed')}})
  cleanup.push(()=>executor.close())
  const initial=executor.start();worker.ready();await initial
  worker.emit('exit',1);await Promise.resolve();await Promise.resolve()
  expect(await execute(executor, input)).toEqual({type:'fallback'})
  await expect(initial).resolves.toBeUndefined();expect(starts).toBe(2)
})

it('reader-boundary errors, including an unrepresentable error, are terminal and never infrastructure fallback', async () => {
  const { worker, executor } = setup()
  for (const error of [captureReaderError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })), undefined]) {
    const pending=execute(executor, input); worker.ready()
    worker.emit('message', { type: 'reader-error', id: worker.sent.at(-1).id, error })
    expect(await pending).toEqual({ type: 'reader-error', error })
  }
  expect(worker.sent).toHaveLength(2)
  const circular: any = {}; circular.self=circular
  expect(captureReaderError(Object.assign(new Error('unrepresentable'), { data: circular }))).toBeUndefined()
})

it('abort wins failure and close races, close is irreversible, and live closed requests get fallback', async () => {
  const { worker, executor, createWorker } = setup(), controller=new AbortController()
  const pending=execute(executor, input,controller.signal); worker.ready(); worker.chunk(Buffer.from('partial'))
  controller.abort(); worker.emit('exit', 1)
  expect(await pending).toEqual({ type: 'cancelled' })
  await executor.close()
  expect(await execute(executor, input)).toEqual({ type: 'fallback' })
  expect(await execute(executor, input,controller.signal)).toEqual({ type: 'cancelled' })
  await expect(executor.list('/synthetic/owner.db')).rejects.toMatchObject({ statusCode:503,code:'executor_closed' })
  await expect(executor.list('/synthetic/owner.db',{},controller.signal)).rejects.toMatchObject({statusCode:503,code:'executor_closed'})
  expect(createWorker).toHaveBeenCalledTimes(1)
})

it('existing enterprise active abort still kills the child and preserves queued new-consumer order on restart', async () => {
  const workers=[new Transport(),new Transport()], worker=workers[0]!, replacement=workers[1]!
  const executor=createEnterpriseReadExecutor({createWorker:()=>workers.shift()!}), controller=new AbortController()
  cleanup.push(()=>executor.close())
  const enterprise=executor.list('/synthetic/owner.db',{},controller.signal)
  const rejected=expect(enterprise).rejects.toMatchObject({ name:'AbortError',statusCode:499 })
  worker.ready()
  const recognition=execute(executor, input)
  controller.abort(); await rejected; await Promise.resolve(); await Promise.resolve()
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  replacement.ready(); replacement.chunk(Buffer.from('{}')); replacement.end()
  expect(await recognition).toEqual({ type:'complete',body:Buffer.from('{}') })
})

it('retained request metadata counts the active job and permits exactly the 64KiB boundary', async () => {
  const { worker, executor }=setup()
  const withText = (text: string) => operation === 'summary'
    ? { ...input, options: { ...input.options!, q: text } } : { ...input, filter: { title: [text] } }
  const overhead=Buffer.byteLength(JSON.stringify(withText('')))
  const sized = (bytes: number) => withText('x'.repeat(bytes-overhead))
  const admitted = sized(65536)
  expect(Buffer.byteLength(JSON.stringify(admitted))).toBe(65536)
  const pending=execute(executor, admitted); worker.ready()
  expect(await execute(executor, input)).toEqual({type:'fallback'})
  worker.chunk(Buffer.from('{}')); worker.end(); await pending
  expect(await execute(executor, sized(65537))).toEqual({type:'fallback'})
  const next=execute(executor, input); worker.chunk(Buffer.from('{}')); worker.end()
  expect(await next).toEqual({type:'complete',body:Buffer.from('{}')})
})

it('default shared child FIFO retains sixteen waiting jobs, enterprise busy stays 503 and new-consumer overflow is private fallback',async()=>{
  const {worker,executor}=setup(), first=execute(executor, input)
  worker.ready()
  const queued=Array.from({length:16},()=>execute(executor, input))
  expect(await execute(executor, input)).toEqual({type:'fallback'})
  await expect(executor.list('/synthetic/owner.db')).rejects.toMatchObject({statusCode:503,code:'enterprise_read_busy'})
  for(let n=0;n<17;n++){worker.chunk(Buffer.from('{}'));worker.end()}
  expect((await Promise.all([first,...queued])).every(x=>x.type==='complete')).toBe(true)
  expect(worker.sent).toHaveLength(17)
})

it('close settles live active and queued callers once, releases abort listeners, and never restarts cancelled draining work',async()=>{
  const {worker,executor,createWorker}=setup(),a=new AbortController(),b=new AbortController()
  const active=execute(executor, input,a.signal);worker.ready();worker.chunk(Buffer.from('partial'))
  const queued=execute(executor, input,b.signal)
  await executor.close()
  expect(await active).toEqual({type:'fallback'});expect(await queued).toEqual({type:'fallback'})
  expect(getEventListeners(a.signal,'abort')).toHaveLength(0);expect(getEventListeners(b.signal,'abort')).toHaveLength(0)
  a.abort();b.abort();worker.emit('exit',1)
  expect(createWorker).toHaveBeenCalledTimes(1);expect(worker.terminate).toHaveBeenCalledTimes(1)
})

it('finite error fields preserve ordinary provenance and marked H3 false, zero and null data without stack or cause', () => {
  for (const error of [new SyntaxError('bad JSON'),Object.assign(new Error('busy'),{code:'SQLITE_BUSY',status:409,statusText:'Conflict',data:{x:1},fatal:false,unhandled:true})]) {
    const captured=captureReaderError(error)!, restored=restoreReaderError(captured)
    expect(isError(restored)).toBe(false)
    for (const [key,value] of Object.entries(captured.fields)) expect((restored as any)[key]).toEqual(value)
    expect(captured).not.toHaveProperty('stack'); expect(captured.fields).not.toHaveProperty('cause')
  }
  for (const data of [false,0,null]) {
    const error=createError({statusCode:409,statusMessage:'Conflict'});error.data=data
    const restored=restoreReaderError(captureReaderError(error))
    expect(isError(restored)).toBe(true);expect((restored as any).data).toBe(data)
  }
})

it('initial global readiness rejection stays captured and prevents the recognition adapter from being reached', async()=>{
  const original=new Error('synthetic initial startup failure'), hooks:Record<string, (...args:any[])=>any>={}
  const start=vi.spyOn(enterpriseReads,'start').mockRejectedValue(original)
  vi.stubGlobal('defineNitroPlugin',(plugin:unknown)=>plugin)
  try {
    const plugin=(await import('../../../layers/sme-roster/server/plugins/enterprise-read')).default
    plugin({hooks:{hook:(name:string,handler:any)=>{hooks[name]=handler}}} as any)
    await expect(hooks.request!({})).rejects.toBe(original)
    start.mockResolvedValue()
    await expect(hooks.request!({})).rejects.toBe(original)
    expect(start).toHaveBeenCalledTimes(1)
  } finally {start.mockRestore();vi.unstubAllGlobals()}
})

})

it.each(['differences', 'summary'] as const)('cancelled %s partial output drains before recognition REST and enterprise work without freeing the active slot',async operation=>{
  const {worker,executor}=setup(), active=new AbortController(), queued=new AbortController()
  const submit = (signal: AbortSignal) => operation === 'summary'
    ? executor.summary({ ...recognitionInput, operation, options: { curatedPath: '/synthetic/c.json', reconcilePath: '/synthetic/r.json', showCurated: false, page: 1, pageSize: 25 } }, signal)
    : executor.differences({...recognitionInput,operation},signal)
  const rest=submit(active.signal)
  worker.ready();worker.chunk(Buffer.from('{"rows":['))
  const recognition=executor.recognitions(recognitionInput)
  const dropped=submit(queued.signal)
  const liveRest=executor.differences({...recognitionInput,operation:'differences'})
  const enterprise=executor.list('/synthetic/owner.db')
  queued.abort();expect(await dropped).toEqual({type:'cancelled'})
  active.abort();expect(await rest).toEqual({type:'cancelled'})
  expect(worker.sent.map(x=>x.operation)).toEqual([operation])
  expect(worker.terminate).not.toHaveBeenCalled()
  worker.chunk(Buffer.from('discarded trailing output'));worker.end(999)
  expect(worker.sent.map(x=>x.operation)).toEqual([operation,'recognitions'])
  worker.chunk(Buffer.from('{}'));worker.end()
  expect(await recognition).toEqual({type:'complete',body:Buffer.from('{}')})
  expect(worker.sent.map(x=>x.operation)).toEqual([operation,'recognitions','differences'])
  worker.chunk(Buffer.from('{}'));worker.end()
  expect(await liveRest).toEqual({type:'complete',body:Buffer.from('{}')})
  expect(worker.sent.map(x=>x.operation)).toEqual([operation,'recognitions','differences','list'])
  worker.chunk(Buffer.from('{"rows":[],"counts":{"total":0}}'));worker.end()
  expect(await enterprise).toEqual({rows:[],counts:{total:0}})
  expect(getEventListeners(active.signal,'abort')).toHaveLength(0)
  expect(getEventListeners(queued.signal,'abort')).toHaveLength(0)
})
