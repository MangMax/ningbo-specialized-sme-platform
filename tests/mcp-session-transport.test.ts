/** #444 static preparation. No production admission implementation is imported.
 * Future execution requires ISSUE444_PHASE=control or baseline-red explicitly.
 * TODO cases are requirements awaiting the production seam, NOT passing tests.
 * The baseline RED demonstrates a vendor capability gap, not an adapter test.
 */
import { createHash } from 'node:crypto'
import { connect as connectSocket } from 'node:net'
import { fork, type ChildProcess } from 'node:child_process'
import { readFile, realpath, mkdtemp, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Independent expected values: never import implementation constants/builders.
const isPendingAdapterPhase = (value: string) => value === 'adapter'
const literalCases = [
  ['L_sessions', { ready: 63, closing: 1, request: 1 }, { status: 503, code: 'session_capacity' }],
  ['L_pending', { pending: 8, request: 1 }, { status: 503, code: 'session_pending_limit' }],
  ['L_rpc_session', { active: 4, request: 1 }, { status: 503, code: 'request_capacity' }],
  ['L_rpc_global', { active: 32, request: 1 }, { status: 503, code: 'request_capacity' }],
  ['L_control_session', { active: 2, request: 1 }, { status: 503, code: 'control_capacity' }],
  ['L_control_global', { active: 8, request: 1 }, { status: 503, code: 'control_capacity' }],
  ['L_body_slots', { reading: 40, request: 1 }, { status: 503 }],
  ['L_get_session', { streams: 1, request: 1 }, { status: 503 }],
  ['L_get_global', { streams: 8, request: 1 }, { status: 503 }],
  ['L_ids', { accepted: [255, 256, 257] }, { allowed: [true, true, false] }],
  ['L_idle', { elapsed: [299999, 300000, 300001] }, { expired: [false, true, true] }],
  ['L_absolute', { elapsed: [1799999, 1800000, 1800001], idleRefreshed: true }, { expired: [false, true, true] }],
  ['L_body_deadline', { elapsed: [4999, 5000, 5001] }, { expired: [false, true, true] }],
  ['L_init_bytes', { bytes: [16383, 16384, 16385] }, { allowed: [true, true, false] }],
  ['L_request_bytes', { bytes: [65535, 65536, 65537] }, { allowed: [true, true, false] }],
  ['L_id_utf8', { ids: ['a'.repeat(127), '😀'.repeat(32), '😀'.repeat(32) + 'a'] }, { allowed: [true, true, false] }],
  ['L_reason_bytes', { bytes: [1023, 1024, 1025] }, { allowed: [true, true, false] }],
  ['L_id_partition', { ids: [1, '1', -1, 0, '', null, 1.5, 9007199254740992] }, { allowedNonInit: [true, true, true, false, false, false, false, false] }],
  ['L_auth_headers', { headers: [undefined, '', 'Bearer', 'wrong', 'valid'] }, { classes: ['anonymous', 'invalid', 'invalid', 'invalid', 'authorized'] }],
  ['L_epoch_aba', { tokens: ['A', 'B', 'A'], epochs: [10, 11, 12] }, { oldSessionAccepted: [true, false, false] }],
] as const

describe('independent admission literals awaiting the S1 seam', () => {
  for (const [name] of literalCases) it.todo(name)
  for (const name of [
    'L_typed_ids_do_not_alias', 'L_initialize_zero_allowed_and_charged',
    'L_duplicate_id_rejected_without_aborting_original',
    'L_unknown_completed_cancel_no_growth_no_renewal',
    'L_wrong_identity_never_retires_owner', 'L_body_release_before_rpc_settle',
    'L_two_edge_release_and_generation_identity', 'L_revoked_late_init_never_published',
    'L_never_resolving_init_remains_bounded_closing',
    'L_framing_length_transfer_encoding_compression', 'L_error_envelope_no_credentials',
    'L_memory_cleanup_failure_not_hidden', 'L_unused_candidate_closed_only',
  ]) it.todo(name)
})

const signalCases = [
  'S_same_id_two_clients', 'S_shared_token_same_id', 'S_same_session_siblings',
  'S_cancel_queued', 'S_cancel_active_late_result', 'S_cancel_before_wrapper_listener',
  'S_repeat_late_unknown', 'S_typed_wire_ids', 'S_auth_rejection', 'S_anonymous_sid',
  'S_epoch_rotation', 'S_context_current', 'S_idle_absolute_ttl',
  'S_delete_disconnect', 'S_restart', 'S_init_late', 'S_capacity_control',
  'S_body_sdk', 'S_stream_storage_shutdown', 'S_credentials_absent', 'S_stateless_component',
] as const
for (const name of signalCases) it.todo(name)

const root = resolve(import.meta.dirname, '..')
const phase = process.env.ISSUE444_PHASE ?? ''
const enabled = phase === 'control' || phase === 'baseline-red'

// Only resolves this checkout. An outside symlink is rejected; no borrowed WT execution.
async function dependency(specifier: string, version: string) {
  const entry = await realpath(fileURLToPath(import.meta.resolve(specifier)))
  const installation = await realpath(join(root, 'node_modules'))
  if (!entry.startsWith(installation + '/')) throw new Error('INFRA: dependency outside assigned installation')
  let dir = dirname(entry)
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (pkg.version === version) return { entry, dir, version }
    } catch { /* continue to the owning package, never fabricate a module */ }
    const parent = dirname(dir)
    if (parent === dir || !parent.startsWith(installation)) throw new Error('INFRA: pinned package version not found')
    dir = parent
  }
}

// Real Nitro generates its own runtime/storage/context virtual modules.
// No fake useEvent/useNitroApp/storage facade; no provider source copy or rewrite.
async function prepareFixture(adapterMode = false, faultMode = false, rpcMode = false) {
  const toolkit = await dependency('@nuxtjs/mcp-toolkit', '0.24.2')
  const sdk = await dependency('@modelcontextprotocol/sdk/client/index.js', '1.32.1')
  const nitroPackage = await dependency('nitropack', '2.13.4')
  const directory = await mkdtemp(join(tmpdir(), 'issue444-nitro-'))
  const tk = join(toolkit.dir, 'dist/runtime/server/mcp')
  const provider = join(tk, 'providers/node.js')
  const factory = join(tk, 'utils.js')
  const files = { ...(adapterMode ? { admission: join(root, 'server/utils/mcp-session-admission.ts'), adapter: join(root, 'server/utils/mcp-session-transport.ts') } : {}), provider, factory, protocol: join(sdk.dir, 'dist/esm/shared/protocol.js'), transport: join(sdk.dir, 'dist/esm/server/webStandardStreamableHttp.js') }
  const bindings = await Promise.all(Object.entries(files).map(async ([name, path]) => ({ name, path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })))
  await writeFile(join(directory, 'binding.json'), JSON.stringify({ root, toolkit, sdk, nitroPackage, bindings }, null, 2))
  await writeFile(join(directory, 'package.json'), '{"type":"module","private":true}')
  await writeFile(join(directory, 'state.mjs'), `
export const owners = new Set();
let held = false, entered = 0, releases = [];
export function hold() { held = true; entered = 0; }
export async function gate() {
  if (!held) return;
  entered++;
  await new Promise(resolve => releases.push(resolve));
}
export function stats() { return { entered }; }
export function release() { held = false; for (const resolve of releases.splice(0)) resolve(); }
`)
  await writeFile(join(directory, 'route.mjs'), `
import { eventHandler } from 'h3';
import { createMcpServer } from ${JSON.stringify(factory)};
import nativeProvider from ${JSON.stringify(provider)};
import { owners, gate } from './state.mjs';
export default eventHandler(async event => {
  const candidate = await createMcpServer({ name:'issue444-fixture', version:'1',
    tools:[{name:'probe', description:'Local test only', handler:async () => ({content:[{type:'text',text:'probe-ready'}]})}],
    resources:[], prompts:[] }, event);
  // Baseline scheduling instrumentation uses the public connect method only.
  // It delays connection; it neither implements admission nor fabricates a signal.
  const connect = candidate.connect.bind(candidate);
  candidate.connect = async transport => { await gate(); return connect(transport); };
  try {
    return await nativeProvider(() => { owners.add(candidate); return candidate; }, event);
  } finally {
    if (candidate !== event.context._mcpServer) await candidate.close();
  }
});
`)
  if (adapterMode) await writeFile(join(directory,'ownership.mjs'), `
import { createSocketOwnership } from ${JSON.stringify(join(root,'server/utils/mcp-session-transport.ts'))};
const manager=createSocketOwnership();const handles=new WeakMap();const seen=new WeakSet();const events=[];
export function registerRequest(req,res) {
  const socket=req.socket;const marker=req.headers['x-fixture-marker']??req.url;
  if(!seen.has(socket)){seen.add(socket);socket.once('close',()=>{events.push({op:'socket-close',marker});manager.closed(socket)})}
  let handle;try{handle=manager.register(socket,()=>{events.push({op:'destroy',marker,owners:manager.snapshot(socket)});socket.destroy()})}catch{res.destroy();return false}
  handles.set(req,handle);events.push({op:'register',marker});
  req.once('end',()=>{events.push({op:'request-end',marker});handle.requestFinished()});
  req.once('close',()=>{events.push({op:'request-close',marker});handle.requestFinished()});
  res.once('finish',()=>{events.push({op:'response-finish',marker});handle.responseFinished()});
  res.once('close',()=>{events.push({op:'response-close',marker});handle.responseFinished()});
  return true;
}
export function ownershipFor(req){const handle=handles.get(req);if(!handle)throw new Error('missing listener ownership');return handle}
export function ownershipStats(){return events.slice()}
`)
  if (adapterMode) await writeFile(join(directory, 'adapter.mjs'), `
import { eventHandler, toWebHandler, sendWebResponse, getHeader, getRequestURL } from 'h3';
import { Readable } from 'node:stream';
import { useStorage, useNitroApp, useEvent } from 'nitropack/runtime';
import { toWebRequest } from ${JSON.stringify(join(tk, 'compat.js'))};
import { createMcpServer } from ${JSON.stringify(factory)};
import nativeProvider from ${JSON.stringify(provider)};
import { createSessionInitializationTransport } from ${JSON.stringify(join(root, 'server/utils/mcp-session-transport.ts'))};
import { gate } from './state.mjs';
import { ownershipFor } from './ownership.mjs';
${rpcMode ? "import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';" : ''}
let factories = 0, connects = 0, closes = 0, storageCleanups = 0;
const faultEvents = [];
const rpcEvents=[], completions=new Map(), releases=new Map(), traces=new WeakMap();
let traceSerial=0,lifeNow=0,lifeTimerId=0;
const lifeTimers=new Map(),connections=new Set();
const lifecycleClock={now:()=>lifeNow,setTimeout(fn,delay){const id=++lifeTimerId;lifeTimers.set(id,{at:lifeNow+delay,fn});return id},clearTimeout(id){lifeTimers.delete(id)}};
export function lifecycleStats(){return {...adapter.lifecycleSnapshot(),...adapter.snapshot(),requests:adapter.requestSnapshot()}}
export async function lifecycleAdvance(ms){lifeNow+=ms;for(const [id,t] of [...lifeTimers])if(t.at<=lifeNow){lifeTimers.delete(id);t.fn()}for(let i=0;i<20;i++)await Promise.resolve();return lifecycleStats()}
export function lifecycleShutdown(){return adapter.shutdown()}
export function standaloneClose(sid){for(const transport of connections)if(transport.sessionId===sid){transport.closeStandaloneSSEStream();return true}return false}
function traceEvent(trace,op){rpcEvents.push({op,trace:trace.trace,sid:trace.sid,id:trace.id,idType:typeof trace.id,method:trace.method,quota:adapter.requestSnapshot()})}
function traceSettled(trace,op){setImmediate(()=>traceEvent(trace,op))}
const rpcKey=(sid,id)=>sid+':'+typeof id+':'+String(id);
export function rpcStats(){return {events:rpcEvents.slice(),...adapter.requestSnapshot()}}
export function rpcRelease(label){const release=releases.get(label);if(release){releases.delete(label);release()}return true}

let authHeld=false,authEntered=0,authProviders=0;const authCalls=new WeakMap(),authReleases=[];
async function authGate(event){const n=(authCalls.get(event)??0)+1;authCalls.set(event,n);if(authHeld&&n===2){authEntered++;await new Promise(resolve=>authReleases.push(resolve))}}
let initReplyHeld=false;const initReplyReleases=[],initReplySids=[];
export function initControl(op){if(op==='authhold'){authHeld=true;authEntered=0;authProviders=0}if(op==='authrelease'){authHeld=false;for(const resolve of authReleases.splice(0))resolve()}if(op==='authstats')return {entered:authEntered,providers:authProviders};if(op==='hold'){initReplyHeld=true;initReplySids.length=0}if(op==='release'){initReplyHeld=false;for(const resolve of initReplyReleases.splice(0))resolve()}return {sids:initReplySids.slice()}}
const foreignOwned = [];
async function foreignSnapshot() {
  return Promise.all(foreignOwned.map(async entry => ({key:entry.key,value:await useStorage('mcp').getItem(entry.key)})));
}
export async function releaseForeign() {
  const before = await foreignSnapshot();
  if (JSON.stringify(before) !== JSON.stringify(foreignOwned)) throw new Error('foreign witness changed');
  const deletedKeys = [];
  for (const entry of foreignOwned) {
    await useStorage('mcp').removeItem(entry.key,{removeMeta:true});
    deletedKeys.push(entry.key);
  }
  const remaining = [];
  for (const entry of foreignOwned) if (await useStorage('mcp').hasItem(entry.key)) remaining.push(entry.key);
  return {before,deletedKeys,remaining};
}
const adapter = createSessionInitializationTransport({
  ${['get','ttl','init','auth'].includes(phase) ? 'lifecycleClock,' : ''}
  ${rpcMode ? `handlerFinished:(event,request)=>{
    if(request.method!=='tools/call'&&request.method!=='tools/list')throw new Error('unobserved handler');
    const key=rpcKey(request.sessionId,request.id);
    return new Promise(resolve=>completions.set(key,()=>{rpcEvents.push({op:'handler-finished',sid:request.sessionId,id:request.id,trace:traces.get(event)?.trace,quota:adapter.requestSnapshot()});completions.delete(key);resolve({finished:true});traceSettled(traces.get(event),'handler-reconciled')}));
  },` : ''}
  authenticate: async event => { if (useEvent() !== event) throw new Error('current event mismatch');await authGate(event); ${rpcMode ? "const auth=getHeader(event,'authorization');return auth==='Bearer fixture-A'?{kind:'authorized',principal:'A',epoch:1}:auth==='Bearer fixture-B'?{kind:'authorized',principal:'B',epoch:1}:{kind:'invalid'};" : "return getHeader(event,'authorization') !== undefined ? {kind:'invalid'} : {kind:'anonymous',epoch:1};"} },
  replay: async (event,request,run) => {
    const url = new URL(request.url); url.pathname = '/__replay';
    // Consume the validated replay once, then pass exactly those bytes to H3.
    const bytes=await request.arrayBuffer(),frame=JSON.parse(new TextDecoder().decode(bytes));
    const trace=traces.get(event);Object.assign(trace,{id:frame.id,method:frame.method});traceEvent(trace,'validated-frame');
    const replay = new Request(url,{method:request.method,headers:request.headers,body:bytes});
    return toWebHandler(useNitroApp().h3App)(replay,{issue444Replay:async current=>{
      traces.set(current,trace);const result=await run(current);
      trace.repoRefusal=!trace.providerCalled&&result.status>=400;
      return result;
    },issue444Marker:getHeader(event,'x-fixture-marker')});
  },
  factory: async event => {
    factories++;
    const owner = await createMcpServer({name:'adapter-fixture',version:'1',tools:[],resources:[],prompts:[]},event);
    ${rpcMode ? `// Local probe only: original toolkit factory/server and original SDK dispatcher.
    // Register a complete public request handler so its finally is a real receipt;
    // do not wrap just the business callback underneath toolkit async hooks.
    owner.server.setRequestHandler(ListToolsRequestSchema,async(request,extra)=>{
      const key=rpcKey(extra.sessionId,extra.requestId);
      rpcEvents.push({op:'list-entered',sid:extra.sessionId,id:extra.requestId,idType:typeof extra.requestId});
      try{return {tools:[{name:'probe',description:'Local test only',inputSchema:{type:'object',properties:{label:{type:'string'},mode:{type:'string'},payload:{type:'string'}},additionalProperties:true}}]}}
      finally{rpcEvents.push({op:'list-finally',sid:extra.sessionId,id:extra.requestId,idType:typeof extra.requestId});completions.get(key)?.()}
    });
    owner.server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
      const label=request.params.arguments?.label,mode=request.params.arguments?.mode;
      const event=useEvent();const key=rpcKey(extra.sessionId,extra.requestId);
      rpcEvents.push({op:'entered',sid:extra.sessionId,id:extra.requestId,label,mode,payloadLength:typeof request.params.arguments?.payload==='string'?request.params.arguments.payload.length:null,marker:getHeader(event,'x-fixture-marker')});
      let stage='entered';
      const abort=()=>rpcEvents.push({op:'signal-aborted',sid:extra.sessionId,id:extra.requestId,label,stage});
      extra.signal.addEventListener('abort',abort,{once:true});if(extra.signal.aborted)abort();
      try {
        if(mode==='waiting') {
          stage='waiting-before-business';rpcEvents.push({op:'business-wait',sid:extra.sessionId,id:extra.requestId,label,stage});
          await new Promise(resolve=>releases.set(label,resolve));
          if(extra.signal.aborted) {
            stage='skipped-before-business';rpcEvents.push({op:'business-skipped',sid:extra.sessionId,id:extra.requestId,label,stage});
            rpcEvents.push({op:'business-result',sid:extra.sessionId,id:extra.requestId,label,aborted:true,executed:false});
            return {content:[]};
          }
        }
        stage='executing-business';rpcEvents.push({op:'business-start',sid:extra.sessionId,id:extra.requestId,label,stage});
        if(mode!=='immediate'&&mode!=='waiting')await new Promise(resolve=>releases.set(label,resolve));
        rpcEvents.push({op:'business-result',sid:extra.sessionId,id:extra.requestId,label,aborted:extra.signal.aborted,executed:true});
        return {content:[{type:'text',text:'done:'+label}]};
      }finally{rpcEvents.push({op:'handler-finally',sid:extra.sessionId,id:extra.requestId,label,stage,aborted:extra.signal.aborted});extra.signal.removeEventListener('abort',abort);completions.get(key)?.()}
    });` : ''}
    const connect = owner.connect.bind(owner), close = owner.close.bind(owner);
    owner.connect = async transport => {
      connects++;connections.add(transport);
      const standalone=transport.closeStandaloneSSEStream.bind(transport);
      transport.closeStandaloneSSEStream=()=>{rpcEvents.push({op:'standalone-close',sid:transport.sessionId});return standalone()};
      const transportClose=transport.close.bind(transport);
      transport.close=async()=>{rpcEvents.push({op:'transport-close-attempt',sid:transport.sessionId});try{return await transportClose()}finally{connections.delete(transport)}};
      ${faultMode ? "const onclose = transport.onclose; transport.onclose = () => { faultEvents.push({op:'transport-close',sid:transport.sessionId}); onclose?.(); };" : ''}
      // Chain the provider's original hook before public Server.connect wraps it.
      const priorOnclose=transport.onclose;
      transport.onclose=(...args)=>{rpcEvents.push({op:'transport-onclose-event',sid:transport.sessionId});return priorOnclose?.apply(transport,args)};
      await gate(); return connect(transport);
    };
    owner.close = async () => { closes++;rpcEvents.push({op:'owner-close',sid:owner.server.transport?.sessionId});await close(); };
    return owner;
  },
  provider: async (factory,event) => {authProviders++;const trace=traces.get(event);if(trace)trace.providerCalled=true;const response=await (${faultMode ? `async (factory, event) => {
    const response = await nativeProvider(factory,event);
    if (event.web.request.method === 'POST' && !event.web.request.headers.has('mcp-session-id')) {
      const sid = response.headers.get('mcp-session-id');
      if (!response.ok || !sid) throw new Error('FAULT_GUARD: no actual allocation');
      const targetKeys = [];
      for (const namespace of ['sessions','sessions-meta']) {
        const base = namespace + ':' + sid;
        await useStorage('mcp').setItem(base,'target-parent'); targetKeys.push(base);
        await useStorage('mcp:' + base).setItem('child','target-child'); targetKeys.push(base + ':child');
        await useStorage('mcp:' + base).setItem('nested/leaf','target-nested'); targetKeys.push(base + ':nested:leaf');
      }
      for (const foreignSid of ['foreign-owner',sid + '-neighbor']) {
        for (const namespace of ['sessions','sessions-meta']) {
          for (const suffix of ['',':child']) {
            const key = namespace + ':' + foreignSid + suffix;
            const value = 'foreign-exact-value:' + key;
            await useStorage('mcp').setItem(key,value); foreignOwned.push({key,value});
          }
        }
      }
      faultEvents.push({op:'allocated-then-throw',sid,targetKeys,targetBefore:await Promise.all(targetKeys.map(async key => ({key,value:await useStorage('mcp').getItem(key)}))),foreignBefore:await foreignSnapshot()});
      throw new Error('injected post-allocation failure');
    }
    return response;
  }` : 'nativeProvider'})(factory,event);if(initReplyHeld&&!event.web.request.headers.has('mcp-session-id')&&response.ok){initReplySids.push(response.headers.get('mcp-session-id'));await new Promise(resolve=>initReplyReleases.push(resolve))}return response;},
  adopted: event => event.context._mcpServer,
  cleanupSession: async sid => {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(sid)) throw new Error('noncanonical sid');
    const parent = useStorage('mcp'), removedKeys = [], relativeKeys = [], targetRemaining = [];
    for (const namespace of ['sessions','sessions-meta']) {
      const base = namespace + ':' + sid, scoped = useStorage('mcp:' + base);
      const keys = (await scoped.getKeys()).sort(); relativeKeys.push(keys);
      // getKeys excludes the exact base key; remove it via the parent mount.
      if (await parent.hasItem(base)) { await parent.removeItem(base,{removeMeta:true}); removedKeys.push(base); }
      for (const key of keys) {
        await scoped.removeItem(key,{removeMeta:true}); removedKeys.push(base + ':' + key);
      }
      if (await parent.hasItem(base)) targetRemaining.push(base);
      for (const key of await scoped.getKeys()) targetRemaining.push(base + ':' + key);
    }
    const empty = targetRemaining.length === 0;
    const receipt = {empty:true};
    ${faultMode ? "faultEvents.push({op:'storage-cleaned',sid,empty,removedKeys,relativeKeys,targetRemaining,foreignAfter:await foreignSnapshot(),beforeReceipt:adapter.snapshot(),receipt:empty ? receipt : null});" : ''}
    if (!empty) throw new Error('storage not empty');
    rpcEvents.push({op:'storage-verified',sid,removedKeys,targetRemaining,receipt});
    storageCleanups++;
    return receipt;
  },
});
export function adapterStats() { return {factories,connects,closes,storageCleanups,...adapter.snapshot()${faultMode ? ",faultEvents" : ''}}; }
const ingressEvidence = [];
export function ingressStats() { return {slots:adapter.bodySnapshot(),events:ingressEvidence}; }
export function adapterShutdown() { return adapter.shutdown(); }
export const replayHandler = eventHandler(event => {
  if (typeof event.context.issue444Replay !== 'function') return new Response(null,{status:404});
  if (useEvent() !== event) throw new Error('replay current event mismatch');
  return event.context.issue444Replay(event);
});
export default eventHandler(async event => {
  const req = event.node.req, socket = req.socket;
  const record = {marker:getHeader(event,'x-fixture-marker'),terminated:0,serverClosed:false,before:null,after:null};
  ingressEvidence.push(record);
  const trace={trace:++traceSerial,sid:getHeader(event,'mcp-session-id')??null,method:req.method,providerCalled:false,repoRefusal:false};traces.set(event,trace);
  const ownership=ownershipFor(req);

  const rawHeaders=[];for(let i=0;i<req.rawHeaders.length;i+=2)rawHeaders.push([req.rawHeaders[i],req.rawHeaders[i+1]]);
  const headers = new Headers();for(const [k,v] of rawHeaders)headers.append(k,v);
  const responseFinished=new Promise(resolve=>{for(const op of ['finish','close'])event.node.res.once(op,()=>{traceEvent(trace,'response-'+op);resolve({finished:true});traceSettled(trace,'response-'+op+'-reconciled')})});
  const response = await adapter.handle(event,{responseFinished,method:req.method,url:getRequestURL(event).href,headers,rawHeaders,
    body:req.method==='POST'?Readable.toWeb(req):null,
    get closed(){return ownership.closed.then(receipt=>{record.serverClosed=true;return receipt})},
    subscribeClosed:listener=>ownership.subscribeClosed(()=>{record.serverClosed=true;listener()}),
    terminate() {record.terminated++;record.before=adapter.bodySnapshot();ownership.terminate();},
  });
  record.after=adapter.bodySnapshot();traceEvent(trace,'dispatch-return');
  // Only independently identified repository refusals; never buffer provider SSE/binary.
  const res=event.node.res;
  if((record.terminated===1 || trace.repoRefusal || (!trace.providerCalled&&response.status>=400&&req.method!=='POST')) && !socket.destroyed && !res.destroyed) {
    const state=()=>({socketNull:res.socket===null,writableEnded:res.writableEnded,writableFinished:res.writableFinished});
    const allowed={400:['invalid_body','invalid_framing','invalid_request_id','invalid_control','invalid_rpc'],401:['invalid_identity'],404:['session_not_found'],405:['stream_not_supported','method_not_supported'],408:['body_timeout'],409:['duplicate_request_id','session_closing','stream_already_active'],413:['body_too_large'],501:['handler_receipt_unavailable'],503:['request_capacity','control_capacity','request_id_capacity','pending_capacity','session_capacity','stream_capacity','initialization_revoked','disconnect_observer_required','disconnect_observer_failed']};
    if(!allowed[response.status] || response.bodyUsed || res.writableEnded) throw new Error('unsafe queued error response');
    const responseHeaders=[...response.headers];
    if(responseHeaders.length!==1 || responseHeaders[0][0]!=='content-type' || responseHeaders[0][1]!=='application/json') throw new Error('unexpected queued error headers');
    // Producer is refusal() without provider dispatch, or an owned body refusal (<256 bytes),
    // not an arbitrary provider Response. Read it once; do not clone a tee.
    const bytes=Buffer.from(await response.arrayBuffer());
    const value=JSON.parse(bytes.toString('utf8'));const code=value.error?.data?.code;
    const exact=JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:code,data:{code}}});
    if(bytes.length>256 || !allowed[response.status].includes(code) || !bytes.equals(Buffer.from(exact))) throw new Error('unexpected queued error bytes');
    if(socket.destroyed || res.destroyed) return;
    if(res.writableEnded) throw new Error('duplicate response end');
    record.queued={status:response.status,body:bytes.toString('utf8'),bytes:bytes.length,bodyUsed:response.bodyUsed,before:state(),endCalls:0};
    res.once('finish',()=>{record.queued.finish=state()});
    res.statusCode=response.status;
    for(const [key,value] of responseHeaders)res.setHeader(key,value);
    res.setHeader('Content-Length',String(bytes.length));
    record.queued.endCalls++;res.end(bytes);record.queued.after=state();
    return;
  }

  if(req.method==='GET' && response.status===200) {
    // Public H3 streaming path; flush only headers, never buffer a normal SSE body.
    const sending=sendWebResponse(event,response);if(res.socket)res.flushHeaders();return sending;
  }
  // Capacity rejection never transferred ownership to the component.
  if(response.status===503 && (await response.clone().json()).error?.data?.code==='body_capacity') {ownership.terminate();}
  return response;
});
`)
  await writeFile(join(directory, 'entry.mjs'), `
import { toNodeListener } from 'h3';
import { useNitroApp, useStorage } from 'nitropack/runtime';
import { owners, hold, stats, release } from './state.mjs';
${adapterMode ? "import { adapterStats, adapterShutdown, releaseForeign, ingressStats, rpcStats, rpcRelease, lifecycleStats, lifecycleAdvance, lifecycleShutdown, standaloneClose, initControl } from './adapter.mjs'; export { adapterStats, releaseForeign, ingressStats, rpcStats, rpcRelease, lifecycleStats, lifecycleAdvance, lifecycleShutdown, standaloneClose, initControl };" : ''}
${adapterMode ? "export { registerRequest, ownershipStats } from './ownership.mjs';" : ''}
export const listener = toNodeListener(useNitroApp().h3App);
export { hold, stats, release };
export async function dispose() {
  release();
  ${adapterMode ? "const adapterClose = adapterShutdown(); if (!adapterClose.complete) throw new Error('adapter cleanup incomplete');" : ''}
  for (const owner of owners) await owner.close();
  owners.clear();
  ${faultMode ? '// Fault mode never sweeps storage; final assertion sees any unexplained residual.' : "await useStorage('mcp:sessions').clear(); await useStorage('mcp:sessions-meta').clear();"}
  await useNitroApp().hooks.callHook('close');
  return { storageEmpty: (await useStorage('mcp').getKeys()).length === 0 };
}
`)
  await writeFile(join(directory, 'bootstrap.mjs'), `
import { createServer } from 'node:http';
import { listener, hold, stats, release, dispose${adapterMode ? ', adapterStats, releaseForeign, ingressStats, registerRequest, ownershipStats, rpcStats, rpcRelease, lifecycleStats, lifecycleAdvance, lifecycleShutdown, standaloneClose, initControl' : ''} } from './output/server/index.mjs';
const holds=new Map();
const server = createServer((req,res)=>{
  ${adapterMode ? "if(!registerRequest(req,res))return;" : ''}
  if(req.url==='/hold') {
    const marker=req.headers['x-fixture-marker'];const text='FULL-'+marker+'-BODY';
    req.resume();res.writeHead(200,{'Content-Length':Buffer.byteLength(text),'Content-Type':'text/plain'});res.write('FULL-');
    holds.set(marker,()=>{res.end(text.slice(5));holds.delete(marker)});return;
  }
  listener(req,res);
});
server.listen(0, '127.0.0.1', () => process.send({ready:true,port:server.address().port}));
process.on('message', async ({id,op}) => {
  // No unhandledRejection handler and no global timer patch.
  ${adapterMode ? "if(op.startsWith('init:'))process.send({id,value:initControl(op.slice(5))});if(op==='lifecycleStats')process.send({id,value:lifecycleStats()});if(op==='lifecycleShutdown')process.send({id,value:lifecycleShutdown()});if(op.startsWith('advance:'))process.send({id,value:await lifecycleAdvance(Number(op.slice(8)))});if(op.startsWith('standalone:'))process.send({id,value:standaloneClose(op.slice(11))});if(op==='rpcStats')process.send({id,value:rpcStats()});if(op.startsWith('rpc-release:'))process.send({id,value:rpcRelease(op.slice(12))});" : ''}
  if (op.startsWith('finish-')) {holds.get(op.slice(7))?.();process.send({id,value:true});}
  ${adapterMode ? "if(op==='ownershipStats')process.send({id,value:ownershipStats()});" : ''}
  if (op === 'hold') { hold(); process.send({id,value:true}); }
  if (op === 'stats') process.send({id,value:stats()});
  ${adapterMode ? "if (op === 'ingressStats') process.send({id,value:ingressStats()}); if (op === 'adapterStats') process.send({id,value:adapterStats()}); if (op === 'releaseForeign') process.send({id,value:await releaseForeign()});" : ''}
  if (op === 'release') { release(); process.send({id,value:true}); }
  if (op === 'shutdown') {
    const result = await dispose();
    server.close(() => { process.send({id,value:result}, () => process.disconnect()); });
    server.closeIdleConnections();
  }
});
`)
  if (adapterMode) await writeFile(join(directory,'replay.mjs'), "export { replayHandler as default } from './adapter.mjs'")
  const { createNitro, prepare, build } = await import('nitropack')
  const nitro = await createNitro({
    rootDir: directory, srcDir: directory, scanDirs: [], preset: 'node-listener',
    entry: join(directory, 'entry.mjs'), buildDir: join(directory, 'build'),
    output: { dir: join(directory, 'output'), serverDir: join(directory, 'output/server') },
    nodeModulesDirs: [join(root, 'node_modules')],
    // Toolkit runtime contains virtual imports; bundle its original source so
    // Nitro resolves them rather than leaving an unresolved external package.
    externals: { inline: [tk] },
    handlers: [{ route: '/mcp', handler: join(directory, 'route.mjs') }, ...(adapterMode ? [{ route: '/adapter', handler: join(directory, 'adapter.mjs') }, {route:'/__replay',handler:join(directory,'replay.mjs')}] : [])],
    experimental: { asyncContext: true },
    storage: { mcp: { driver: 'memory' } },
    virtual: {
      '#nuxt-mcp-toolkit/config.mjs': 'export default {sessions:{enabled:true,maxSessions:64,maxDuration:300000},security:{}}',
      '#nuxt-mcp-toolkit/transport.mjs': `export {default} from ${JSON.stringify(provider)}`,
    },
  })
  try { await prepare(nitro); await build(nitro) }
  finally { await nitro.close() }
  return directory
}

let child: ChildProcess | undefined
let directory: string | undefined
let endpoint = ''
let controlSucceeded = false
let sequence = 0
const clients: Array<{ close(): Promise<void>; transport: { terminateSession(): Promise<void> } }> = []
function command(op: string): Promise<any> {
  const id = ++sequence
  return new Promise((resolveCommand, reject) => {
    const timer = setTimeout(() => { child?.off('message', receive); reject(new Error('INFRA: IPC deadline')) }, 10000)
    function receive(message: any) {
      if (message?.id !== id) return
      clearTimeout(timer); child?.off('message', receive); resolveCommand(message.value)
    }
    child!.on('message', receive); child!.send({ id, op })
  })
}
async function newClient() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'issue444-client', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint))
  clients.push({ close: () => client.close(), transport })
  await client.connect(transport)
  return client
}

describe.skipIf(!enabled)('real Nitro source fixture control and vendor baseline', () => {
  beforeAll(async () => {
    directory = await prepareFixture()
    child = fork(join(directory, 'bootstrap.mjs'), [], { cwd: directory, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--unhandled-rejections=strict'] })
    endpoint = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('INFRA: fixture startup deadline')), 15000)
      child!.once('error', reject)
      child!.once('exit', () => { clearTimeout(timer); reject(new Error('INFRA: fixture exited before ready')) })
      child!.on('message', (message: any) => {
        if (message?.ready) { clearTimeout(timer); resolveReady(`http://127.0.0.1:${message.port}/mcp`) }
      })
    })
    // Control runs even when selecting only G_: no missing-import RED allowed.
    const client = await newClient()
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['probe'])
    expect(await client.callTool({ name: 'probe', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'probe-ready' }] })
    await clients[0]!.transport.terminateSession()
    await clients[0]!.close()
    clients.splice(0, 1)
    controlSucceeded = true
  }, 180000)

  it('C_real_import_initialize_listTools', () => { expect(controlSucceeded).toBe(true) })

  it.skipIf(phase !== 'baseline-red')('G_native_baseline_missing_pending_admission', async () => {
    expect(controlSucceeded, 'INFRA control must precede behavioral RED').toBe(true)
    await command('hold')
    const attempts = Array.from({ length: 9 }, () => newClient().then(() => 'connected', () => 'rejected'))
    try {
      await expect.poll(async () => (await command('stats')).entered, { timeout: 5000 }).toBe(9)
      // Guard proves nine independent initializations reached the REAL provider.
      // Intentional baseline RED: vendor has no pending<=8 reservation.
      expect((await command('stats')).entered).toBeLessThanOrEqual(8)
    } finally {
      await command('release')
      await Promise.all(attempts)
    }
  }, 60000)

  afterAll(async () => {
    if (!child) return
    try {
      const cleanup = await Promise.allSettled(clients.map(async client => {
        try { await client.transport.terminateSession() }
        finally { await client.close() }
      }))
      clients.length = 0
      const exited = new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('CLEANUP: vendor interval did not exit within observation window')), 61000)
        child!.once('exit', (code, signal) => {
          clearTimeout(timer)
          if (code !== 0 || signal) reject(new Error('CLEANUP: abnormal fixture exit'))
          else resolveExit()
        })
      })
      // Observe immediately even if shutdown IPC fails first; never hide its failure.
      const exitResult = exited.then(() => null, error => error as Error)
      const result = await command('shutdown')
      expect(result.storageEmpty).toBe(true)
      const exitError = await exitResult
      if (exitError) throw exitError
      const failures = cleanup.filter(result => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'CLEANUP: client failures')
    } finally {
      // Emergency reclamation never converts cleanup failure into product success.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 90000)
})

// Actual admission component tests; original vendor characterization above is retained.
import { createSessionAdmission } from '../server/utils/mcp-session-admission'

function admissionDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function admissionLease(admission: ReturnType<typeof createSessionAdmission>) {
  const result = admission.reserve()
  if (!result.ok) throw new Error('test reservation unexpectedly rejected')
  return result.lease
}

describe('A_actual_session_admission', () => {
  it('A_pending_7_8_9_no_ninth_factory', async () => {
    const a = createSessionAdmission()
    const gates = Array.from({ length: 8 }, () => admissionDeferred<number>())
    let factories = 0
    const starts: Promise<unknown>[] = []
    for (let i = 0; i < 7; i++) starts.push(admissionLease(a).initialize(() => { factories++; return gates[i]!.promise }, async () => {}))
    expect(a.snapshot()).toEqual({ pending: 7, ready: 0, closing: 0, total: 7, accepting: true })
    starts.push(admissionLease(a).initialize(() => { factories++; return gates[7]!.promise }, async () => {}))
    expect(a.snapshot().pending).toBe(8)
    const ninth = a.reserve()
    if (ninth.ok) starts.push(ninth.lease.initialize(async () => { factories++; return 9 }, async () => {}))
    expect(ninth).toEqual({ ok: false, reason: 'pending_capacity' })
    expect(factories).toBe(8)
    expect(a.snapshot().total).toBe(8)
    gates.forEach((gate, i) => gate.resolve(i))
    await Promise.all(starts)
    expect(a.snapshot()).toEqual({ pending: 0, ready: 8, closing: 0, total: 8, accepting: true })
    expect(a.shutdown().complete).toBe(false)
    await Promise.resolve(); await Promise.resolve()
    expect(a.shutdown().complete).toBe(true)
  })

  it('A_total_63_64_65_includes_closing', async () => {
    const a = createSessionAdmission()
    const release = admissionDeferred<void>()
    const leases = []
    for (let i = 0; i < 63; i++) {
      const lease = admissionLease(a); leases.push(lease)
      expect(await lease.initialize(async () => i, () => release.promise)).toEqual({ ok: true, value: i })
    }
    expect(a.snapshot()).toEqual({ pending: 0, ready: 63, closing: 0, total: 63, accepting: true })
    const last = admissionLease(a); leases.push(last)
    expect(a.snapshot().total).toBe(64)
    expect(a.reserve()).toEqual({ ok: false, reason: 'session_capacity' })
    const closing = leases[0]!.close()
    expect(a.snapshot()).toEqual({ pending: 1, ready: 62, closing: 1, total: 64, accepting: true })
    expect(a.reserve()).toEqual({ ok: false, reason: 'session_capacity' })
    release.resolve()
    await closing
    expect(a.snapshot().total).toBe(63)
    const replacement = admissionLease(a)
    expect(a.snapshot().total).toBe(64)
    await replacement.close()
    await Promise.all(leases.map(lease => lease.close()))
    expect(a.snapshot().total).toBe(0)
  })

  it('A_close_unstarted_closed_and_single_initialize', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a)
    const first = lease.close()
    expect(lease.close()).toBe(first)
    expect(await first).toEqual({ complete: true })
    let calls = 0
    expect(await lease.initialize(async () => { calls++; return 1 }, async () => {})).toEqual({ ok: false, reason: 'lease_unavailable' })
    expect(calls).toBe(0)
    expect(lease.state()).toBe('closed')
    expect(a.snapshot().total).toBe(0)
    const next = admissionLease(a)
    expect(next.generation > lease.generation).toBe(true)
    expect(await next.initialize(async () => 2, async () => {})).toEqual({ ok: true, value: 2 })
    expect(await next.initialize(async () => { calls++; return 3 }, async () => {})).toEqual({ ok: false, reason: 'lease_unavailable' })
    expect(calls).toBe(0)
    expect(a.snapshot().total).toBe(1)
    await next.close()
  })

  it('A_revoke_pending_late_resolve_never_publishes', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a)
    const factory = admissionDeferred<object>(); const cleanup = admissionDeferred<void>()
    const value = { private: 'credential-event' }; let cleaned: unknown; let cleanCalls = 0
    const start = lease.initialize(() => factory.promise, resource => { cleaned = resource; cleanCalls++; return cleanup.promise })
    const close = lease.close()
    expect(lease.close()).toBe(close)
    expect(a.snapshot()).toEqual({ pending: 0, ready: 0, closing: 1, total: 1, accepting: true })
    factory.resolve(value)
    await Promise.resolve()
    expect(cleaned).toBe(value); expect(cleanCalls).toBe(1)
    expect(lease.state()).toBe('closing')
    cleanup.resolve()
    expect(await start).toEqual({ ok: false, reason: 'revoked' })
    expect(await close).toEqual({ complete: true })
    expect(a.snapshot().total).toBe(0)
    expect(await lease.close()).toEqual({ complete: true })
    expect(cleanCalls).toBe(1)
  })

  it('A_late_factory_reject_and_pending_reject_release', async () => {
    const a = createSessionAdmission()
    for (const revoke of [false, true]) {
      const lease = admissionLease(a); const gate = admissionDeferred<number>(); let cleans = 0
      const start = lease.initialize(() => gate.promise, async () => { cleans++ })
      if (revoke) lease.close()
      gate.reject(new Error('Bearer secret-token'))
      expect(await start).toEqual({ ok: false, reason: revoke ? 'revoked' : 'factory_failed' })
      expect(await lease.close()).toEqual({ complete: true })
      expect(cleans).toBe(0); expect(a.snapshot().total).toBe(0)
    }
    const lease = admissionLease(a)
    expect(await lease.initialize(() => { throw new Error('secret-sync') }, async () => {})).toEqual({ ok: false, reason: 'factory_failed' })
    expect(a.snapshot().total).toBe(0)
  })

  it('A_ready_duplicate_close_isolation_and_no_result_cache', async () => {
    const a = createSessionAdmission(); const first = admissionLease(a); const second = admissionLease(a)
    const gate = admissionDeferred<void>(); let cleans = 0
    await first.initialize(async () => 'one', () => { cleans++; return gate.promise })
    await second.initialize(async () => 'two', async () => {})
    const closing = first.close()
    expect(first.close()).toBe(closing); expect(cleans).toBe(1)
    expect(second.state()).toBe('ready')
    expect(a.snapshot()).toEqual({ pending: 0, ready: 1, closing: 1, total: 2, accepting: true })
    gate.resolve(); await closing
    expect(await first.initialize(async () => 'stale', async () => {})).toEqual({ ok: false, reason: 'lease_unavailable' })
    expect(a.snapshot().total).toBe(1)
    await second.close(); await first.close()
    expect(cleans).toBe(1); expect(a.snapshot().total).toBe(0)
  })

  it('A_cleanup_reject_retains_charge_and_safe_errors', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a); let cleans = 0
    await lease.initialize(async () => ({ token: 'Bearer private-event' }), () => { cleans++; throw new Error('Bearer private-event') })
    const close = lease.close()
    expect(await close).toEqual({ complete: false, reason: 'cleanup_failed' })
    expect(lease.close()).toBe(close); expect(cleans).toBe(1)
    expect(lease.state()).toBe('closing')
    expect(a.shutdown()).toEqual({ complete: false, pending: 0, ready: 0, closing: 1, total: 1, accepting: false })
    expect(a.reserve()).toEqual({ ok: false, reason: 'shutdown' })
    expect(JSON.stringify([a.snapshot(), await close])).not.toContain('private-event')
    expect(JSON.stringify(a.snapshot())).not.toContain('token')
  })

  it('A_never_factory_and_cleanup_bounded_shutdown', async () => {
    const a = createSessionAdmission(); const pending = admissionLease(a); const ready = admissionLease(a)
    const never = admissionDeferred<number>(); const neverClean = admissionDeferred<void>()
    void pending.initialize(() => never.promise, async () => {})
    await ready.initialize(async () => 1, () => neverClean.promise)
    const shutdown = a.shutdown()
    expect(shutdown).toEqual({ complete: false, pending: 0, ready: 0, closing: 2, total: 2, accepting: false })
    expect(a.shutdown()).toEqual(shutdown)
    expect(a.reserve()).toEqual({ ok: false, reason: 'shutdown' })
    expect(pending.state()).toBe('closing'); expect(ready.state()).toBe('closing')
    // Controlled promises intentionally remain unresolved; no timer/network handles.
  })

  it('A_shutdown_empty_unstarted_and_closed_is_idempotent', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a)
    expect(a.shutdown()).toEqual({ complete: true, pending: 0, ready: 0, closing: 0, total: 0, accepting: false })
    expect(await lease.close()).toEqual({ complete: true })
    expect(a.shutdown().complete).toBe(true)
    expect(a.reserve()).toEqual({ ok: false, reason: 'shutdown' })
  })
})

describe('A_actual_session_admission', () => {
  it('A_revoked_late_cleanup_reject_stays_charged', async () => {
    const a = createSessionAdmission(); const lease = admissionLease(a)
    const factory = admissionDeferred<number>(); let cleans = 0
    const start = lease.initialize(() => factory.promise, async () => { cleans++; throw new Error('private-late-token') })
    const close = lease.close()
    factory.resolve(1)
    expect(await start).toEqual({ ok: false, reason: 'revoked' })
    expect(await close).toEqual({ complete: false, reason: 'cleanup_failed' })
    expect(lease.close()).toBe(close); expect(cleans).toBe(1)
    expect(a.snapshot()).toEqual({ pending: 0, ready: 0, closing: 1, total: 1, accepting: true })
    expect(a.shutdown().complete).toBe(false)
  })

  it('A_never_resolving_revocations_cannot_escape_total_bound', () => {
    const a = createSessionAdmission()
    const never = admissionDeferred<number>()
    for (let i = 0; i < 64; i++) {
      const lease = admissionLease(a)
      void lease.initialize(() => never.promise, async () => {})
      void lease.close()
    }
    expect(a.snapshot()).toEqual({ pending: 0, ready: 0, closing: 64, total: 64, accepting: true })
    expect(a.reserve()).toEqual({ ok: false, reason: 'session_capacity' })
    expect(a.shutdown()).toEqual({ complete: false, pending: 0, ready: 0, closing: 64, total: 64, accepting: false })
  })
})

import { createSessionInitializationTransport as createActualSessionInitializationTransport, type InitializationDependencies, type SessionOwner, type OwnedIngress } from '../server/utils/mcp-session-transport'

function controlledPeer() {
  const receipt=admissionDeferred<{closed:true}>(),listeners=new Set<()=>void>();let ended=false
  return {closed:receipt.promise,subscribeClosed(listener:()=>void){if(ended){listener();return ()=>{}}listeners.add(listener);return ()=>{listeners.delete(listener)}},
    close(){if(ended)return;ended=true;receipt.resolve({closed:true});for(const listener of [...listeners])listener();listeners.clear()},observerCount:()=>listeners.size}
}

// Controlled pure-test input adapter. Never used by the real Nitro fixture.
function createSessionInitializationTransport<E, O extends SessionOwner>(deps: Omit<InitializationDependencies<E, O>, 'replay'>) {
  const adapter = createActualSessionInitializationTransport({ ...deps, replay: async (event, _request, run) => run(event) })
  return { ...adapter, async handle(event: E, request: Request) {
    const bytes = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : null
    const headers = new Headers(request.headers)
    if (bytes) headers.set('content-length', String(bytes.length))
    const input: OwnedIngress = { method: request.method, url: request.url, headers, rawHeaders: [...headers],
      body: bytes ? new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }) : null,
      ...controlledPeer(), responseFinished: Promise.resolve({finished:true}), terminate() {},
    }
    return adapter.handle(event, input)
  } }
}

describe.skipIf(!['adapter','body','shared','rpc','quota','get','ttl','restart','init','auth'].includes(phase))('T_actual_transport_initialization', () => {
  const evidence: Record<string, any> = { mode: 'real-adapter', clients: [] }
  beforeAll(async () => {
    directory = await prepareFixture(true,false,['rpc','quota','get','ttl','restart','init','auth'].includes(phase))
    child = fork(join(directory, 'bootstrap.mjs'), [], { cwd: directory, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--unhandled-rejections=strict'] })
    endpoint = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('INFRA: fixture startup deadline')), 15000)
      child!.once('error', reject)
      child!.once('exit', () => { clearTimeout(timer); reject(new Error('INFRA: fixture exited before ready')) })
      child!.on('message', (message: any) => {
        if (message?.ready) { clearTimeout(timer); resolveReady(`http://127.0.0.1:${message.port}/mcp`) }
      })
    })
    const client = await newClient()
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['probe'])
    expect(await client.callTool({ name: 'probe', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'probe-ready' }] })
    await clients[0]!.transport.terminateSession()
    await clients[0]!.close()
    clients.splice(0, 1)
    controlSucceeded = true
    evidence.originalControl = { initialize: true, listTools: true, callTool: true, delete: true, close: true }
  }, 180000)

  it.skipIf(!['body','shared'].includes(phase))('B_real_slow_and_oversize_owned_socket_close', async () => {
    expect(controlSucceeded).toBe(true)
    const baseline = await command('adapterStats')
    const attempts: any[] = []
    for (const [marker,length,payload] of [['slow',100,'{'],['oversize',16385,'x'.repeat(16385)]] as const) {
      const started=Date.now(); const record:any={marker};attempts.push(record)
      await new Promise<void>((resolvePeer,reject)=>{
        const url=new URL(endpoint);const socket=connectSocket(Number(url.port),'127.0.0.1')
        const timer=setTimeout(()=>{socket.destroy();reject(new Error('peer close missing'))},8000)
        socket.on('connect',()=>socket.write('POST /adapter HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: '+length+'\r\nX-Fixture-Marker: '+marker+'\r\nConnection: keep-alive\r\n\r\n'+payload))
        socket.on('data',data=>{record.response=(record.response??'')+data.toString()})
        socket.on('end',()=>{record.eof=true})
        socket.on('error',error=>{record.error=(error as NodeJS.ErrnoException).code})
        socket.on('close',hadError=>{clearTimeout(timer);record.close={hadError,elapsed:Date.now()-started};resolvePeer()})
      })
      if(marker==='slow')expect(record.close.elapsed).toBeGreaterThanOrEqual(5000)
      const stats=await command('ingressStats');const own=stats.events.find((entry:any)=>entry.marker===marker)
      expect(own).toMatchObject({terminated:1,serverClosed:true,before:{reading:0,closing:1,total:1},after:{reading:0,closing:0,total:0}})
      expect(stats.slots).toEqual({reading:0,closing:0,total:0})
      expect((await command('adapterStats')).factories).toBe(baseline.factories)
      record.server=own
    }
    evidence.body=attempts
  },25000)

  it.skipIf(phase !== 'shared')('W_real_pipeline_dynamic_owners_and_independent_session', async()=>{
    expect(controlSucceeded).toBe(true)
    const baseline=await command('adapterStats');const independent=await newClient()
    const records:any[]=[];evidence.shared=records
    try {
      for(const kind of ['slow','oversize']) {
        const marker='shared-'+kind,prior=marker+'-prior',later=marker+'-later'
        const record:any={kind,wire:'',closed:false};records.push(record)
        const url=new URL(endpoint);const socket=connectSocket(Number(url.port),'127.0.0.1')
        const ended=new Promise<void>(resolve=>{socket.on('close',hadError=>{record.closed=true;record.hadError=hadError;resolve()})})
        socket.on('data',data=>{record.wire+=data.toString()});socket.on('error',error=>{record.error=(error as NodeJS.ErrnoException).code})
        await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
        const get=(name:string)=>'GET /hold HTTP/1.1\r\nHost: localhost\r\nX-Fixture-Marker: '+name+'\r\n\r\n'
        const length=kind==='slow'?100:16385
        socket.write(get(prior)+'POST /adapter HTTP/1.1\r\nHost: localhost\r\nContent-Length: '+length+'\r\nX-Fixture-Marker: '+marker+'\r\n\r\n'+(kind==='slow'?'{':'x'.repeat(length)))
        try {
          await expect.poll(async()=>{const stats=await command('ingressStats');return stats.events.find((x:any)=>x.marker===marker)?.after},{timeout:7500}).toEqual({reading:0,closing:1,total:1})
          expect(record.closed).toBe(false);expect(record.wire).not.toContain('FULL-'+prior+'-BODY')
          expect((await command('adapterStats')).factories).toBe(baseline.factories)
          expect((await independent.listTools()).tools.map(tool=>tool.name)).toEqual(['probe'])
          // New owner joins AFTER termination request, before prior completes.
          socket.write((kind==='slow'?' '.repeat(99):'')+get(later))
          await expect.poll(async()=> (await command('ownershipStats')).some((x:any)=>x.op==='register'&&x.marker===later)).toBe(true)
          await command('finish-'+prior)
          await expect.poll(()=>record.wire.includes('FULL-'+prior+'-BODY')).toBe(true)
          expect(record.closed).toBe(false)
          const during=await command('ownershipStats');expect(during.some((x:any)=>x.op==='response-finish'&&x.marker===prior)).toBe(true)
          expect((await command('ingressStats')).slots).toEqual({reading:0,closing:1,total:1})
          expect(await independent.callTool({name:'probe',arguments:{}})).toMatchObject({content:[{type:'text',text:'probe-ready'}]})
          record.beforeLaterFinish=during
          await command('finish-'+later)
          await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>reject(new Error('owned socket did not close')),3000))])
          expect(record.wire).toContain('FULL-'+later+'-BODY')
          await expect.poll(async()=> (await command('ingressStats')).slots).toEqual({reading:0,closing:0,total:0})
          record.after=await command('ownershipStats');record.ingress=await command('ingressStats')
          expect(record.after.some((x:any)=>x.op==='response-finish'&&x.marker===later)).toBe(true)
          const own=record.ingress.events.find((x:any)=>x.marker===marker)
          const expectedCode=kind==='slow'?'body_timeout':'body_too_large',expectedStatus=kind==='slow'?408:413
          const expectedBody=JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:expectedCode,data:{code:expectedCode}}})
          expect(own.queued).toMatchObject({status:expectedStatus,body:expectedBody,bytes:Buffer.byteLength(expectedBody),bodyUsed:true,endCalls:1,
            before:{socketNull:true,writableEnded:false,writableFinished:false},after:{writableEnded:true,writableFinished:false},finish:{writableEnded:true,writableFinished:true}})
          expect(record.wire).toMatch(new RegExp('HTTP/1\\.1 '+expectedStatus+' '))
          expect(record.wire.toLowerCase()).toContain('content-length: '+Buffer.byteLength(expectedBody)+'\r\n')
          expect(record.wire).toContain('\r\n\r\n'+expectedBody)
          expect(record.wire.indexOf('FULL-'+prior+'-BODY')).toBeLessThan(record.wire.indexOf(expectedBody))
          expect(record.wire.indexOf(expectedBody)).toBeLessThan(record.wire.indexOf('FULL-'+later+'-BODY'))
          const order=record.after.filter((x:any)=>[prior,marker,later].includes(x.marker))
          const finished=(name:string)=>order.findIndex((x:any)=>x.op==='response-finish'&&x.marker===name)
          const destroyed=order.findIndex((x:any)=>x.op==='destroy')
          expect(finished(prior)).toBeGreaterThanOrEqual(0);expect(finished(marker)).toBeGreaterThan(finished(prior));expect(finished(later)).toBeGreaterThan(finished(marker));expect(destroyed).toBeGreaterThan(finished(later))
          expect(own.serverClosed).toBe(true);expect(record.testEmergencyDestroy).toBeUndefined()
          record.responseOrder=order
          expect((await command('adapterStats')).factories).toBe(baseline.factories)
        } finally {if(!record.closed){record.testEmergencyDestroy=true;socket.destroy()} await command('finish-'+prior);await command('finish-'+later)}
      }
    } finally {await clients[clients.length-1]!.transport.terminateSession();await independent.close();clients.pop()}
  },30000)

  it.skipIf(phase !== 'shared')('W_node_parser_rejects_duplicate_cl_and_cl_te',async()=>{
    const attempts:any[]=[];evidence.parser=attempts
    for(const [name,headers] of [['duplicate','Content-Length: 1\r\nContent-Length: 1'],['clte','Content-Length: 1\r\nTransfer-Encoding: chunked']]) {
      const before=(await command('adapterStats')).factories;const url=new URL(endpoint);const record:any={name,wire:''};attempts.push(record)
      await new Promise<void>((resolve,reject)=>{
        const socket=connectSocket(Number(url.port),'127.0.0.1');const timer=setTimeout(()=>{socket.destroy();reject(new Error('parser close missing'))},3000)
        socket.on('connect',()=>socket.write('POST /adapter HTTP/1.1\r\nHost: localhost\r\n'+headers+'\r\nX-Fixture-Marker: parser-'+name+'\r\n\r\nx'))
        socket.on('data',data=>{record.wire+=data.toString()});socket.on('error',error=>{record.error=(error as NodeJS.ErrnoException).code})
        socket.on('close',()=>{clearTimeout(timer);resolve()})
      })
      expect(record.wire).toContain('400 Bad Request');expect((await command('ownershipStats')).some((x:any)=>x.marker==='parser-'+name)).toBe(false);expect((await command('adapterStats')).factories).toBe(before)
    }
  })

  it.skipIf(phase!=='rpc')('X_real_sdk_signal_quota_identity_and_late_cleanup',async()=>{
    expect(controlSucceeded).toBe(true)
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js')
    const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const http:any[]=[], made:any[]=[], pending:any[]=[];evidence.rpc={http}
    const make=async(name:string)=>{
      const client=new Client({name,version:'1'});const transport=new StreamableHTTPClientTransport(new URL(endpoint.replace('/mcp','/adapter')),{requestInit:{headers:{authorization:'Bearer fixture-A','x-fixture-marker':name}},fetch:async(input,init)=>{
        const frame=typeof init?.body==='string'?JSON.parse(init.body):undefined;const response=await fetch(input,init)
        http.push({name,method:init?.method,frame,status:response.status});return response
      }})
      await client.connect(transport);expect(transport.sessionId).toBeTypeOf('string');expect(transport.sessionId).not.toBe('');made.push({client,transport});return {client,transport}
    }
    const a=await make('A'),b=await make('B')
    const start=(owner:any,label:string,mode='active')=>{
      const abort=new AbortController();const result=owner.client.callTool({name:'probe',arguments:{label,mode}},undefined,{signal:abort.signal,timeout:20000}).then((value:any)=>({ok:true,value}),(error:any)=>({ok:false,message:String(error)}))
      const row={owner,label,abort,result};pending.push(row);return row
    }
    const a1=start(a,'a1'),b1=start(b,'b1'),a2=start(a,'a2','waiting'),a3=start(a,'a3'),a4=start(a,'a4')
    try {
      await expect.poll(async()=> (await command('rpcStats')).events.filter((x:any)=>x.op==='entered').length).toBe(5)
      const initial=await command('rpcStats');evidence.rpc.initial=initial
      const entered=(label:string)=>initial.events.find((x:any)=>x.op==='entered'&&x.label===label)
      expect(entered('a1').id).toBe(entered('b1').id);expect(entered('a1').sid).not.toBe(entered('b1').sid)
      expect(initial).toMatchObject({ordinary:5,control:0});expect(entered('a1').marker).toBe('A');expect(entered('b1').marker).toBe('B')
      expect(initial.events.some((x:any)=>x.op==='business-start'&&x.label==='a1')).toBe(true)
      expect(initial.events.some((x:any)=>x.op==='business-wait'&&x.label==='a2')).toBe(true)
      expect(initial.events.some((x:any)=>x.op==='business-start'&&x.label==='a2')).toBe(false)
      const excess=start(a,'excess');expect((await excess.result).ok).toBe(false)
      expect(http.some(x=>x.name==='A'&&x.status===503&&x.frame?.params?.arguments?.label==='excess')).toBe(true)
      const cancellationSid=a.transport.sessionId
      if(typeof cancellationSid!=='string'||cancellationSid.length===0)throw new Error('missing initialized cancellation session')
      const raw=async(token:string,requestId:any)=>{
        const response=await fetch(endpoint.replace('/mcp','/adapter'),{method:'POST',headers:{authorization:token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':cancellationSid},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId}})})
        const body=await response.text();http.push({raw:true,requestId,status:response.status,body});return response.status
      }
      expect(await raw('Bearer fixture-B',entered('a1').id)).toBe(404)
      expect((await command('rpcStats')).events.some((x:any)=>x.op==='signal-aborted')).toBe(false)
      a1.abort.abort('fixture-cancel');a2.abort.abort('fixture-wait-cancel')
      await expect.poll(async()=> (await command('rpcStats')).events.filter((x:any)=>x.op==='signal-aborted').length).toBe(2)
      const signalled=await command('rpcStats');evidence.rpc.signalled=signalled
      expect(signalled.events.filter((x:any)=>x.op==='signal-aborted').map((x:any)=>x.label).sort()).toEqual(['a1','a2'])
      expect(signalled.ordinary).toBe(5) // abort/response close is not handler completion
      expect(signalled.events.find((x:any)=>x.op==='signal-aborted'&&x.label==='a1').stage).toBe('executing-business')
      expect(signalled.events.find((x:any)=>x.op==='signal-aborted'&&x.label==='a2').stage).toBe('waiting-before-business')
      expect(signalled.events.some((x:any)=>x.op==='handler-finally'&&['a1','a2'].includes(x.label))).toBe(false)
      expect(await raw('Bearer fixture-A',entered('a1').id)).toBe(202);expect(await raw('Bearer fixture-A',99999)).toBe(202)
      await command('rpc-release:a1');await command('rpc-release:a2')
      await expect.poll(async()=> (await command('rpcStats')).ordinary).toBe(3)
      expect(await raw('Bearer fixture-A',entered('a1').id)).toBe(202)
      for(const label of ['b1','a3','a4'])await command('rpc-release:'+label)
      expect((await b1.result).ok).toBe(true);expect((await a3.result).ok).toBe(true);expect((await a4.result).ok).toBe(true)
      expect((await a1.result).ok).toBe(false);expect((await a2.result).ok).toBe(false)
      await expect.poll(async()=> (await command('rpcStats')).ordinary).toBe(0)
      evidence.rpc.final=await command('rpcStats')
      for(const row of initial.events.filter((x:any)=>x.op==='entered')){
        const events=evidence.rpc.final.events.filter((x:any)=>x.sid===row.sid&&typeof x.id===typeof row.id&&x.id===row.id)
        expect(events.some((x:any)=>x.op==='handler-finished')).toBe(true)
        expect(events.some((x:any)=>x.op==='response-finish'||x.op==='response-close')).toBe(true)
        expect(events.some((x:any)=>x.op==='response-finish-reconciled'||x.op==='response-close-reconciled')).toBe(true)
      }
      expect(evidence.rpc.final.events.filter((x:any)=>x.op==='signal-aborted').length).toBe(2)
      expect(evidence.rpc.final.events.filter((x:any)=>x.op==='business-result'&&x.aborted).map((x:any)=>x.label).sort()).toEqual(['a1','a2'])
      expect(evidence.rpc.final.events.some((x:any)=>x.op==='business-start'&&x.label==='a2')).toBe(false)
      expect(evidence.rpc.final.events.find((x:any)=>x.op==='business-result'&&x.label==='a2').executed).toBe(false)
      expect(evidence.rpc.final.events.filter((x:any)=>x.op==='handler-finally'&&x.aborted).map((x:any)=>x.label).sort()).toEqual(['a1','a2'])
    } finally {
      for(const row of pending)await command('rpc-release:'+row.label)
      await Promise.all(pending.map(row=>row.result))
      for(const owner of made){await owner.transport.terminateSession();await owner.client.close()}
      evidence.rpc.cleanup=await command('rpcStats')
    }
  },60000)

  it.skipIf(phase!=='quota')('Y_real_global_rpc_control_and_raw_typed_boundaries',async()=>{
    expect(controlSucceeded).toBe(true)
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const made:any[]=[],calls:any[]=[],pipes:any[]=[];const audit:any={http:[]};evidence.quota=audit
    const url=endpoint.replace('/mcp','/adapter')
    const post=async(sid:string,message:any)=>{const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer fixture-A','content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':sid},body:JSON.stringify(message)});const body=await response.text();audit.http.push({raw:true,sid,id:message.id,method:message.method,status:response.status,body});return response.status}
    try {
      for(let i=0;i<9;i++){
        const client=new Client({name:'global-'+i,version:'1'}),transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:'Bearer fixture-A','x-fixture-marker':'global-'+i}},fetch:async(input,init)=>{const response=await fetch(input,init);if(response.status===503)audit.http.push({client:i,status:response.status,body:await response.clone().text()});return response}})
        await client.connect(transport);expect(transport.sessionId).toBeTypeOf('string');expect(transport.sessionId).not.toBe('');expect(made.some(owner=>owner.transport.sessionId===transport.sessionId)).toBe(false);made.push({client,transport})
      }
      for(let i=0;i<8;i++)for(let j=0;j<4;j++){const label='global-'+i+'-'+j;const result=made[i].client.callTool({name:'probe',arguments:{label}},undefined,{timeout:25000}).then((value:any)=>({ok:true,value}),(error:any)=>({ok:false,message:String(error)}));calls.push({label,result})}
      await expect.poll(async()=>(await command('rpcStats')).ordinary).toBe(32)
      const denied=await made[8].client.callTool({name:'probe',arguments:{label:'global-excess'}},undefined,{timeout:5000}).then(()=>false,()=>true);expect(denied).toBe(true)
      expect(audit.http.find((x:any)=>x.client===8)).toMatchObject({status:503,body:JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:'request_capacity',data:{code:'request_capacity'}}})})
      expect((await command('rpcStats')).events.some((x:any)=>x.label==='global-excess')).toBe(false)
      const cancel={jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:99999}}
      for(let i=0;i<4;i++){
        const marker='control-prior-'+i,parsed=new URL(url),socket=connectSocket(Number(parsed.port),'127.0.0.1'),record:any={marker,wire:'',closed:false};pipes.push({socket,record})
        socket.on('data',data=>{record.wire+=data.toString()});socket.on('close',()=>{record.closed=true});socket.on('error',error=>{record.error=(error as NodeJS.ErrnoException).code})
        await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
        const body=JSON.stringify(cancel),frame='POST /adapter HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer fixture-A\r\nContent-Type: application/json\r\nMcp-Session-Id: '+made[i].transport.sessionId+'\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body
        socket.write('GET /hold HTTP/1.1\r\nHost: localhost\r\nX-Fixture-Marker: '+marker+'\r\n\r\n'+frame+frame)
      }
      await expect.poll(async()=>(await command('rpcStats')).control).toBe(8)
      audit.held=await command('rpcStats');expect(audit.held.ordinary).toBe(32)
      const deleteFull=await fetch(url,{method:'DELETE',headers:{authorization:'Bearer fixture-A','mcp-session-id':made[0].transport.sessionId}});
      audit.deleteFull={status:deleteFull.status,body:await deleteFull.text()};expect(audit.deleteFull.status).toBe(503);expect(JSON.parse(audit.deleteFull.body).error.data.code).toBe('control_capacity')
      expect((await command('adapterStats')).ready).toBe(9)
      expect(audit.held.distinctIds).toBe(41) // initialize9 + ordinary32; unknown cancel adds none
      expect(await post(made[0].transport.sessionId,cancel)).toBe(503)
      expect(await post(made[4].transport.sessionId,cancel)).toBe(503)
      for(const pipe of pipes)await command('finish-'+pipe.record.marker)
      await expect.poll(async()=>(await command('rpcStats')).control).toBe(0)
      for(const pipe of pipes){await expect.poll(()=> (pipe.record.wire.match(/202 Accepted/g)??[]).length).toBe(2);pipe.socket.end();await expect.poll(()=>pipe.record.closed).toBe(true)}
      audit.controls=pipes.map(p=>p.record)
      for(const call of calls)await command('rpc-release:'+call.label)
      for(const call of calls)expect((await call.result).ok).toBe(true)
      await expect.poll(async()=>(await command('rpcStats')).ordinary).toBe(0)
      const stillUsable=await made[0].client.callTool({name:'probe',arguments:{label:'after-delete-denied',mode:'immediate'}});expect(stillUsable.content).toEqual([{type:'text',text:'done:after-delete-denied'}])
      const sid=made[0].transport.sessionId
      for(const [id,status] of [[1,409],['1',200],[0,400],['',400]] as const)expect(await post(sid,{jsonrpc:'2.0',id,method:'tools/call',params:{name:'probe',arguments:{label:'raw-'+String(id),mode:'immediate'}}})).toBe(status)
      const get=await fetch(url,{headers:{authorization:'Bearer fixture-A','mcp-session-id':sid}});expect(get.status).toBe(409);await get.text() // Client already owns its GET stream
      audit.final=await command('rpcStats')
    } finally {
      for(const pipe of pipes){await command('finish-'+pipe.record.marker);if(!pipe.record.closed){pipe.record.emergencyDestroy=true;pipe.socket.destroy()}}
      for(const call of calls)await command('rpc-release:'+call.label)
      await Promise.all(calls.map(c=>c.result))
      for(const owner of made){await owner.transport.terminateSession();await owner.client.close()}
      audit.cleanup=await command('rpcStats')
    }
    expect(pipes.some(p=>p.record.emergencyDestroy)).toBe(false)
  },75000)


  it.skipIf(phase!=='quota')('Z_real_shared_refusals_and_64KiB_network',async()=>{
    expect(controlSucceeded).toBe(true)
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const url=endpoint.replace('/mcp','/adapter'),client=new Client({name:'boundary',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:'Bearer fixture-A'}}})
    await client.connect(transport);expect(transport.sessionId).toBeTypeOf('string');expect(transport.sessionId).not.toBe('')
    const sid=transport.sessionId!,audit:any={pipes:[],boundaries:[]},calls:any[]=[];evidence.boundary=audit
    const frame=(id:any,label:string,payload='')=>({jsonrpc:'2.0',id,method:'tools/call',params:{name:'probe',arguments:{label,mode:'immediate',payload}}})
    const pipe=async(body:string,marker:string,status:number,code:string,terminated=false)=>{
      const prior=marker+'-prior',later=marker+'-later',socket=connectSocket(Number(new URL(url).port),'127.0.0.1'),record:any={marker,wire:'',closed:false};audit.pipes.push(record)
      socket.on('data',data=>{record.wire+=data.toString()});socket.on('close',()=>{record.closed=true});socket.on('error',error=>{record.error=(error as NodeJS.ErrnoException).code})
      await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
      const get=(name:string)=>'GET /hold HTTP/1.1\r\nHost: localhost\r\nX-Fixture-Marker: '+name+'\r\n\r\n'
      try {
        socket.write(get(prior)+'POST /adapter HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer fixture-A\r\nMcp-Session-Id: '+sid+'\r\nContent-Type: application/json\r\nContent-Length: '+Buffer.byteLength(body)+'\r\nX-Fixture-Marker: '+marker+'\r\n\r\n'+body)
        await expect.poll(async()=> (await command('ingressStats')).events.find((x:any)=>x.marker===marker)?.queued?.endCalls).toBe(1)
        expect(record.closed).toBe(false)
        // Join after refusal was queued: ownership is dynamically checked, not cached.
        socket.write(get(later));await expect.poll(async()=> (await command('ownershipStats')).some((x:any)=>x.op==='register'&&x.marker===later)).toBe(true)
        await command('finish-'+prior)
        const expected=JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:code,data:{code}}})
        await expect.poll(()=>record.wire.includes(expected)).toBe(true);expect(record.closed).toBe(false)
        expect(record.wire).toContain('HTTP/1.1 '+status+' ');expect(record.wire.toLowerCase()).toContain('content-length: '+Buffer.byteLength(expected)+'\r\n')
        await command('finish-'+later);await expect.poll(()=>record.wire.includes('FULL-'+later+'-BODY')).toBe(true)
        if(!terminated)socket.end()
        await expect.poll(()=>record.closed).toBe(true)
        record.ownership=await command('ownershipStats');record.ingress=(await command('ingressStats')).events.find((x:any)=>x.marker===marker)
        expect(record.ingress.queued).toMatchObject({status,body:expected,endCalls:1,finish:{writableFinished:true}})
        expect(record.wire).toContain('FULL-'+prior+'-BODY');expect(record.wire.indexOf('FULL-'+prior+'-BODY')).toBeLessThan(record.wire.indexOf(expected));expect(record.wire.indexOf(expected)).toBeLessThan(record.wire.indexOf('FULL-'+later+'-BODY'))
        const finishes=record.ownership.filter((x:any)=>x.op==='response-finish'&&[prior,marker,later].includes(x.marker)).map((x:any)=>x.marker)
        expect(finishes).toEqual([prior,marker,later]);expect(record.ingress.terminated).toBe(terminated?1:0)
      } finally {await command('finish-'+prior);await command('finish-'+later);if(!record.closed){record.emergencyDestroy=true;socket.destroy()}}
    }
    try {
      for(let i=0;i<4;i++){const label='shared-active-'+i;calls.push({label,result:client.callTool({name:'probe',arguments:{label}},undefined,{timeout:20000}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))})}
      await expect.poll(async()=>(await command('rpcStats')).ordinary).toBe(4)
      await pipe(JSON.stringify(frame('quota-denied','quota-denied')),'rpc-quota',503,'request_capacity')
      await pipe(JSON.stringify(frame(1,'duplicate-denied')),'rpc-duplicate',409,'duplicate_request_id')
      expect((await command('rpcStats')).ordinary).toBe(4)
      for(const call of calls)await command('rpc-release:'+call.label)
      for(const call of calls)expect((await call.result).ok).toBe(true)
      await expect.poll(async()=>(await command('rpcStats')).ordinary).toBe(0)
      for(const size of [65535,65536,65537]) {
        const id='bytes-'+size,label=id,base=frame(id,label),empty=JSON.stringify(base)
        const payload='a'.repeat(size-Buffer.byteLength(empty)),message=frame(id,label,payload),body=JSON.stringify(message)
        expect(Buffer.byteLength(body)).toBe(size);expect(JSON.parse(body).params.arguments.payload).toBe(payload)
        const record:any={size,payloadLength:payload.length};audit.boundaries.push(record)
        if(size===65537){await pipe(body,'rpc-oversize',413,'body_too_large',true);record.rejection=audit.pipes.at(-1).ingress.queued;expect((await command('rpcStats')).events.some((x:any)=>x.op==='entered'&&x.id===id)).toBe(false)}
        else {
          const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer fixture-A','mcp-session-id':sid,'content-type':'application/json',accept:'application/json, text/event-stream'},body});record.status=response.status;record.body=await response.text();expect(record.status).toBe(200);expect(record.body).toContain('done:'+label)
          const entered=(await command('rpcStats')).events.find((x:any)=>x.op==='entered'&&x.id===id);expect(entered.payloadLength).toBe(payload.length)
        }
      }
      await expect.poll(async()=>(await command('ingressStats')).slots.total).toBe(0)
      audit.final=await command('rpcStats');expect(audit.final.ordinary).toBe(0)
      expect(audit.pipes.some((x:any)=>x.emergencyDestroy)).toBe(false)
    } finally {
      for(const call of calls)await command('rpc-release:'+call.label)
      await Promise.all(calls.map(x=>x.result));await transport.terminateSession();await client.close();audit.cleanup=await command('rpcStats')
    }
  },45000)


  async function makeLifecycleClient(name:string,audit:any) {
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const client=new Client({name,version:'1'});client.onerror=error=>audit.errors.push({name,message:String(error)})
    const transport=new StreamableHTTPClientTransport(new URL(endpoint.replace('/mcp','/adapter')),{requestInit:{headers:{authorization:'Bearer fixture-A','x-fixture-marker':name}},fetch:async(input,init)=>{const response=await fetch(input,init);const row:any={name,method:init?.method,status:response.status,sid:response.headers.get('mcp-session-id')};if(response.status>=400)row.body=await response.clone().text();audit.http.push(row);return response}})
    await client.connect(transport);expect(transport.sessionId).toBeTypeOf('string');expect(transport.sessionId).not.toBe('');return {client,transport,sid:transport.sessionId!}
  }

  it.skipIf(phase!=='get')('M_real_GET_limits_reconnect_and_independent_quotas',async()=>{
    expect(controlSucceeded).toBe(true)
    const audit:any={http:[],errors:[],raw:[],pipes:[]};evidence.get=audit
    const made:any[]=[],calls:any[]=[],pipes:any[]=[];let rawAbort:AbortController|undefined
    const url=endpoint.replace('/mcp','/adapter')
    const raw=async(sid:string,signal?:AbortSignal)=>{const response=await fetch(url,{headers:{authorization:'Bearer fixture-A','mcp-session-id':sid,'mcp-protocol-version':made[0].transport.protocolVersion,accept:'text/event-stream'},signal});const row:any={sid,status:response.status};if(response.status!==200)row.body=await response.text();audit.raw.push(row);return response}
    try {
      for(let i=0;i<9;i++)made.push(await makeLifecycleClient('get-'+i,audit))
      await expect.poll(async()=>(await command('lifecycleStats')).streams).toBe(8)
      await expect.poll(()=>audit.http.some((x:any)=>x.name==='get-8'&&x.method==='GET'&&x.status===503)).toBe(true)
      expect((await raw(made[0].sid)).status).toBe(409);expect((await raw(made[8].sid)).status).toBe(503)
      // Public SDK method closes the real GET stream; reconnect is SDK behavior.
      await command('standalone:'+made[0].sid)
      await expect.poll(()=>audit.http.filter((x:any)=>x.name==='get-0'&&x.method==='GET'&&x.status===200).length,{timeout:12000}).toBe(2)
      await expect.poll(async()=>(await command('lifecycleStats')).streams).toBe(8)
      await made[0].client.close();await expect.poll(async()=>(await command('lifecycleStats')).streams).toBe(7)
      rawAbort=new AbortController();const stream=await raw(made[8].sid,rawAbort.signal);expect(stream.status).toBe(200)
      await expect.poll(async()=>(await command('lifecycleStats')).streams).toBe(8)
      rawAbort.abort();await stream.body?.cancel().catch(()=>{});await expect.poll(async()=>(await command('lifecycleStats')).streams).toBe(7)
      // Sessions1..8 remain valid. Saturate ordinary32 and control8 separately.
      for(let i=1;i<9;i++)for(let j=0;j<4;j++){const label='get-active-'+i+'-'+j;calls.push({label,result:made[i].client.callTool({name:'probe',arguments:{label}},undefined,{timeout:25000}).then((value:any)=>({ok:true,value}),(error:any)=>({ok:false,error:String(error)}))})}
      await expect.poll(async()=>(await command('rpcStats')).ordinary).toBe(32)
      for(let i=1;i<=4;i++){
        const marker='get-control-'+i,socket=connectSocket(Number(new URL(url).port),'127.0.0.1'),record:any={marker,wire:'',closed:false};pipes.push({socket,record});audit.pipes.push(record)
        socket.on('data',data=>{record.wire+=data.toString()});socket.on('close',()=>{record.closed=true});socket.on('error',error=>{record.error=String(error)})
        await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
        const body=JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:99999}}),frame='POST /adapter HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer fixture-A\r\nContent-Type: application/json\r\nMcp-Session-Id: '+made[i].sid+'\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body
        socket.write('GET /hold HTTP/1.1\r\nHost: localhost\r\nX-Fixture-Marker: '+marker+'\r\n\r\n'+frame+frame)
      }
      await expect.poll(async()=>(await command('rpcStats')).control).toBe(8)
      rawAbort=new AbortController();const independent=await raw(made[8].sid,rawAbort.signal);expect(independent.status).toBe(200)
      audit.saturated=await command('lifecycleStats');expect(audit.saturated).toMatchObject({streams:8,requests:{ordinary:32,control:8}})
      rawAbort.abort();await independent.body?.cancel().catch(()=>{})
      for(const pipe of pipes){await command('finish-'+pipe.record.marker);await expect.poll(()=>(pipe.record.wire.match(/202 Accepted/g)??[]).length).toBe(2);pipe.socket.end();await expect.poll(()=>pipe.record.closed).toBe(true)}
      for(const call of calls)await command('rpc-release:'+call.label)
      for(const call of calls)expect((await call.result).ok).toBe(true)
      await expect.poll(async()=>(await command('rpcStats')).ordinary).toBe(0)
      audit.shutdownStart=await command('lifecycleShutdown');expect(audit.shutdownStart.complete).toBe(false)
      for(const owner of made)await owner.client.close()
      await expect.poll(async()=>(await command('lifecycleStats')).total).toBe(0)
      audit.final=await command('lifecycleStats');expect(audit.final).toMatchObject({streams:0,timers:0,retained:0,requests:{ordinary:0,control:0,charged:0}})
    } finally {
      rawAbort?.abort()
      for(const pipe of pipes){await command('finish-'+pipe.record.marker);if(!pipe.record.closed){pipe.record.emergencyDestroy=true;pipe.socket.destroy()}}
      for(const call of calls)await command('rpc-release:'+call.label)
      for(const owner of made)await owner.client.close()
      await Promise.all(calls.map(x=>x.result));await command('lifecycleShutdown')
    }
    expect(pipes.some(x=>x.record.emergencyDestroy)).toBe(false)
  },75000)


  it.skipIf(phase!=='init')('R1_real_init_disconnect_deadline_fields_and_late_cleanup',async()=>{
    expect(controlSucceeded).toBe(true)
    const audit:any={http:[],errors:[],attempts:[]};evidence.r1=audit
    const url=endpoint.replace('/mcp','/adapter'),parsed=new URL(url)
    for(const mode of ['disconnect','deadline']){
      await command('init:hold');const record:any={mode,wire:'',closed:false};audit.attempts.push(record)
      const socket=connectSocket(Number(parsed.port),'127.0.0.1');socket.setEncoding('utf8');socket.on('data',chunk=>{record.wire+=chunk});socket.on('error',error=>{record.error=String(error)});socket.on('close',()=>{record.closed=true})
      try{
        await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
        const body=JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'r1',version:'1'}}})
        socket.write('POST /adapter HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer fixture-A\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body)
        await expect.poll(async()=>(await command('init:stats')).sids.length).toBe(1);record.sid=(await command('init:stats')).sids[0];expect(typeof record.sid).toBe('string');expect(record.sid.length).toBeGreaterThan(0)
        if(mode==='disconnect'){record.intentionalPeerAbort=true;socket.destroy();await expect.poll(()=>record.closed).toBe(true)}
        else{await command('advance:4999');expect((await command('adapterStats')).pending).toBe(1);await command('advance:1')}
        await expect.poll(async()=>(await command('adapterStats')).closing).toBe(1)
        await command('init:release');await expect.poll(async()=>(await command('adapterStats')).total).toBe(0)
        record.stats=await command('rpcStats');expect(record.stats.events.filter((x:any)=>x.op==='storage-verified'&&x.sid===record.sid&&x.receipt.empty)).toHaveLength(1);expect(record.stats.events.filter((x:any)=>x.op==='transport-onclose-event'&&x.sid===record.sid)).toHaveLength(1)
        if(mode==='deadline'){await expect.poll(()=>record.wire.includes('503')).toBe(true);expect(record.wire).toContain('initialization_revoked');socket.end();await expect.poll(()=>record.closed).toBe(true)}
      }finally{await command('init:release');if(!record.closed){record.emergencyDestroy=true;socket.destroy()}}
      expect(record.emergencyDestroy).toBeUndefined()
    }
    const made=await makeLifecycleClient('r1-fields',audit);clients.push({close:()=>made.client.close(),transport:made.transport})
    const send=async(frame:any)=>{const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer fixture-A','mcp-session-id':made.sid,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(frame)});const row={status:response.status,body:await response.text()};audit.http.push(row);return row}
    const id='😀'.repeat(32)
    const prior=await command('rpcStats');expect((await send({jsonrpc:'2.0',id:id+'a',method:'tools/call',params:{name:'probe',arguments:{mode:'immediate',label:'rejected'}}})).status).toBe(400);expect((await command('rpcStats')).distinctIds).toBe(prior.distinctIds)
    expect((await send({jsonrpc:'2.0',id,method:'tools/call',params:{name:'probe',arguments:{mode:'immediate',label:'utf8-128'}}})).status).toBe(200)
    for(const [i,reason] of ['😀'.repeat(255)+'abc','😀'.repeat(256),'😀'.repeat(256)+'a',12].entries()){
      const before=await command('rpcStats');const response=await send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason}});expect(response.status).toBe(i<2?202:400);const after=await command('rpcStats');expect(after.distinctIds).toBe(before.distinctIds);expect(after.ordinary).toBe(0);expect(after.control).toBe(0)
    }
    await made.transport.terminateSession();await made.client.close();clients.splice(0);await expect.poll(async()=>(await command('adapterStats')).total).toBe(0)
    audit.final=await command('lifecycleStats');expect(audit.final).toMatchObject({total:0,streams:0,timers:0,retained:0,requests:{ordinary:0,control:0,charged:0}})
  },45000)

  it.skipIf(phase!=='restart')('O_real_restart_rejects_old_sid_and_accepts_new_Client',async()=>{
    expect(controlSucceeded).toBe(true)
    const audit:any={http:[],errors:[],processes:[]};evidence.restart=audit
    const first=await makeLifecycleClient('restart-first',audit)
    clients.push({close:()=>first.client.close(),transport:first.transport})
    expect(await first.client.callTool({name:'probe',arguments:{label:'restart-first-call',mode:'immediate'}})).toMatchObject({content:[{type:'text',text:'done:restart-first-call'}]})
    await expect.poll(async()=>(await command('rpcStats')).ordinary).toBe(0)
    const processOne:any={pid:child!.pid,startedObservedAt:new Date().toISOString(),sid:first.sid};audit.processes.push(processOne)
    await first.transport.terminateSession();await first.client.close();clients.splice(0)
    await expect.poll(async()=>(await command('lifecycleStats')).total).toBe(0)
    processOne.lifecycle=await command('lifecycleStats');processOne.rpc=await command('rpcStats');processOne.ingress=await command('ingressStats');processOne.ownership=await command('ownershipStats')
    expect(processOne.lifecycle).toMatchObject({total:0,streams:0,timers:0,retained:0,requests:{ordinary:0,control:0,charged:0}})
    expect(processOne.ingress.slots.total).toBe(0)
    expect(processOne.rpc.events.filter((x:any)=>x.op==='storage-verified'&&x.sid===first.sid&&x.receipt.empty)).toHaveLength(1)
    const firstChild=child!
    const exit=new Promise<void>((resolveExit,reject)=>{const timer=setTimeout(()=>reject(new Error('restart first natural exit deadline')),61000);firstChild.once('exit',(code,signal)=>{clearTimeout(timer);processOne.exit={code,signal};if(code!==0||signal)reject(new Error('restart first abnormal exit'));else resolveExit()})})
    const outcome=exit.then(()=>null,error=>error)
    processOne.shutdown=await command('shutdown');expect(processOne.shutdown.storageEmpty).toBe(true)
    const exitError=await outcome;if(exitError)throw exitError
    expect(firstChild.exitCode).toBe(0)
    // Same compiled fixture package, new process and fresh in-memory manager only after exit.
    child=fork(join(directory!,'bootstrap.mjs'),[],{cwd:directory!,stdio:['ignore','inherit','inherit','ipc'],execArgv:['--unhandled-rejections=strict']})
    const processTwo:any={pid:child.pid,startedObservedAt:new Date().toISOString()};audit.processes.push(processTwo)
    expect(processTwo.pid).not.toBe(processOne.pid)
    endpoint=await new Promise<string>((resolveReady,reject)=>{const timer=setTimeout(()=>reject(new Error('restart startup deadline')),15000);child!.once('error',reject);child!.once('exit',()=>{clearTimeout(timer);reject(new Error('restart premature exit'))});child!.on('message',(message:any)=>{if(message?.ready){clearTimeout(timer);resolveReady('http://127.0.0.1:'+message.port+'/mcp')}})})
    processTwo.initial=await command('adapterStats');expect(processTwo.initial).toMatchObject({factories:0,connects:0,total:0})
    const response=await fetch(endpoint.replace('/mcp','/adapter'),{method:'POST',headers:{authorization:'Bearer fixture-A','content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':first.sid},body:JSON.stringify({jsonrpc:'2.0',id:71,method:'tools/list',params:{}})})
    processTwo.oldSidResponse={status:response.status,body:await response.text()}
    expect(processTwo.oldSidResponse.status).toBe(404);expect(JSON.parse(processTwo.oldSidResponse.body).error.data.code).toBe('session_not_found')
    expect(await command('adapterStats')).toEqual(processTwo.initial)
    const second=await makeLifecycleClient('restart-second',audit);clients.push({close:()=>second.client.close(),transport:second.transport});processTwo.sid=second.sid
    expect(second.sid).not.toBe(first.sid)
    const unsupported=await fetch(endpoint.replace('/mcp','/adapter'),{method:'POST',headers:{authorization:'Bearer fixture-A','content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':second.sid},body:JSON.stringify({jsonrpc:'2.0',id:'missing-handler',method:'resources/list',params:{}})})
    const unsupportedBody=await unsupported.text();processTwo.unsupported={status:unsupported.status,body:unsupportedBody,contentLength:unsupported.headers.get('content-length')}
    expect(unsupported.status).toBe(501);expect(unsupportedBody).toBe(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:'handler_receipt_unavailable',data:{code:'handler_receipt_unavailable'}}}));expect(unsupported.headers.get('content-length')).toBe(String(Buffer.byteLength(unsupportedBody)))
    expect((await second.client.listTools()).tools.map(tool=>tool.name)).toEqual(['probe'])
    const listing=(await command('rpcStats')).events;const enteredList=listing.find((x:any)=>x.op==='list-entered'&&x.sid===second.sid)
    expect(enteredList).toBeDefined();expect(listing.some((x:any)=>x.op==='list-finally'&&x.sid===second.sid&&x.id===enteredList.id&&x.idType===enteredList.idType)).toBe(true)
    expect(listing.some((x:any)=>x.op==='handler-finished'&&x.sid===second.sid&&x.id===enteredList.id&&typeof x.id===enteredList.idType)).toBe(true)

    expect(await second.client.callTool({name:'probe',arguments:{label:'restart-second-call',mode:'immediate'}})).toMatchObject({content:[{type:'text',text:'done:restart-second-call'}]})
    await second.transport.terminateSession();await second.client.close();clients.splice(0)
    await expect.poll(async()=>(await command('lifecycleStats')).total).toBe(0)
    processTwo.final=await command('lifecycleStats');processTwo.rpc=await command('rpcStats');processTwo.ingress=await command('ingressStats');processTwo.ownership=await command('ownershipStats')
    expect(processTwo.final).toMatchObject({total:0,streams:0,timers:0,retained:0,requests:{ordinary:0,control:0,charged:0}})
    expect(processTwo.ingress.slots.total).toBe(0)
    expect(processTwo.rpc.events.filter((x:any)=>x.op==='storage-verified'&&x.sid===second.sid&&x.receipt.empty)).toHaveLength(1)
    expect(audit.http.filter((x:any)=>x.method==='DELETE').map((x:any)=>x.status)).toEqual([204,204])
    // Second process shutdown/actual natural exit are asserted by the existing afterAll.
  },150000)

  it.skipIf(phase!=='ttl')('N_real_TTL_active_RPC_GET_signal_and_shutdown',async()=>{
    expect(controlSucceeded).toBe(true)
    const audit:any={http:[],errors:[]};evidence.ttl=audit
    const a=await makeLifecycleClient('ttl-A',audit);let b:any,pending:Promise<any>|undefined,deletePending:Promise<any>|undefined
    try {
      await expect.poll(async()=>(await command('lifecycleStats')).streams).toBe(1)
      pending=a.client.callTool({name:'probe',arguments:{label:'ttl-active'}},undefined,{timeout:20000}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))
      await expect.poll(async()=>(await command('rpcStats')).ordinary).toBe(1)
      await command('advance:100000');b=await makeLifecycleClient('ttl-B',audit)
      await expect.poll(async()=>(await command('lifecycleStats')).streams).toBe(2)
      await command('advance:199999');expect((await command('adapterStats')).ready).toBe(2)
      audit.expire=await command('advance:1')
      await expect.poll(async()=>(await command('rpcStats')).events.some((x:any)=>x.op==='signal-aborted'&&x.label==='ttl-active')).toBe(true)
      await expect.poll(async()=>(await command('lifecycleStats')).streams).toBe(1)
      audit.held=await command('rpcStats');expect(audit.held.ordinary).toBe(1)
      expect((await command('adapterStats'))).toMatchObject({ready:1,closing:1,total:2})
      expect(audit.held.events.some((x:any)=>x.op==='handler-finally'&&x.label==='ttl-active')).toBe(false)
      expect(audit.held.events.some((x:any)=>x.op==='storage-verified'&&x.sid===a.sid&&x.receipt.empty)).toBe(true)
      expect(audit.held.events.some((x:any)=>x.op==='response-close'&&x.method==='GET'&&x.sid===a.sid)).toBe(true)
      expect(audit.held.events.some((x:any)=>x.op==='signal-aborted'&&x.sid===b.sid)).toBe(false)
      const expiredDelete=await fetch(endpoint.replace('/mcp','/adapter'),{method:'DELETE',headers:{authorization:'Bearer fixture-A','mcp-session-id':a.sid}})
      audit.expiredDelete={status:expiredDelete.status,body:await expiredDelete.text()};expect(audit.expiredDelete.status).toBe(409)
      expect(JSON.parse(audit.expiredDelete.body).error.data.code).toBe('session_closing')
      const survivor=await b.client.callTool({name:'probe',arguments:{label:'ttl-survivor',mode:'immediate'}});expect(survivor.content).toEqual([{type:'text',text:'done:ttl-survivor'}])
      // Client close is only final client cleanup, after the server signal proof.
      await a.client.close();await command('rpc-release:ttl-active');audit.clientResult=await pending
      await expect.poll(async()=>(await command('adapterStats')).total).toBe(1)
      audit.reconciled=await command('rpcStats');expect(audit.reconciled.ordinary).toBe(0)
      deletePending=b.client.callTool({name:'probe',arguments:{label:'ttl-delete-race'}},undefined,{timeout:20000}).then((value:any)=>({ok:true,value}),(error:any)=>({ok:false,error:String(error)}))
      await expect.poll(async()=>(await command('rpcStats')).events.some((x:any)=>x.op==='entered'&&x.label==='ttl-delete-race')).toBe(true)
      const deleting=await fetch(endpoint.replace('/mcp','/adapter'),{method:'DELETE',headers:{authorization:'Bearer fixture-A','mcp-session-id':b.sid}})
      audit.readyDelete={status:deleting.status,body:await deleting.text()};expect(audit.readyDelete.status).toBe(204)
      await expect.poll(async()=>(await command('rpcStats')).events.some((x:any)=>x.op==='signal-aborted'&&x.label==='ttl-delete-race')).toBe(true)
      expect((await command('adapterStats'))).toMatchObject({closing:1,total:1})
      audit.expiryDuringDelete=await command('advance:300000')
      audit.shutdownStart=await command('lifecycleShutdown');expect(audit.shutdownStart.complete).toBe(false)
      await b.client.close();await command('rpc-release:ttl-delete-race');audit.deleteClientResult=await deletePending
      await expect.poll(async()=>(await command('adapterStats')).total).toBe(0)
      audit.final=await command('lifecycleStats');expect(audit.final).toMatchObject({streams:0,timers:0,retained:0,requests:{ordinary:0,control:0,charged:0}})
      audit.closeEvents=(await command('rpcStats')).events
      for(const sid of [a.sid,b.sid]){
        expect(audit.closeEvents.filter((x:any)=>x.op==='transport-onclose-event'&&x.sid===sid)).toHaveLength(1)
        expect(audit.closeEvents.filter((x:any)=>x.op==='owner-close'&&x.sid===sid)).toHaveLength(1)
        expect(audit.closeEvents.filter((x:any)=>x.op==='storage-verified'&&x.sid===sid&&x.receipt.empty)).toHaveLength(1)
        expect(audit.closeEvents.filter((x:any)=>x.op==='transport-close-attempt'&&x.sid===sid).length).toBeGreaterThanOrEqual(1)
      }
      for(const label of ['ttl-active','ttl-delete-race']){
        const entered=audit.closeEvents.find((x:any)=>x.op==='entered'&&x.label===label)
        const receipt=audit.closeEvents.find((x:any)=>x.op==='handler-finished'&&x.sid===entered.sid&&x.id===entered.id)
        expect(receipt).toBeDefined();expect(audit.closeEvents.some((x:any)=>x.trace===receipt.trace&&(x.op==='response-finish'||x.op==='response-close'))).toBe(true)
      }
    } finally {await a.client.close();if(b)await b.client.close();await command('rpc-release:ttl-active');await command('rpc-release:ttl-delete-race');if(pending)await pending;if(deletePending)await deletePending;await command('lifecycleShutdown')}
  },45000)

  it.skipIf(!isPendingAdapterPhase(phase))('T_real_eight_pending_ninth_http_rejection', async () => {
    expect(controlSucceeded).toBe(true)
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const make = (index: number) => {
      const record: any = { index, http: [] }; evidence.clients.push(record)
      const client = new Client({ name: `adapter-${index}`, version: '1' })
      const transport = new StreamableHTTPClientTransport(new URL(endpoint.replace('/mcp', '/adapter')), {
        fetch: async (input, init) => {
          const response = await fetch(input, init)
          const row: any = { method: init?.method, status: response.status }
          if (response.status === 503) row.body = await response.clone().json()
          record.http.push(row)
          return response
        },
      })
      clients.push({ close: () => client.close(), transport })
      return { client, transport, record }
    }
    await command('hold')
    const accepted = Array.from({ length: 8 }, (_, index) => make(index))
    const attempts = accepted.map(async item => { await item.client.connect(item.transport); item.record.initialized = true; item.record.sessionId = item.transport.sessionId })
    // Attach rejection observation immediately; do not use local rejection as admission proof.
    const joined = Promise.allSettled(attempts)
    try {
      await expect.poll(async () => (await command('adapterStats')).connects).toBe(8)
      expect(await command('adapterStats')).toMatchObject({ factories: 8, connects: 8, pending: 8, ready: 0, total: 8 })
      const ninth = make(8)
      await expect(ninth.client.connect(ninth.transport)).rejects.toThrow()
      expect(ninth.record.http).toEqual([{ method: 'POST', status: 503, body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'pending_capacity', data: { code: 'pending_capacity' } } } }])
      expect(await command('adapterStats')).toMatchObject({ factories: 8, connects: 8, pending: 8, total: 8 })
      evidence.held = await command('adapterStats')
    } finally {
      await command('release')
      const settled = await joined
      evidence.initializations = settled.map(result => result.status)
    }
    expect(evidence.initializations).toEqual(Array(8).fill('fulfilled'))
    const ids = accepted.map(item => item.transport.sessionId)
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(8)
    expect(await command('adapterStats')).toMatchObject({ factories: 8, connects: 8, pending: 0, ready: 8, total: 8 })
    for (const item of accepted) {
      await item.transport.terminateSession()
      expect(item.record.http.some((row: any) => row.method === 'DELETE' && row.status === 204)).toBe(true)
      await item.client.close()
      item.record.closed = true
    }
    await clients[8]!.close()
    clients.splice(0)
    evidence.cleaned = await command('adapterStats')
    expect(evidence.cleaned).toEqual({ factories: 8, connects: 8, closes: 8, storageCleanups: 8, pending: 0, ready: 0, closing: 0, total: 0, accepting: true })
  }, 60000)

  it.skipIf(phase!=='auth')('R2_real_auth_eight_pending_ninth_http_rejection', async () => {
    expect(controlSucceeded).toBe(true)
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const make = (index: number) => {
      const record: any = { index, http: [] }; evidence.clients.push(record)
      const client = new Client({ name: `adapter-${index}`, version: '1' })
      const transport = new StreamableHTTPClientTransport(new URL(endpoint.replace('/mcp', '/adapter')), {
        fetch: async (input, init) => {
          const headers=new Headers(init?.headers);headers.set('authorization','Bearer fixture-A');const response = await fetch(input, {...init,headers})
          const row: any = { method: init?.method, status: response.status }
          if (response.status === 503) row.body = await response.clone().json()
          record.http.push(row)
          return response
        },
      })
      clients.push({ close: () => client.close(), transport })
      return { client, transport, record }
    }
    await command('init:authhold')
    const accepted = Array.from({ length: 8 }, (_, index) => make(index))
    const attempts = accepted.map(async item => { await item.client.connect(item.transport); item.record.initialized = true; item.record.sessionId = item.transport.sessionId })
    // Attach rejection observation immediately; do not use local rejection as admission proof.
    const joined = Promise.allSettled(attempts)
    try {
      await expect.poll(async () => (await command('init:authstats')).entered).toBe(8);expect(await command('init:authstats')).toEqual({entered:8,providers:8})
      expect(await command('adapterStats')).toMatchObject({ factories: 8, connects: 8, pending: 0, ready: 8, total: 8 })
      const ninth = make(8)
      await expect(ninth.client.connect(ninth.transport)).rejects.toThrow()
      expect(ninth.record.http).toEqual([{ method: 'POST', status: 503, body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'pending_capacity', data: { code: 'pending_capacity' } } } }])
      expect(await command('adapterStats')).toMatchObject({ factories: 8, connects: 8, pending: 0, ready: 8, total: 8 })
      expect(await command('init:authstats')).toEqual({entered:8,providers:8});evidence.authHeld=await command('init:authstats');evidence.held = await command('adapterStats')
    } finally {
      await command('init:authrelease')
      const settled = await joined
      evidence.initializations = settled.map(result => result.status)
    }
    expect(evidence.initializations).toEqual(Array(8).fill('fulfilled'))
    const ids = accepted.map(item => item.transport.sessionId)
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(8)
    expect(await command('adapterStats')).toMatchObject({ factories: 8, connects: 8, pending: 0, ready: 8, total: 8 })
    for (const item of accepted) {
      await item.transport.terminateSession()
      expect(item.record.http.some((row: any) => row.method === 'DELETE' && row.status === 204)).toBe(true)
      await item.client.close()
      item.record.closed = true
    }
    await clients[8]!.close()
    clients.splice(0)
    evidence.cleaned = await command('adapterStats')
    expect(evidence.cleaned).toEqual({ factories: 8, connects: 8, closes: 8, storageCleanups: 8, pending: 0, ready: 0, closing: 0, total: 0, accepting: true })
  }, 60000)

  afterAll(async () => {
    if (!child) return
    try {
      const cleanup = await Promise.allSettled(clients.map(async client => {
        try { await client.transport.terminateSession() }
        finally { await client.close() }
      }))
      clients.length = 0
      const exited = new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('CLEANUP: vendor interval did not exit within observation window')), 61000)
        child!.once('exit', (code, signal) => {
          clearTimeout(timer)
          evidence.fixtureExit = { code, signal }
          if (code !== 0 || signal) reject(new Error('CLEANUP: abnormal fixture exit'))
          else resolveExit()
        })
      })
      const exitResult = exited.then(() => null, error => error as Error)
      evidence.rpcTimeline=await command('rpcStats');evidence.ownershipTimeline=await command('ownershipStats');evidence.ingressTimeline=await command('ingressStats');
      const result = await command('shutdown')
      evidence.shutdown = result
      expect(result.storageEmpty).toBe(true)
      const exitError = await exitResult
      if (exitError) throw exitError
      const failures = cleanup.filter(result => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'CLEANUP: client failures')
    } finally {
      if (child.exitCode === null && child.signalCode === null) { evidence.emergencyKill = true; child.kill('SIGKILL') }
      if (directory) await writeFile(join(directory, 'adapter-evidence.json'), JSON.stringify(evidence, null, 2))
    }
  }, 90000)
})

describe('T_pure_controls', () => {
  it('T_pure_invalid_identity_and_unsupported_rpc', async () => {
    let factories = 0
    const owner = { close: async () => {}, connect: async (_transport?: unknown) => {} }
    const adapter = createSessionInitializationTransport({
      authenticate: () => ({ kind: 'anonymous' as const, epoch: 1 }),
      factory: () => { factories++; return owner }, provider: async () => new Response(), adopted: () => owner, cleanupSession: async () => ({ empty: true as const }),
    })
    const invalid = await adapter.handle({}, new Request('http://local', { method: 'POST', headers: { authorization: '' }, body: '{}' }))
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toMatchObject({ error: { data: { code: 'invalid_identity' } } })
    const unsupported = await adapter.handle({}, new Request('http://local', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }) }))
    expect(unsupported.status).toBe(501); expect(factories).toBe(0)
    expect(adapter.shutdown().complete).toBe(true)
  })

  it('T_pure_late_provider_reconciles_without_publish', async () => {
    const entered = admissionDeferred<void>(); const response = admissionDeferred<Response>(); let closed = 0; let cleared = 0
    const owner = { close: async () => { closed++ }, connect: async (_transport?: unknown) => {} }
    const adapter = createSessionInitializationTransport({
      authenticate: () => ({ kind: 'anonymous' as const, epoch: 1 }), factory: () => owner,
      provider: async () => { const transport = { sessionId: undefined as string | undefined, close: async () => {} }; await owner.connect(transport); transport.sessionId = 'late'; entered.resolve(); return response.promise }, adopted: () => owner,
      cleanupSession: async () => { cleared++; return { empty: true as const } },
    })
    const pending = adapter.handle({}, new Request('http://local', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }) }))
    await entered.promise
    expect(adapter.shutdown()).toMatchObject({ complete: false, closing: 1, total: 1 })
    response.resolve(new Response('{}', { headers: { 'mcp-session-id': 'late' } }))
    const rejected = await pending
    expect(rejected.status).toBe(503); expect(rejected.headers.has('mcp-session-id')).toBe(false)
    expect(closed).toBe(1); expect(cleared).toBe(1); expect(adapter.shutdown().complete).toBe(true)
  })

  it('T_pure_cleanup_failure_and_wrong_identity_preserve_charge', async () => {
    let epoch = 1; let closed = 0
    const owner = { close: async () => { closed++ }, connect: async (_transport?: unknown) => {} }
    const adapter = createSessionInitializationTransport({
      authenticate: () => ({ kind: 'authorized' as const, principal: 'owner', epoch }), factory: () => owner,
      provider: async () => { const transport = { sessionId: undefined as string | undefined, close: async () => {} }; await owner.connect(transport); transport.sessionId = 'owned'; return new Response('{}', { headers: { 'mcp-session-id': 'owned' } }) }, adopted: () => owner,
      cleanupSession: async () => { throw new Error('private-credential') },
    })
    const headers = { authorization: 'Bearer test-only' }
    const initialized = await adapter.handle({}, new Request('http://local', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }) }))
    expect(initialized.status).toBe(200)
    epoch = 2
    expect((await adapter.handle({}, new Request('http://local', { method: 'DELETE', headers: { ...headers, 'mcp-session-id': 'owned' } }))).status).toBe(404)
    expect(closed).toBe(0); expect(adapter.snapshot().ready).toBe(1)
    epoch = 1 // Pure identity comparison only; NOT a trusted monotonic epoch source.
    const deletion = await adapter.handle({}, new Request('http://local', { method: 'DELETE', headers: { ...headers, 'mcp-session-id': 'owned' } }))
    expect(deletion.status).toBe(503)
    expect(await deletion.text()).not.toContain('private-credential')
    expect(adapter.shutdown()).toMatchObject({ complete: false, closing: 1, total: 1 })
    expect(closed).toBe(1)
  })

})

function resourceARequest(method = 'POST', sid?: string) {
  return new Request('http://local', { method, headers: sid ? { 'mcp-session-id': sid } : {}, ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }) } : {}) })
}
function resourceAHarness(...receipts: unknown[]) {
  const receipt = receipts.length ? receipts[0] : { empty: true }
  const log: string[] = []
  let nextSid = 'owned-a'; let header: string | undefined; let failProvider = false; let failCleanup = false; let failOwner = false; let failTransport = false
  let adopted: any
  const adapter = createSessionInitializationTransport({
    authenticate: () => ({ kind: 'anonymous' as const, epoch: 1 }),
    factory: () => {
      const name = nextSid
      let connected: any
      const owner = { connect: async (transport: any) => { connected = transport }, close: async () => { log.push('owner:' + name); if (failOwner) throw new Error('private-owner'); await connected?.close() } }
      adopted = owner
      return owner
    },
    provider: async factory => {
      const owner = factory()
      const allocated = nextSid
      const transport = { sessionId: undefined as string | undefined, close: async () => { log.push('transport:' + allocated); if (failTransport) throw new Error('private-transport') } }
      await owner.connect(transport)
      transport.sessionId = nextSid
      log.push('allocated:' + transport.sessionId)
      if (failProvider) throw new Error('private-provider')
      return new Response('{}', { headers: { 'mcp-session-id': header ?? nextSid } })
    },
    adopted: () => adopted,
    cleanupSession: async sid => { log.push('storage:' + sid); if (failCleanup) throw new Error('private-storage'); return receipt as { empty: true } },
  })
  return { adapter, log, configure(options: { sid?: string; header?: string; provider?: boolean; cleanup?: boolean; owner?: boolean; transport?: boolean }) {
    if (options.sid) nextSid = options.sid
    header = options.header; failProvider = !!options.provider; failCleanup = !!options.cleanup; failOwner = !!options.owner; failTransport = !!options.transport
  } }
}

describe('U_resourceA_pure', () => {
  it('U_transport_close_failure_still_cleans_storage_and_retains_charge', async () => {
    const h = resourceAHarness(); h.configure({provider:true,transport:true})
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(503)
    expect(h.log).toEqual(['allocated:owned-a','owner:owned-a','transport:owned-a','storage:owned-a'])
    expect(h.adapter.shutdown()).toMatchObject({complete:false,closing:1,total:1})
  })
  it('U_receipt_pending_holds_charge_until_verified', async () => {
    const receipt = admissionDeferred<{empty:true}>()
    const h = resourceAHarness(receipt.promise); h.configure({provider:true})
    const request = h.adapter.handle({}, resourceARequest())
    await expect.poll(() => h.log.includes('storage:owned-a')).toBe(true)
    expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1})
    receipt.resolve({empty:true})
    expect((await request).status).toBe(500)
    expect(h.adapter.snapshot().total).toBe(0)
  })

  for (const [name, receipt] of [
    ['U_false_receipt_retains_charge', {empty:false}],
    ['U_malformed_receipt_retains_charge', {empty:'true'}],
    ['U_missing_receipt_retains_charge', undefined],
  ] as const) it(name, async () => {
    const h = resourceAHarness(receipt)
    h.configure({provider:true})
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(503)
    expect(h.adapter.shutdown()).toMatchObject({complete:false,closing:1,total:1})
    expect(h.adapter.shutdown().total).toBe(1)
    expect(h.log).toEqual(['allocated:owned-a','owner:owned-a','transport:owned-a','storage:owned-a'])
  })
  it('U_sid_normalization_delimiters_never_claim_or_clear', async () => {
    for (const sid of ['owner:child','owner/child','owner?query','owner\\child']) {
      const h = resourceAHarness(); h.configure({sid})
      expect((await h.adapter.handle({}, resourceARequest())).status).toBe(500)
      expect(h.log.some(item => item.startsWith('allocated:'))).toBe(false)
      expect(h.log.some(item => item.startsWith('storage:'))).toBe(false)
      expect(h.adapter.snapshot().total).toBe(0)
    }
  })

  it('U_post_allocation_throw_closes_owner_transport_and_exact_storage', async () => {
    const h = resourceAHarness(); h.configure({ provider: true })
    const response = await h.adapter.handle({}, resourceARequest())
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('private-provider')
    expect(h.log).toEqual(['allocated:owned-a', 'owner:owned-a', 'transport:owned-a', 'storage:owned-a'])
    expect(h.adapter.snapshot().total).toBe(0)
    expect(h.adapter.shutdown().complete).toBe(true)
  })
  it('U_cleanup_rejection_keeps_closing_charge', async () => {
    const h = resourceAHarness(); h.configure({ provider: true, cleanup: true })
    const response = await h.adapter.handle({}, resourceARequest())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-storage')
    expect(h.log).toEqual(['allocated:owned-a', 'owner:owned-a', 'transport:owned-a', 'storage:owned-a'])
    expect(h.adapter.shutdown()).toMatchObject({ complete: false, closing: 1, total: 1 })
    expect(h.adapter.shutdown().total).toBe(1)
    expect(h.log.length).toBe(4)
  })
  it('U_owner_close_failure_still_closes_transport_and_clears_storage', async () => {
    const h = resourceAHarness(); h.configure({ provider: true, owner: true })
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(503)
    expect(h.log).toEqual(['allocated:owned-a', 'owner:owned-a', 'transport:owned-a', 'storage:owned-a'])
    expect(h.adapter.shutdown()).toMatchObject({ complete: false, closing: 1, total: 1 })
  })
  it('U_header_mismatch_never_cleans_foreign_sid', async () => {
    const h = resourceAHarness()
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(200)
    h.configure({ sid: 'owned-b', header: 'owned-a' })
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(500)
    expect(h.log).toEqual(['allocated:owned-a', 'allocated:owned-b', 'owner:owned-b', 'transport:owned-b', 'storage:owned-b'])
    expect(h.adapter.snapshot()).toMatchObject({ ready: 1, total: 1 })
    expect((await h.adapter.handle({}, resourceARequest('DELETE', 'owned-a'))).status).toBe(204)
    expect(h.log.filter(item => item === 'storage:owned-a')).toHaveLength(1)
    expect(h.adapter.snapshot().total).toBe(0)
  })
  it('U_sid_collision_rejected_before_provider_publication', async () => {
    const h = resourceAHarness()
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(200)
    expect((await h.adapter.handle({}, resourceARequest())).status).toBe(500)
    expect(h.log.filter(item => item === 'allocated:owned-a')).toHaveLength(1)
    expect(h.log.filter(item => item === 'storage:owned-a')).toHaveLength(0)
    expect(h.adapter.snapshot()).toMatchObject({ ready: 1, total: 1 })
    expect((await h.adapter.handle({}, resourceARequest('DELETE', 'owned-a'))).status).toBe(204)
    expect(h.log.filter(item => item === 'storage:owned-a')).toHaveLength(1)
    expect(h.adapter.shutdown().complete).toBe(true)
  })
})


describe.skipIf(phase !== 'resource-a')('V_resourceA_real', () => {
  const evidence: Record<string, any> = { mode: 'real-vendor-post-allocation-fault' }
  beforeAll(async () => {
    directory = await prepareFixture(true, true)
    child = fork(join(directory, 'bootstrap.mjs'), [], { cwd: directory, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--unhandled-rejections=strict'] })
    endpoint = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('INFRA: fixture startup deadline')), 15000)
      child!.once('error', reject)
      child!.once('exit', () => { clearTimeout(timer); reject(new Error('INFRA: fixture exited before ready')) })
      child!.on('message', (message: any) => {
        if (message?.ready) { clearTimeout(timer); resolveReady(`http://127.0.0.1:${message.port}/mcp`) }
      })
    })
    const client = await newClient()
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['probe'])
    expect(await client.callTool({ name: 'probe', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'probe-ready' }] })
    await clients[0]!.transport.terminateSession()
    await clients[0]!.close()
    clients.splice(0, 1)
    controlSucceeded = true
    evidence.originalControl = { initialize: true, listTools: true, callTool: true, delete: true, close: true }
  }, 180000)


  it('V_vendor_allocated_sid_then_throw_exact_cleanup', async () => {
    expect(controlSucceeded).toBe(true)
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const client = new Client({ name: 'resource-a', version: '1' })
    evidence.http = []
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.replace('/mcp','/adapter')), {
      fetch: async (input, init) => {
        const response = await fetch(input,init)
        evidence.http.push({method:init?.method,status:response.status,body:await response.clone().json()})
        return response
      },
    })
    clients.push({close:()=>client.close(),transport})
    await expect(client.connect(transport)).rejects.toThrow()
    expect(evidence.http).toEqual([{method:'POST',status:500,body:{jsonrpc:'2.0',id:null,error:{code:-32000,message:'initialization_failed',data:{code:'initialization_failed'}}}}])
    evidence.stats = await command('adapterStats')
    expect(evidence.stats).toMatchObject({factories:1,connects:1,closes:1,storageCleanups:1,pending:0,ready:0,closing:0,total:0})
    const events = evidence.stats.faultEvents
    expect(events.map((event: any)=>event.op)).toEqual(['allocated-then-throw','transport-close','storage-cleaned'])
    expect(typeof events[0].sid).toBe('string'); expect(events[0].sid.length).toBeGreaterThan(0)
    expect(events[1].sid).toBe(events[0].sid); expect(events[2].sid).toBe(events[0].sid)
    expect(events[2].empty).toBe(true)
    expect(events[0].targetKeys).toEqual([
      'sessions:' + events[0].sid, 'sessions:' + events[0].sid + ':child', 'sessions:' + events[0].sid + ':nested:leaf',
      'sessions-meta:' + events[0].sid, 'sessions-meta:' + events[0].sid + ':child', 'sessions-meta:' + events[0].sid + ':nested:leaf',
    ])
    expect(events[0].targetBefore.map((entry: any) => entry.key)).toEqual(events[0].targetKeys)
    expect(events[0].targetBefore.map((entry: any) => entry.value)).toEqual(['target-parent','target-child','target-nested','target-parent','target-child','target-nested'])
    expect(events[2].removedKeys).toEqual(events[0].targetKeys)
    expect(events[2].relativeKeys).toEqual([['child','nested:leaf'],['child','nested:leaf']])
    expect(events[2].targetRemaining).toEqual([])
    expect(events[2].foreignAfter).toEqual(events[0].foreignBefore)
    expect(events[0].foreignBefore).toHaveLength(8)
    expect(events[2].beforeReceipt).toMatchObject({closing:1,total:1})
    expect(events[2].receipt).toEqual({empty:true})
    evidence.foreignCleanup = await command('releaseForeign')
    expect(evidence.foreignCleanup.before).toEqual(events[0].foreignBefore)
    expect(evidence.foreignCleanup.deletedKeys).toEqual(events[0].foreignBefore.map((entry: any) => entry.key))
    expect(evidence.foreignCleanup.remaining).toEqual([])
    expect(transport.sessionId).toBeUndefined()
    await client.close(); clients.splice(0)
  })
  afterAll(async () => {
    if (!child) return
    try {
      const cleanup = await Promise.allSettled(clients.map(async client => {
        try { await client.transport.terminateSession() }
        finally { await client.close() }
      }))
      clients.length = 0
      const exited = new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('CLEANUP: vendor interval did not exit within observation window')), 61000)
        child!.once('exit', (code, signal) => {
          clearTimeout(timer)
          evidence.fixtureExit = { code, signal }
          if (code !== 0 || signal) reject(new Error('CLEANUP: abnormal fixture exit'))
          else resolveExit()
        })
      })
      const exitResult = exited.then(() => null, error => error as Error)
      const result = await command('shutdown')
      evidence.shutdown = result
      expect(result.storageEmpty).toBe(true)
      const exitError = await exitResult
      if (exitError) throw exitError
      const failures = cleanup.filter(result => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'CLEANUP: client failures')
    } finally {
      if (child.exitCode === null && child.signalCode === null) { evidence.emergencyKill = true; child.kill('SIGKILL') }
      if (directory) await writeFile(join(directory, 'resourceA-evidence.json'), JSON.stringify(evidence, null, 2))
    }
  }, 90000)
})

// B pure ingress expectations use only this component's injectable clock.
function bodyClock() {
  let now = 0, next = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout(fn: () => void, delay: number) { const id = ++next; jobs.set(id, { at: now + delay, fn }); return id },
    clearTimeout(id: unknown) { jobs.delete(id as number) },
    async advance(ms: number) { for (let i = 0; i < 12; i++) await Promise.resolve(); now += ms; for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.fn() }; for (let i = 0; i < 12; i++) await Promise.resolve() },
  }
}
function bodyHarness(options: { bytes?: Uint8Array; raw?: Array<[string,string]>; stall?: boolean; close?: 'immediate'|'late'|'reject'|'never'; context?: string } = {}) {
  const peer=controlledPeer(),closed={promise:peer.closed,resolve:(_receipt:{closed:true})=>peer.close()}
  let controller!: ReadableStreamDefaultController<Uint8Array>, terminated = 0, factories = 0
  const clock = bodyClock(), context = { marker: options.context ?? 'body-context' }
  const bytes = options.bytes ?? new TextEncoder().encode('{"jsonrpc":"2.0","id":0,"method":"initialize"}')
  const stream = new ReadableStream<Uint8Array>({start(c) { controller = c; if (!options.stall) { c.enqueue(bytes); c.close() } }})
  const ingress = { method:'POST', url:'http://unit/adapter', headers:new Headers({'content-type':'application/json','content-length':String(bytes.length)}), rawHeaders:options.raw ?? [['content-length',String(bytes.length)]], body:stream, closed:closed.promise,subscribeClosed:peer.subscribeClosed,
    terminate() { terminated++; if (options.close === 'reject') return Promise.reject(new Error('termination rejected')); if (!options.close || options.close === 'immediate') { controller.error(new Error('terminated')); closed.resolve({closed:true}) } },
  }
  const replayed: any[] = []
  let owner: any
  const adapter = createActualSessionInitializationTransport({
    clock,
    authenticate: (event: typeof context) => { expect(event).toBe(context); return {kind:'anonymous' as const,epoch:1} },
    replay: async (event: typeof context, request: Request, run: (event: typeof context)=>Promise<Response>) => { replayed.push({bytes:Array.from(new Uint8Array(await request.arrayBuffer())),marker:event.marker}); return run(event) },
    factory: () => { factories++; owner = {connect:async (_connection: unknown)=>{},close:async()=>{}}; return owner },
    provider: async (factory: ()=>any) => { const candidate=factory(); const connection={sessionId:undefined as string|undefined,close:async()=>{}}; await candidate.connect(connection); connection.sessionId='body-owned'; return new Response('{}',{headers:{'mcp-session-id':'body-owned'}}) },
    adopted:()=>owner,cleanupSession:async()=>({empty:true as const}),
  })
  return {adapter,ingress,context,clock,replayed,closed,finish() {controller.close()},counts:()=>({terminated,factories})}
}

describe('B_ingress_pure', () => {
  for (const size of [16383,16384]) it('B_bytes_' + size + '_exact_replay', async () => {
    const prefix='{"jsonrpc":"2.0","id":0,"method":"initialize","padding":"'
    const bytes=new TextEncoder().encode(prefix+'x'.repeat(size-prefix.length-2)+'"}')
    expect(bytes.length).toBe(size)
    const h=bodyHarness({bytes});expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(200)
    expect(h.replayed).toEqual([{bytes:Array.from(bytes),marker:'body-context'}])
    expect(h.adapter.bodySnapshot()).toEqual({reading:0,closing:0,total:0})
    expect(h.counts()).toEqual({terminated:0,factories:1}); h.adapter.shutdown()
  })
  it('B_bytes_16385_rejected_before_factory', async () => {
    const h=bodyHarness({bytes:new Uint8Array(16385)})
    expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(413)
    expect(h.counts()).toEqual({terminated:1,factories:0})
    expect(h.adapter.bodySnapshot().total).toBe(0)
  })
  it('B_40_reading_41_rejected_and_eof_once', async () => {
    const h=bodyHarness({stall:true,close:'late'})
    const ingresses=Array.from({length:40},()=>{const done=admissionDeferred<{closed:true}>();let c!:ReadableStreamDefaultController<Uint8Array>;return {done,get c(){return c},input:{...h.ingress,body:new ReadableStream<Uint8Array>({start(x){c=x}}),closed:done.promise,terminate:()=>{}}}})
    const pending=ingresses.map(x=>h.adapter.handle(h.context,x.input))
    expect(h.adapter.bodySnapshot()).toEqual({reading:40,closing:0,total:40})
    expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(503)
    for(const x of ingresses){x.c.close();x.done.resolve({closed:true})}
    await Promise.all(pending)
    expect(h.adapter.bodySnapshot()).toEqual({reading:0,closing:0,total:0})
    for(const x of ingresses)x.done.resolve({closed:true})
    expect(h.adapter.bodySnapshot().total).toBe(0)
    expect(h.counts().factories).toBe(0)
  })
  it('B_deadline_5000_late_close_and_250_observation', async () => {
    const h=bodyHarness({stall:true,close:'late'});const pending=h.adapter.handle(h.context,h.ingress)
    await h.clock.advance(4999);expect(h.counts().terminated).toBe(0)
    await h.clock.advance(1);expect(h.counts().terminated).toBe(1)
    expect(h.adapter.bodySnapshot()).toEqual({reading:0,closing:1,total:1})
    await h.clock.advance(250);expect((await pending).status).toBe(408)
    expect(h.adapter.bodySnapshot().total).toBe(1)
    h.closed.resolve({closed:true});await h.clock.advance(0)
    expect(h.adapter.bodySnapshot().total).toBe(0)
    h.closed.resolve({closed:true});expect(h.adapter.bodySnapshot().total).toBe(0)
  })
  for(const close of ['reject','never'] as const) it('B_termination_'+close+'_retains_closing', async()=>{
    const h=bodyHarness({stall:true,close});const pending=h.adapter.handle(h.context,h.ingress)
    await h.clock.advance(5000);await h.clock.advance(250)
    expect((await pending).status).toBe(408)
    expect(h.adapter.bodySnapshot()).toEqual({reading:0,closing:1,total:1})
    expect(h.counts()).toEqual({terminated:1,factories:0})
  })
  for(const [name,raw] of [
    ['duplicate_cl',[['content-length','44'],['Content-Length','44']]],
    ['te',[['transfer-encoding','chunked']]],
    ['cl_te',[['content-length','44'],['transfer-encoding','chunked']]],
    ['compression',[['content-length','44'],['content-encoding','gzip']]],
    ['nondecimal',[['content-length','+44']]],
    ['missing_cl',[]],
  ] as Array<[string,Array<[string,string]>]>) it('B_framing_'+name,async()=>{
    const h=bodyHarness({raw});expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(400)
    expect(h.counts()).toEqual({terminated:1,factories:0});expect(h.adapter.bodySnapshot().total).toBe(0)
  })
  it('B_actual_bytes_must_match_content_length',async()=>{
    const h=bodyHarness({raw:[['content-length','100']]});expect((await h.adapter.handle(h.context,h.ingress)).status).toBe(400)
    expect(h.counts().factories).toBe(0);expect(h.adapter.bodySnapshot().total).toBe(0)
  })
  it('B_distinct_context_and_bytes_do_not_bleed',async()=>{
    const a=bodyHarness({context:'A'}),b=bodyHarness({context:'B'})
    await Promise.all([a.adapter.handle(a.context,a.ingress),b.adapter.handle(b.context,b.ingress)])
    expect(a.replayed[0].marker).toBe('A');expect(b.replayed[0].marker).toBe('B')
    a.adapter.shutdown();b.adapter.shutdown()
  })
})

import { createSocketOwnership } from '../server/utils/mcp-session-transport'
describe('W_socket_ownership_pure', () => {
  it('R1_socket_observers_detach_and_already_closed_notify_once',()=>{
    const manager=createSocketOwnership<object>(),socket={};let calls=0
    for(let i=0;i<80;i++){const h=manager.register(socket,()=>{}),detach=h.subscribeClosed(()=>{calls++});expect(manager.observerCount(socket)).toBe(1);detach();detach();h.requestFinished();h.responseFinished();expect(manager.observerCount(socket)).toBe(0);expect(manager.snapshot(socket).active).toBe(0)}
    const h=manager.register(socket,()=>{});h.subscribeClosed(()=>{calls++;throw new Error('observer failure')});const sibling=manager.register(socket,()=>{});sibling.subscribeClosed(()=>{calls++});manager.closed(socket);expect(calls).toBe(2);expect(manager.observerCount(socket)).toBe(0);h.subscribeClosed(()=>{calls++});expect(calls).toBe(3)
  })

  it('W_dynamic_later_owner_blocks_close_until_both_halves_finish', async () => {
    const manager=createSocketOwnership<object>();const socket={};let destroys=0
    const prior=manager.register(socket,()=>{destroys++}), failed=manager.register(socket,()=>{destroys++})
    failed.terminate();failed.terminate();prior.requestFinished();prior.responseFinished()
    const later=manager.register(socket,()=>{destroys++})
    await Promise.resolve();expect(destroys).toBe(0)
    later.responseFinished();await Promise.resolve();expect(destroys).toBe(0)
    later.requestFinished();await Promise.resolve();expect(destroys).toBe(1)
    let acknowledged=false;failed.closed.then(()=>{acknowledged=true});await Promise.resolve();expect(acknowledged).toBe(false)
    manager.closed(socket);await Promise.resolve();expect(acknowledged).toBe(true)
    failed.terminate();later.responseFinished();await Promise.resolve();expect(destroys).toBe(1)
  })
  it('W_never_prior_keeps_forty_pending_and_other_socket_isolated', async()=>{
    const manager=createSocketOwnership<object>();const socket={},other={};let destroyed=0,otherDestroyed=0
    const prior=manager.register(socket,()=>{destroyed++})
    const held=Array.from({length:40},()=>manager.register(socket,()=>{destroyed++}))
    held.forEach(x=>x.terminate());prior.requestFinished();await Promise.resolve()
    expect(manager.snapshot(socket)).toEqual({active:41,terminating:40,destroyRequested:false,closed:false});expect(destroyed).toBe(0)
    const independent=manager.register(other,()=>{otherDestroyed++});independent.terminate();await Promise.resolve()
    expect(otherDestroyed).toBe(1);expect(destroyed).toBe(0)
    manager.closed(other);await independent.closed
    expect(manager.snapshot(socket).terminating).toBe(40)
  })
  it('W_completed_handle_cannot_destroy_reused_connection',async()=>{
    const manager=createSocketOwnership<object>();const socket={};let destroyed=0
    const old=manager.register(socket,()=>{destroyed++});old.requestFinished();old.responseFinished()
    const current=manager.register(socket,()=>{destroyed++});old.terminate();await Promise.resolve();expect(destroyed).toBe(0)
    current.terminate();await Promise.resolve();expect(destroyed).toBe(1)
    expect(()=>manager.register(socket,()=>{})).toThrow('socket_closing')
    manager.closed(socket);await current.closed
  })
})

function quotaHarness(missingHandlerReceipt=false) {
  let sequence=0,provided=0
  const owners=new Map<string,any>()
  const adapter=createActualSessionInitializationTransport<any,any>({
    authenticate:e=>({kind:'authorized',epoch:1,principal:e.token??'A'}),
    replay:async(e,request,run)=>{e.request=request;return run(e)},
    factory:()=>({connect:async()=>{},close:async()=>{}}),
    provider:async(factory,e)=>{
      provided++
      if(!e.sid){const owner=factory(),connection={sessionId:undefined as string|undefined,close:async()=>{},closeSSEStream:(_id:unknown)=>{}};await owner.connect(connection);connection.sessionId='quota'+(++sequence);owners.set(connection.sessionId,owner);e.owner=owner;return new Response('{}',{headers:{'mcp-session-id':connection.sessionId}})}
      return new Response('{}',{status:e.method==='notifications/cancelled'||e.method==='notifications/initialized'?202:200})
    },adopted:e=>e.owner,cleanupSession:async()=>({empty:true}),handlerFinished:e=>{if(missingHandlerReceipt)throw new Error('private-credential');return e.handler.promise},
  })
  function invoke(sid:string|undefined,id:any,method='tools/call',options:{token?:string;params?:any;padding?:number;delete?:boolean}={}) {
    const handler=admissionDeferred<{finished:true}>(),response=admissionDeferred<{finished:true}>()
    const message={jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params:options.params??{},...(options.padding?{padding:'x'.repeat(options.padding)}:{})}
    const bytes=new TextEncoder().encode(JSON.stringify(message));const headers=new Headers({authorization:'Bearer fixture',...(sid?{'mcp-session-id':sid}:{}),'content-length':String(bytes.length)})
    const event={sid,method,handler,token:options.token};const input={method:options.delete?'DELETE':'POST',url:'http://unit/adapter',headers,rawHeaders:[...headers] as Array<[string,string]>,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close()}}),...controlledPeer(),responseFinished:response.promise,terminate(){}}
    return {result:adapter.handle(event,input),handler:()=>handler.resolve({finished:true}),finish:()=>response.resolve({finished:true})}
  }
  return {adapter,invoke,provided:()=>provided,async session(){const call=invoke(undefined,0,'initialize');const result=await call.result;call.finish();expect(result.status).toBe(200);const sid=result.headers.get('mcp-session-id');expect(sid).toBeTypeOf('string');expect(sid).not.toBe('');return sid!}}
}
async function quotaFlush(){for(let i=0;i<20;i++)await Promise.resolve()}
describe('Q_rpc_quota_ids_pure',()=>{
  it('R1_UTF8_id128_129_and_cancel_reason_boundaries',async()=>{
    const h=quotaHarness(),sid=await h.session(),id='😀'.repeat(32)
    const before=h.adapter.requestSnapshot(),provided=h.provided();expect((await h.invoke(sid,id+'a').result).status).toBe(400);expect(h.provided()).toBe(provided);expect(h.adapter.requestSnapshot()).toEqual(before)
    const active=h.invoke(sid,id);expect((await active.result).status).toBe(200)
    for(const reason of ['😀'.repeat(256)+'a',42,null]){const snapshot=h.adapter.requestSnapshot(),n=h.provided();const bad=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:id,reason}});expect((await bad.result).status).toBe(400);expect(h.provided()).toBe(n);expect(h.adapter.requestSnapshot()).toEqual(snapshot)}
    for(const [i,reason] of ['😀'.repeat(255)+'abc','😀'.repeat(256)].entries()){const target=i===0?id:'second',call=i===0?active:h.invoke(sid,target);if(i)await call.result;const cancel=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:target,reason}});expect((await cancel.result).status).toBe(202);cancel.finish();call.handler();call.finish();await quotaFlush()}
    for(const [initId,status] of [[0,200],['😀'.repeat(32),200],['😀'.repeat(32)+'a',400]] as const){const n=h.provided(),init=h.invoke(undefined,initId,'initialize');expect((await init.result).status).toBe(status);init.finish();if(status===400)expect(h.provided()).toBe(n)}
    h.adapter.shutdown();await quotaFlush()
  })
  it('R1_T_phase_matrix_is_adapter_only',async()=>{
    expect(['adapter','rpc','quota','get','ttl','restart','init','auth',''].map(isPendingAdapterPhase)).toEqual([true,false,false,false,false,false,false,false,false])
  })

  it('Q_missing_handler_receipt_safe_501_no_dispatch',async()=>{
    const h=quotaHarness(true),sid=await h.session(),before=h.provided()
    const call=h.invoke(sid,1,'tools/list'),response=await call.result
    expect(response.status).toBe(501);expect([...response.headers]).toEqual([['content-type','application/json']])
    const bytes=await response.text();expect(bytes).toBe(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:'handler_receipt_unavailable',data:{code:'handler_receipt_unavailable'}}}))
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(256);expect(bytes).not.toContain('private-credential');expect(h.provided()).toBe(before)
    expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:0,control:0,charged:0});call.finish();h.adapter.shutdown();await quotaFlush()
  })

  it('Q_four_session_thirtytwo_global_no_queue_and_two_end_receipts',async()=>{
    const h=quotaHarness(),sids:string[]=[],calls:any[]=[]
    for(let i=0;i<9;i++)sids.push(await h.session())
    for(const sid of sids.slice(0,8))for(let id=1;id<=4;id++){const c=h.invoke(sid,id);expect((await c.result).status).toBe(200);calls.push(c)}
    expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:32,control:0})
    expect((await h.invoke(sids[0],5).result).status).toBe(503);expect((await h.invoke(sids[8],1).result).status).toBe(503)
    calls[0].finish();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(32)
    calls[0].handler();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(31)
    calls[1].handler();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(31)
    calls[1].finish();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(30)
    calls.forEach(c=>{c.handler();c.finish()});await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(0)
  })
  it('Q_control_two_session_eight_global_separate_from_ordinary',async()=>{
    const h=quotaHarness(),sids=await Promise.all(Array.from({length:5},()=>h.session())),controls:any[]=[]
    const rpc=Array.from({length:4},(_,i)=>h.invoke(sids[0],i+1));await Promise.all(rpc.map(c=>c.result))
    for(const sid of sids.slice(0,4))for(let i=0;i<2;i++){const c=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:999}});expect((await c.result).status).toBe(202);controls.push(c)}
    expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:4,control:8})
    expect((await h.invoke(sids[0],undefined,'notifications/initialized').result).status).toBe(503)
    expect((await h.invoke(sids[4],undefined,'notifications/cancelled',{params:{requestId:999}}).result).status).toBe(503)
    controls.forEach(c=>c.finish());rpc.forEach(c=>{c.handler();c.finish()});await quotaFlush();expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:0,control:0})
  })
  it('Q_typed_ids_duplicate_zero_empty_and_lifetime256',async()=>{
    const h=quotaHarness(),sid=await h.session()
    for(const id of [0,''])expect((await h.invoke(sid,id).result).status).toBe(400)
    const a=h.invoke(sid,1),b=h.invoke(sid,'1');expect((await a.result).status).toBe(200);expect((await b.result).status).toBe(200)
    expect((await h.invoke(sid,1).result).status).toBe(409);a.handler();a.finish();b.handler();b.finish();await quotaFlush()
    expect((await h.invoke(sid,1).result).status).toBe(409)
    for(let id=2;id<=254;id++){const c=h.invoke(sid,id);expect((await c.result).status).toBe(200);c.handler();c.finish();await quotaFlush()}
    expect(h.adapter.requestSnapshot().distinctIds).toBe(256)
    expect((await h.invoke(sid,255).result).status).toBe(503)
  })
  it('Q_unknown_completed_repeat_cancel_no_forward_and_wrong_identity',async()=>{
    const h=quotaHarness(),sid=await h.session(),c=h.invoke(sid,1);await c.result
    const before=h.provided();const wrong=h.invoke(sid,undefined,'notifications/cancelled',{token:'B',params:{requestId:1}});expect((await wrong.result).status).toBe(404);expect(h.provided()).toBe(before)
    for(const id of [999,1,1]){const cancel=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:id}});expect((await cancel.result).status).toBe(202);cancel.finish();await quotaFlush()}
    expect(h.provided()).toBe(before+1);c.handler();c.finish();await quotaFlush()
    const done=h.invoke(sid,undefined,'notifications/cancelled',{params:{requestId:1}});expect((await done.result).status).toBe(202);done.finish();await quotaFlush();expect(h.provided()).toBe(before+1)
    expect(h.adapter.requestSnapshot().distinctIds).toBe(2)
  })
  it('Q_exact_65535_65536_65537_and_delete_control_capacity',async()=>{
    const h=quotaHarness(),sid=await h.session()
    const overhead=Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{},padding:''}))
    for(const [id,size] of [[1,65535],[2,65536],[3,65537]] as const){
      const c=h.invoke(sid,id,'tools/call',{padding:size-overhead});expect((await c.result).status).toBe(size>65536?413:200);c.handler();c.finish();await quotaFlush()
    }
    const first=h.invoke(sid,undefined,'notifications/initialized'),second=h.invoke(sid,undefined,'notifications/initialized');await first.result;await second.result
    expect((await h.invoke(sid,undefined,'DELETE',{delete:true}).result).status).toBe(503)
    first.finish();second.finish();await quotaFlush()
  })
  it('Q_ordinary64KiB_and_shutdown_does_not_release_unfinished_handler',async()=>{
    const h=quotaHarness(),sid=await h.session();const c=h.invoke(sid,1,'tools/call',{padding:60000});expect((await c.result).status).toBe(200)
    c.finish();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(false);expect(h.adapter.requestSnapshot().ordinary).toBe(1)
    c.handler();await quotaFlush();expect(h.adapter.requestSnapshot().ordinary).toBe(0)
  })
})

function lifecycleHarness(options:{pending?:boolean;cleanup?:'reject'|'never';standaloneFailure?:boolean;authRecheck?:boolean;detachThrow?:boolean;alreadyClosed?:boolean;authIndividual?:boolean;factoryReject?:boolean;borrow?:boolean;wrapping?:'close-set'|'connect-get'|'close-get'}={}) {
  let time=0,next=0,sidNumber=0,epoch=1,closes=0,transportCloses=0,cleanups=0,standaloneCloses=0,providers=0,factories=0,connects=0,registrations=0,detachCalls=0
  let borrowed:any
  const timers=new Map<number,{at:number;fn:()=>void}>(),factoryGate=admissionDeferred<void>(),cleanupGate=admissionDeferred<void>(),authGate=admissionDeferred<void>()
  const clock={now:()=>time,setTimeout(fn:()=>void,delay:number){const id=++next;timers.set(id,{at:time+delay,fn});return id},clearTimeout(id:unknown){timers.delete(id as number)}}
  const adapter=createActualSessionInitializationTransport<any,any>({
    lifecycleClock:clock,
    authenticate:async e=>{e.auths=(e.auths??0)+1;if(options.authRecheck&&e.auths===2)await authGate.promise;if(options.authIndividual&&e.auths===2)await e.authGate.promise;return {kind:'authorized',epoch:e.epoch??epoch,principal:e.principal??'A'}},
    replay:async(e,request,run)=>{e.request=request;return run(e)},
    factory:async()=>{factories++;if(options.pending)await factoryGate.promise;if(options.factoryReject)throw new Error('private factory failure');if(options.borrow&&borrowed)return borrowed;const owner:any={connect:async()=>{connects++},close:async()=>{closes++}};borrowed=owner;
      if(options.wrapping==='close-set')Object.defineProperty(owner,'close',{value:owner.close,writable:false});
      if(options.wrapping==='connect-get')Object.defineProperty(owner,'connect',{get(){throw new Error('private getter')}});
      if(options.wrapping==='close-get')Object.defineProperty(owner,'close',{get(){throw new Error('private getter')}});
      return owner},
    provider:async(factory,e)=>{providers++;if(!e.sid){const owner=factory(),connection={sessionId:undefined as string|undefined,close:async()=>{transportCloses++},closeStandaloneSSEStream(){standaloneCloses++;if(options.standaloneFailure)throw new Error('private close failure')},closeSSEStream(){}};await owner.connect(connection);connection.sessionId='life-'+(++sidNumber);e.owner=owner;return new Response('{}',{headers:{'mcp-session-id':connection.sessionId}})}return new Response(null,{status:e.method?.startsWith('notifications/')?202:200})},
    adopted:e=>e.owner,handlerFinished:e=>e.handler.promise,
    cleanupSession:async()=>{cleanups++;if(options.cleanup==='reject')throw new Error('private credential');if(options.cleanup==='never')await cleanupGate.promise;return {empty:true}},
  })
  function invoke(sid:string|undefined,id:any,method='tools/call',extra:{http?:string;principal?:string;epoch?:number;target?:any;detachBeforeThrow?:boolean;registration?:string}={}) {
    const authGate=admissionDeferred<void>()
    const handler=admissionDeferred<{finished:true}>(),response=admissionDeferred<{finished:true}>(),body=JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params:{requestId:extra.target}}),bytes=new TextEncoder().encode(body),headers=new Headers({authorization:'Bearer secret','content-length':String(bytes.length),...(sid?{'mcp-session-id':sid}:{})})
    const peer=controlledPeer();if(options.alreadyClosed)peer.close()
    const event={sid,method,handler,authGate,...extra};const input={method:extra.http??'POST',url:'http://unit/life',headers,rawHeaders:[...headers] as Array<[string,string]>,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);c.close()}}),...peer,subscribeClosed:(listener:()=>void):any=>{registrations++;
      if(extra.registration==='throw-before-register')throw new Error('registration unknown');
      const detach=peer.subscribeClosed(listener);
      if(extra.registration?.startsWith('shutdown-'))adapter.shutdown();
      if(extra.registration==='notify-throw'||extra.registration==='notify-success')listener();
      if(extra.registration==='register-throw'||extra.registration==='shutdown-throw')throw new Error('partial registration');
      if(extra.registration==='register-undefined'||extra.registration==='shutdown-invalid')return undefined;
      if(extra.registration==='register-number')return 42;
      return ()=>{detachCalls++;if(extra.detachBeforeThrow||extra.registration==='notify-throw')throw new Error('detach before removal');detach();if(options.detachThrow)throw new Error('private detach failure')}},responseFinished:response.promise,terminate(){}}
    return {peer,releaseAuth:()=>authGate.resolve(),result:adapter.handle(event,input),handler:()=>handler.resolve({finished:true}),finish:()=>response.resolve({finished:true}),rejectReceipt:()=>response.reject(new Error('private receipt failure'))}
  }
  return {adapter,invoke,clock,timers,factoryGate,cleanupGate,authGate,setTimeWithoutTimers:(value:number)=>{time=value},setEpoch:(value:number)=>{epoch=value},counts:()=>({closes,transportCloses,cleanups,standaloneCloses,providers,factories,connects,registrations,detachCalls}),
    async advance(ms:number){time+=ms;for(const [id,t] of [...timers])if(t.at<=time){timers.delete(id);t.fn()}await quotaFlush()},
    async session(){const c=invoke(undefined,0,'initialize');const response=await c.result;c.finish();expect(response.status).toBe(200);return response.headers.get('mcp-session-id')!}}
}

describe('L_get_ttl_lifecycle_pure',()=>{
  it.each(['notify-throw','register-throw','register-undefined','register-number','throw-before-register'])('R3_registration_failure_%s_retains64',async registration=>{
    const h=lifecycleHarness(),peers=[]
    for(let i=0;i<64;i++){const c=h.invoke(undefined,0,'initialize',{registration});expect((await c.result).status).toBe(503);peers.push(c.peer);expect(c.peer.observerCount()).toBe(registration==='throw-before-register'?0:1);expect(h.adapter.snapshot()).toMatchObject({closing:i+1,total:i+1});expect(h.adapter.lifecycleSnapshot().retained).toBe(i+1)}
    const denied=h.invoke(undefined,0,'initialize',{registration});expect((await denied.result).status).toBe(503);expect(denied.peer.observerCount()).toBe(0);expect(h.counts()).toMatchObject({registrations:64,factories:0,providers:0,connects:0,closes:0,detachCalls:registration==='notify-throw'?64:0});expect(h.adapter.shutdown()).toMatchObject({complete:false,closing:64,total:64});expect(h.adapter.lifecycleSnapshot().timers).toBe(0)
    expect(peers.reduce((n,p)=>n+p.observerCount(),0)).toBe(registration==='throw-before-register'?0:64);for(const peer of peers)peer.close();expect(h.adapter.shutdown().total).toBe(64);expect(h.counts().registrations).toBe(64)
  })
  it('R3_sync_notify_success_detaches_once_factory_zero',async()=>{
    const h=lifecycleHarness();for(let i=0;i<80;i++){const c=h.invoke(undefined,0,'initialize',{registration:'notify-success'});expect((await c.result).status).toBe(503);expect(c.peer.observerCount()).toBe(0);expect(h.adapter.snapshot().total).toBe(0);c.peer.close();c.peer.close()}
    expect(h.counts()).toMatchObject({registrations:80,detachCalls:80,factories:0,providers:0,closes:0});expect(h.adapter.shutdown().complete).toBe(true)
  })
  it.each(['shutdown-success','shutdown-throw','shutdown-invalid'])('R3_registration_reentrant_%s',async registration=>{
    const h=lifecycleHarness(),c=h.invoke(undefined,0,'initialize',{registration});expect((await c.result).status).toBe(503);const failed=registration!=='shutdown-success';expect(c.peer.observerCount()).toBe(failed?1:0);expect(h.adapter.shutdown()).toMatchObject({complete:!failed,total:failed?1:0,closing:failed?1:0,accepting:false});expect(h.counts()).toMatchObject({registrations:1,detachCalls:failed?0:1,factories:0,providers:0,closes:0});const denied=h.invoke(undefined,0,'initialize');expect((await denied.result).status).toBe(503);expect(h.counts().registrations).toBe(1);c.peer.close()
  })
  it('R3_partial_registration_never_acquires_or_closes_foreign_owner',async()=>{
    const h=lifecycleHarness({borrow:true}),sid=await h.session(),c=h.invoke(undefined,0,'initialize',{registration:'register-throw'});expect((await c.result).status).toBe(503);expect(c.peer.observerCount()).toBe(1);expect(h.counts()).toMatchObject({factories:1,providers:1,connects:1,closes:0});expect(h.adapter.snapshot()).toMatchObject({ready:1,closing:1,total:2});const call=h.invoke(sid,1);expect((await call.result).status).toBe(200);call.handler();call.finish();const del=h.invoke(sid,undefined,'DELETE',{http:'DELETE'});expect((await del.result).status).toBe(204);del.finish();await quotaFlush();expect(h.counts().closes).toBe(1);expect(h.adapter.shutdown()).toMatchObject({complete:false,total:1,closing:1});c.peer.close();expect(h.counts().closes).toBe(1)
  })

  it.each(['release','timeout','disconnect'] as const)('R2_auth_eight_concurrent_ninth_rejected_%s',async mode=>{
    const h=lifecycleHarness({authIndividual:true});const calls=Array.from({length:8},()=>h.invoke(undefined,0,'initialize'))
    await quotaFlush();expect(h.counts()).toMatchObject({factories:8,connects:8,providers:8});expect(h.adapter.snapshot().ready).toBe(8)
    const ninth=h.invoke(undefined,0,'initialize');expect((await ninth.result).status).toBe(503);expect(h.counts()).toMatchObject({factories:8,connects:8,providers:8})
    if(mode==='release'){calls[0]!.releaseAuth();expect((await calls[0]!.result).status).toBe(200);calls[0]!.finish()}
    if(mode==='disconnect'){calls[0]!.peer.close();await quotaFlush();expect(h.counts().closes).toBe(1)}
    if(mode==='timeout'){await h.advance(5000);expect(h.counts().closes).toBe(8)}
    const next=h.invoke(undefined,0,'initialize');await quotaFlush();expect(h.counts().factories).toBe(9);expect(h.counts().providers).toBe(9)
    for(const c of [...calls,next]){c.releaseAuth();const response=await c.result;expect(response.status).toBe(mode==='timeout'&&c!==next||mode==='disconnect'&&c===calls[0]?503:200);c.finish();expect(c.peer.observerCount()).toBe(0)}
    h.adapter.shutdown();await quotaFlush();expect(h.adapter.snapshot().total).toBe(0)
  })
  it('R2_factory_reject_detach_before_removal_is_bounded64',async()=>{
    const h=lifecycleHarness({factoryReject:true});const observers=[]
    for(let i=0;i<64;i++){const c=h.invoke(undefined,0,'initialize',{detachBeforeThrow:true});expect((await c.result).status).toBe(503);observers.push(c.peer);expect(c.peer.observerCount()).toBe(1);expect(h.adapter.snapshot()).toMatchObject({closing:i+1,total:i+1})}
    const extra=h.invoke(undefined,0,'initialize',{detachBeforeThrow:true});expect((await extra.result).status).toBe(503);expect(extra.peer.observerCount()).toBe(0);expect(h.counts()).toMatchObject({factories:64,providers:0,closes:0});expect(h.adapter.shutdown().complete).toBe(false)
    expect(observers.reduce((n,p)=>n+p.observerCount(),0)).toBe(64);for(const p of observers)p.close();expect(h.adapter.snapshot().total).toBe(64);expect(h.counts().factories).toBe(64)
  })
  it('R2_factory_reject_successful_detach_and_close_races_once',async()=>{
    for(const mode of ['normal','closed','alreadyclosed']){const h=lifecycleHarness({factoryReject:true,pending:true,alreadyClosed:mode==='alreadyclosed'}),c=h.invoke(undefined,0,'initialize');await quotaFlush();if(mode==='closed'){c.peer.close();c.peer.close()}h.factoryGate.resolve();expect((await c.result).status).toBe(503);expect(c.peer.observerCount()).toBe(0);expect(h.adapter.snapshot().total).toBe(0);expect(h.counts()).toMatchObject({factories:mode==='alreadyclosed'?0:1,providers:0,closes:0});expect(h.adapter.shutdown().complete).toBe(true)}
  })
  it.each([false,true])('R2_foreign_owner_detach_failure_%s_preserves_first',async fail=>{
    const h=lifecycleHarness({borrow:true}),sid=await h.session(),second=h.invoke(undefined,0,'initialize',{detachBeforeThrow:fail});expect((await second.result).status).toBe(503);expect(second.peer.observerCount()).toBe(fail?1:0);expect(h.counts()).toMatchObject({factories:2,connects:1,providers:1,closes:0});expect(h.adapter.snapshot()).toMatchObject({ready:1,closing:fail?1:0,total:fail?2:1})
    const ordinary=h.invoke(sid,1);expect((await ordinary.result).status).toBe(200);ordinary.handler();ordinary.finish();const del=h.invoke(sid,undefined,'DELETE',{http:'DELETE'});expect((await del.result).status).toBe(204);del.finish();await quotaFlush();expect(h.counts().closes).toBe(1);expect(h.adapter.snapshot().total).toBe(fail?1:0);expect(h.adapter.shutdown().complete).toBe(!fail);expect(h.counts().closes).toBe(1);second.peer.close()
  })
  it.each(['close-set','connect-get','close-get'] as const)('R2_owned_public_method_wrapping_failure_%s',async wrapping=>{
    const h=lifecycleHarness({wrapping}),c=h.invoke(undefined,0,'initialize');expect((await c.result).status).toBe(wrapping==='close-get'?503:500);expect(c.peer.observerCount()).toBe(0);expect(h.counts()).toMatchObject({factories:1,providers:0,closes:wrapping==='close-get'?0:1});expect(h.adapter.snapshot().total).toBe(wrapping==='close-get'?1:0);expect(h.adapter.shutdown().complete).toBe(wrapping!=='close-get')
  })

  it('R1_deadline_at_publication_when_timer_delayed_during_auth',async()=>{
    const h=lifecycleHarness({authRecheck:true}),init=h.invoke(undefined,0,'initialize');await quotaFlush();expect(h.adapter.snapshot().ready).toBe(1)
    h.setTimeWithoutTimers(5000);h.authGate.resolve();expect((await init.result).status).toBe(503);await quotaFlush()
    expect(h.adapter.snapshot().total).toBe(0);expect(init.peer.observerCount()).toBe(0);expect(h.counts().closes).toBe(1)
  })
  it('R1_auth_recheck_timer_retires_then_late_auth_never_publishes',async()=>{
    const h=lifecycleHarness({authRecheck:true}),init=h.invoke(undefined,0,'initialize');await quotaFlush();await h.advance(5000)
    expect(h.counts().closes).toBe(1);h.authGate.resolve();expect((await init.result).status).toBe(503);expect(init.peer.observerCount()).toBe(0)
  })
  it('R1_already_closed_no_factory_and_detach_failure_retires',async()=>{
    const h=lifecycleHarness({alreadyClosed:true}),init=h.invoke(undefined,0,'initialize');expect((await init.result).status).toBe(503);expect(h.counts().providers).toBe(0);expect(h.adapter.snapshot().total).toBe(0)
    const b=lifecycleHarness({detachThrow:true}),bad=b.invoke(undefined,0,'initialize');expect((await bad.result).status).toBe(503);await quotaFlush();expect(b.counts().closes).toBe(1);expect(b.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(bad.peer.observerCount()).toBe(0)
  })
  it('R1_pending_disconnect_late_factory_no_publish',async()=>{
    const h=lifecycleHarness({pending:true}),init=h.invoke(undefined,0,'initialize');await quotaFlush();init.peer.close();expect(h.adapter.snapshot().closing).toBe(1)
    h.factoryGate.resolve();expect((await init.result).status).toBe(503);await quotaFlush();expect(h.adapter.snapshot().total).toBe(0);expect(init.peer.observerCount()).toBe(0)
  })
  it('R1_repeated_initialize_delete_detaches_observers',async()=>{
    const h=lifecycleHarness()
    for(let i=0;i<80;i++){const init=h.invoke(undefined,0,'initialize'),response=await init.result;expect(response.status).toBe(200);expect(init.peer.observerCount()).toBe(0);init.finish();const sid=response.headers.get('mcp-session-id')!;const del=h.invoke(sid,undefined,'DELETE',{http:'DELETE'});expect((await del.result).status).toBe(204);del.finish();await quotaFlush();expect(h.adapter.snapshot().total).toBe(0)}
  })

  it('L_get_one_eight_identity_and_response_receipt',async()=>{
    const h=lifecycleHarness(),sids:string[]=[],streams:any[]=[];for(let i=0;i<9;i++)sids.push(await h.session())
    for(const sid of sids.slice(0,8)){const c=h.invoke(sid,undefined,'GET',{http:'GET'});expect((await c.result).status).toBe(200);streams.push(c)}
    expect(h.adapter.lifecycleSnapshot().streams).toBe(8)
    expect((await h.invoke(sids[0],undefined,'GET',{http:'GET'}).result).status).toBe(409)
    expect((await h.invoke(sids[8],undefined,'GET',{http:'GET'}).result).status).toBe(503)
    expect((await h.invoke(sids[0],undefined,'GET',{http:'GET',principal:'B'}).result).status).toBe(404)
    streams[0].finish();await quotaFlush();expect(h.adapter.lifecycleSnapshot().streams).toBe(7)
    const replacement=h.invoke(sids[8],undefined,'GET',{http:'GET'});expect((await replacement.result).status).toBe(200)
    expect(h.adapter.shutdown().complete).toBe(false);expect(h.timers.size).toBe(0)
    for(const c of streams)c.finish();replacement.finish();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true)
  })
  it('L_get_is_independent_of_full_ordinary_and_control',async()=>{
    const h=lifecycleHarness(),sids:string[]=[],calls:any[]=[];for(let i=0;i<9;i++)sids.push(await h.session())
    for(const sid of sids.slice(0,8))for(let id=1;id<=4;id++){const c=h.invoke(sid,id);await c.result;calls.push(c)}
    for(const sid of sids.slice(0,4))for(let i=0;i<2;i++){const c=h.invoke(sid,undefined,'notifications/cancelled',{target:999});await c.result;calls.push(c)}
    const get=h.invoke(sids[0],undefined,'GET',{http:'GET'});expect((await get.result).status).toBe(200);expect(h.adapter.requestSnapshot()).toMatchObject({ordinary:32,control:8});expect(h.adapter.lifecycleSnapshot().streams).toBe(1)
    for(const c of calls){c.handler();c.finish()}get.finish();await quotaFlush();h.adapter.shutdown();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true)
  })
  for(const method of ['GET','notifications/initialized','notifications/cancelled'])it('L_eligible_'+method.replaceAll('/','_')+'_touches_idle',async()=>{
    const h=lifecycleHarness(),sid=await h.session();const rpc=h.invoke(sid,1);await rpc.result
    await h.advance(299999);const c=h.invoke(sid,undefined,method,{http:method==='GET'?'GET':undefined,target:1});expect((await c.result).status).toBe(method==='GET'?200:202);c.finish();rpc.handler();rpc.finish();await quotaFlush()
    await h.advance(1);expect(h.adapter.snapshot().ready).toBe(1);await h.advance(299999);expect(h.adapter.snapshot().total).toBe(0)
  })
  for(const failure of ['close','receipt','never'] as const)it('L_GET_'+failure+'_retains_stream_and_closing',async()=>{
    const h=lifecycleHarness({standaloneFailure:failure==='close'}),sid=await h.session(),get=h.invoke(sid,undefined,'GET',{http:'GET'});expect((await get.result).status).toBe(200)
    if(failure==='close')get.finish();if(failure==='receipt')get.rejectReceipt();await quotaFlush()
    expect(h.adapter.lifecycleSnapshot().streams).toBe(1);expect(h.adapter.shutdown().complete).toBe(false);await quotaFlush();expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(h.timers.size).toBe(0)
  })
  it('L_idle_before_exact_after_and_session_isolation',async()=>{
    const h=lifecycleHarness(),a=await h.session();await h.advance(100000);const b=await h.session()
    await h.advance(199999);expect(h.adapter.snapshot().ready).toBe(2)
    await h.advance(1);expect(h.adapter.snapshot().ready).toBe(1);expect(h.counts().closes).toBe(1)
    expect((await h.invoke(a,1).result).status).toBe(404)
    await h.advance(1);const c=h.invoke(b,1);expect((await c.result).status).toBe(200);c.handler();c.finish();await quotaFlush();h.adapter.shutdown();await quotaFlush()
    expect(h.adapter.snapshot().total).toBe(0);expect(h.timers.size).toBe(0)
  })
  it('L_eligible_activity_extends_idle_but_absolute_is_fixed',async()=>{
    const h=lifecycleHarness(),sid=await h.session()
    for(let id=1;id<=17;id++){await h.advance(100000);const c=h.invoke(sid,id);expect((await c.result).status).toBe(200);c.handler();c.finish();await quotaFlush()}
    await h.advance(99999);expect(h.adapter.snapshot().ready).toBe(1)
    await h.advance(1);expect(h.adapter.snapshot().total).toBe(0);expect(h.counts().closes).toBe(1)
    expect((await h.invoke(sid,18).result).status).toBe(404)
  })
  it('L_unknown_completed_repeat_and_wrong_identity_do_not_touch',async()=>{
    const h=lifecycleHarness(),sid=await h.session(),active=h.invoke(sid,1);await active.result
    const cancel=h.invoke(sid,undefined,'notifications/cancelled',{target:1});expect((await cancel.result).status).toBe(202);cancel.finish();active.handler();active.finish();await quotaFlush()
    await h.advance(299999)
    for(const target of [1,999]){const c=h.invoke(sid,undefined,'notifications/cancelled',{target});expect((await c.result).status).toBe(202);c.finish()}
    expect((await h.invoke(sid,2,'tools/call',{principal:'B'}).result).status).toBe(404)
    await h.advance(1);expect(h.adapter.snapshot().total).toBe(0);expect(h.counts().closes).toBe(1)
  })
  it('L_epoch_ABA_callback_contract_never_retires_owner',async()=>{
    const h=lifecycleHarness(),sid=await h.session();h.setEpoch(2);expect((await h.invoke(sid,1).result).status).toBe(404);h.setEpoch(3);expect((await h.invoke(sid,1).result).status).toBe(404)
    expect(h.counts().closes).toBe(0);expect(h.adapter.snapshot().ready).toBe(1)
    h.adapter.shutdown();await quotaFlush();expect(h.adapter.snapshot().total).toBe(0)
  })
  it('L_pending_expiry_late_factory_cleans_without_publish',async()=>{
    const h=lifecycleHarness({pending:true}),init=h.invoke(undefined,0,'initialize');await quotaFlush();expect(h.adapter.snapshot().pending).toBe(1)
    await h.advance(4999);expect(h.adapter.snapshot().pending).toBe(1);await h.advance(1);expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(h.adapter.lifecycleSnapshot().timers).toBe(0)
    h.factoryGate.resolve();expect((await init.result).status).toBe(503);init.finish();await quotaFlush();expect(h.counts().closes).toBe(1);expect(h.counts().providers).toBe(0);expect(h.adapter.snapshot().total).toBe(0)
  })
  it('L_never_factory_bounded_shutdown_stops_new_admission',async()=>{
    const h=lifecycleHarness({pending:true});for(let i=0;i<8;i++)void h.invoke(undefined,i,'initialize').result
    await quotaFlush();await h.advance(5000);expect(h.adapter.snapshot()).toMatchObject({closing:8,total:8});expect(h.adapter.shutdown().complete).toBe(false);expect(h.timers.size).toBe(0)
    expect((await h.invoke(undefined,9,'initialize').result).status).toBe(503);expect(h.adapter.snapshot().total).toBe(8)
  })
  it('L_expiry_ordinary_get_receipts_hold_charge_and_late_reconcile',async()=>{
    const h=lifecycleHarness(),sid=await h.session(),rpc=h.invoke(sid,1),get=h.invoke(sid,undefined,'GET',{http:'GET'});await rpc.result;await get.result
    await h.advance(300000);expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(h.counts()).toMatchObject({closes:1,transportCloses:1,cleanups:1,standaloneCloses:1})
    rpc.finish();get.finish();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(false)
    rpc.handler();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true);expect(h.adapter.requestSnapshot().charged).toBe(0);expect(h.adapter.lifecycleSnapshot()).toEqual({streams:0,timers:0,retained:0})
  })
  for(const failure of ['reject','never'] as const)it('L_cleanup_'+failure+'_retains_charge',async()=>{
    const h=lifecycleHarness({cleanup:failure});await h.session();await h.advance(300000)
    expect(h.adapter.snapshot()).toMatchObject({closing:1,total:1});expect(h.adapter.shutdown().complete).toBe(false);expect(h.timers.size).toBe(0)
    expect(JSON.stringify(h.adapter.lifecycleSnapshot())).not.toContain('secret')
    if(failure==='never'){h.cleanupGate.resolve();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true)}
  })
  it('L_delete_expiry_shutdown_once_close_without_self_deadlock',async()=>{
    const h=lifecycleHarness(),sid=await h.session(),del=h.invoke(sid,undefined,'DELETE',{http:'DELETE'})
    await quotaFlush();await h.advance(300000);expect((await del.result).status).toBe(204)
    expect(h.adapter.shutdown().complete).toBe(false);expect(h.adapter.snapshot().total).toBe(1)
    del.finish();await quotaFlush();expect(h.adapter.shutdown().complete).toBe(true);expect(h.counts()).toMatchObject({closes:1,transportCloses:1,cleanups:1})
    expect((await h.invoke(sid,undefined,'DELETE',{http:'DELETE'}).result).status).toBe(404)
  })
})
