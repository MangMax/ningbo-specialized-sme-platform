// Research-only, synthetic inputs. Never open an app/source/production database.
// Run: SPIKE_REPO=/checkout/with/dependencies node docs/spikes/222/probe.mjs NEW_OUT
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, writeSync, readSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const self = fileURLToPath(import.meta.url), here = dirname(self)
const repo = resolve(process.env.SPIKE_REPO || '.')
const req = createRequire(join(repo, 'package.json'))
const Database = req('better-sqlite3')
const [mode, out, caseId] = process.argv.slice(2)
const hash = b => createHash('sha256').update(b).digest('hex')
const CHUNK = 4096
const memory = () => ({ ...process.memoryUsage(), maxRSSKiB: process.resourceUsage().maxRSS })
const priorSix = [
  ['escaped-unicode', '{"s":"\\u0061"}'],
  ['integer-key-order', '{"10":"ten","2":"two","x":1}'],
  ['duplicate-keys', '{"x":1,"x":2}'],
  ['number-spelling', '{"n":1.0,"e":1e+02,"z":-0}'],
  ['rounded-integer', '{"n":9007199254740993}'],
  ['lone-surrogate', '{"s":"\\uD800"}'],
]
function fixtures() {
  const rows = [
    ...priorSix,
    ['canonical', JSON.stringify({s:'中文😀\n\0', a:[1,true,null], o:{x:'y'}})],
    ['sql-null', null], ['json-null', 'null'], ['empty-object', '{}'], ['empty-array','[]'],
    ['array-nested','[{"10":0,"2":1,"a":1,"b":2,"a":3},null,[true,"x"]]'],
    ['string-primitive','"\\u0061\\n"'], ['boolean-primitive','true'], ['number-primitive','-0'],
    ['duplicate-position-subtree','{"a":{"old":1},"b":2,"a":{"10":1,"2":2},"c":3}'],
    ['escaped-equal-key','{"a":1,"b":2,"\\u0061":3}'],
    ['index-limits','{"4294967295":0,"4294967294":1,"01":2,"0":3,"-0":4,"00":5,"1e0":6,"2":7}'],
    ['nul-keys','{"a\\u0000b":1,"a":2,"a\\u0000c":3,"a\\u0000b":4}'],
    ['special-keys','{"__proto__":1,"constructor":2,"a.b":3,"a\\\"b":4,"":5}'],
    ['surrogate-keys','{"\\ud800":1,"😀":2,"\\ud83d\\ude00":3,"\\udc00":4}'],
    ['surrogates','["\\uD800","\\uDC00","\\ud800\\ud800\\udc00","\\ud83d\\ude00","\\u2028\\u2029","\\ufffd"]'],
    ['all-controls',JSON.stringify(Array.from({length:32},(_,i)=>String.fromCharCode(i)).join('')+'"\\/中文😀')],
    ['numeric-limits','[9007199254740991,9007199254740992,9007199254740993,9223372036854775807,9223372036854775808,1e400,-1e400,1e-400,-1e-400,5e-324,2.2250738585072012e-308,1.7976931348623157e308,1e21,1e20,1e-6,1e-7,-0]'],
    ['decimal-rounding','{"n":6.2305092907852181816129614949256e-271}'],
    ['decimal-rounding-2','2.7092189618903812789494983e-44'],
    ['long-number','1.'+'0'.repeat(65536)+'1'],
    ['long-exponent','1e'+'0'.repeat(65536)+'1'],
    ...[64,999,1000,1001,2000].map(n=>['depth-'+n,'['.repeat(n)+'0'+']'.repeat(n)]),
    ['chunk-split-utf8',JSON.stringify('x'.repeat(CHUNK-1)+'😀'+'y'.repeat(CHUNK-2)+'中文')],
    ['chunk-split-surrogate','"'+'x'.repeat(CHUNK-3)+'\\ud800\\ud800\\udc00'+'y'.repeat(CHUNK)+'"'],
    ...[65536,1048576,4194304].flatMap(n=>[
      ['large-scalar-'+n,JSON.stringify({s:'x'.repeat(n-4)+'中文😀'})],
      ['large-key-'+n,JSON.stringify({['k'.repeat(n)]:1,z:2})],
      ['escape-expansion-'+n,JSON.stringify({s:'\0\u0001\u0002'.repeat(Math.ceil(n/3)).slice(0,n)})],
    ]),
  ]
  return rows.map(([name, source],id)=>({id:id+1,name,source}))
}
function child(which, dir, id='') {
  const r=spawnSync(process.execPath,[self,which,dir,String(id)],{encoding:'utf8',maxBuffer:2*1024*1024})
  writeFileSync(join(dir,`${which}-${id||'all'}.log`),r.stdout+r.stderr)
  assert.equal(r.status,0,`${which}/${id}: ${r.stderr}`)
  const value=JSON.parse(r.stdout)
  value.replyBytes=Buffer.byteLength(r.stdout)
  return value
}
function bytesEqual(a,b) {
  const fa=openSync(a,'r'),fb=openSync(b,'r'),ba=Buffer.alloc(65536),bb=Buffer.alloc(65536)
  try { for(;;){const na=readSync(fa,ba),nb=readSync(fb,bb);if(na!==nb||!ba.subarray(0,na).equals(bb.subarray(0,nb)))return false;if(!na)return true} }
  finally {closeSync(fa);closeSync(fb)}
}
if (!['seed','candidate'].includes(mode)) {
  const dest=resolve(mode||'/tmp/spec210-222-repro')
  assert.ok(!existsSync(dest),'Output must not exist: preserve previous evidence')
  mkdirSync(dest,{recursive:true})
  const started=new Date().toISOString()
  const include=join(dirname(req.resolve('better-sqlite3/package.json')),'deps/sqlite3')
  const compile=spawnSync('clang',['-O2','-dynamiclib','-undefined','dynamic_lookup','-I',include,join(here,'sqlite-memory.c'),'-o',join(dest,'spikememory.dylib')],{encoding:'utf8'})
  writeFileSync(join(dest,'compile.log'),compile.stdout+compile.stderr)
  assert.equal(compile.status,0,'measurement extension compilation')
  const manifest=child('seed',dest)
  const results=[]
  for(const item of manifest.cases) {
    const result=child('candidate',dest,item.id)
    const exact=result.error?false:bytesEqual(join(dest,`${item.id}.oracle.bin`),join(dest,`${item.id}.candidate.bin`))
    if(!result.error)assert.equal(exact,result.sha256===item.oracleSHA&&result.bytes===item.oracleBytes)
    assert.ok(result.maxDriverBytes<=65536)
    assert.ok(result.maxUdfBytes<=CHUNK)
    results.push({...item,...result,exactBytes:exact,exactSHA:!result.error&&result.sha256===item.oracleSHA})
  }
  const report={started,finished:new Date().toISOString(),node:process.version,betterSqlite3:req('better-sqlite3/package.json').version,
    cases:results.length,matches:results.filter(x=>x.exactBytes).length,mismatches:results.filter(x=>!x.error&&!x.exactBytes).length,
    errors:results.filter(x=>x.error).length,main:memory(),results}
  writeFileSync(join(dest,'results.json'),JSON.stringify(report,null,2))
  assert.ok(priorSix.every(([n])=>results.find(x=>x.name===n).exactBytes),'all six prior counterexamples handled by partial candidate')
  assert.ok(results.find(x=>x.name==='decimal-rounding').exactBytes===false,'retain numeric incompatibility')
  assert.match(results.find(x=>x.name==='depth-1001').error,/malformed JSON/,'retain depth incompatibility')
  console.log(JSON.stringify({...report,results:undefined},null,2))
} else if(mode==='seed') {
  // Intentionally complete hydration ONLY in the separate synthetic seed/oracle process.
  const d=new Database(join(out,'synthetic.db'))
  d.exec('create table source(id integer primary key, name text, body text)')
  const insert=d.prepare('insert into source values(?,?,?)'),cases=[]
  for(const item of fixtures()) {
    insert.run(item.id,item.name,item.source)
    const canonical=item.source===null?'null':JSON.stringify(JSON.parse(item.source))
    writeFileSync(join(out,`${item.id}.oracle.bin`),canonical)
    writeFileSync(join(out,`${item.id}.source.bin`),item.source??'<SQL NULL>')
    cases.push({id:item.id,name:item.name,sourceBytes:item.source===null?null:Buffer.byteLength(item.source),sourceSHA:hash(item.source??'<SQL NULL>'),oracleBytes:Buffer.byteLength(canonical),oracleSHA:hash(canonical),expected:canonical.length<1024?canonical:undefined})
  }
  const manifest={cases,oracle:memory()};writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));d.close();console.log(JSON.stringify(manifest))
} else {
  // Candidate has no access to source/oracle files or source.text across the driver.
  const d=new Database(join(out,'synthetic.db'),{readonly:true})
  d.loadExtension(join(out,'spikememory.dylib'))
  d.pragma('temp_store = MEMORY') // no algorithmic disk spool
  const start=performance.now();let maxDriverBytes=0,maxUdfBytes=0,maxUdfResultBytes=0,stages=[]
  const memstatusDefaultOff=!!d.prepare("select sqlite_compileoption_used('DEFAULT_MEMSTATUS=0') n").get().n
  const sample=label=>stages.push({label,...memory(),sqliteCurrent:d.prepare('select spike_memory(0) n').get().n,sqlitePeak:d.prepare('select spike_memory(1) n').get().n,
    sqliteCacheBytes:d.prepare('select spike_dbmemory(0) n').get().n,sqliteSchemaBytes:d.prepare('select spike_dbmemory(1) n').get().n,sqliteStatementBytes:d.prepare('select spike_dbmemory(2) n').get().n})
  sample('open');d.prepare('select spike_memory(2)').get()
  // WTF-8/CESU-8 scalar decoding preserves JSON1's lone-surrogate bytes. A UTF-8
  // replacement decoder would lose information. State is <=3 bytes + one UTF16 unit.
  let carry=Buffer.alloc(0), high=''
  d.function('encode_piece',(piece,last)=>{
    assert.ok(Buffer.isBuffer(piece));maxUdfBytes=Math.max(maxUdfBytes,piece.length)
    assert.ok(piece.length<=CHUNK)
    const b=Buffer.concat([carry,piece]);let text=high,i=0
    while(i<b.length){const first=b[i],n=first<128?1:first<224?2:first<240?3:4;if(i+n>b.length)break
      let cp=first&([0,127,31,15,7][n]);for(let k=1;k<n;k++)cp=(cp<<6)|(b[i+k]&63)
      text+=String.fromCodePoint(cp);i+=n
    }
    carry=Buffer.from(b.subarray(i));high=''
    if(!last&&text.length&&text.charCodeAt(text.length-1)>=0xd800&&text.charCodeAt(text.length-1)<=0xdbff){high=text.slice(-1);text=text.slice(0,-1)}
    if(last)assert.equal(carry.length,0,'complete scalar encoding')
    const encoded=JSON.stringify(text).slice(1,-1)
    maxUdfResultBytes=Math.max(maxUdfResultBytes,Buffer.byteLength(encoded))
    return encoded
  })
  // Primitive numbers only; this intentionally exposes SQLite-vs-V8 rounding loss.
  d.function('number_text',n=>JSON.stringify(n))
  const result={id:Number(caseId),maxDriverBytes:0,maxUdfBytes:0,memstatusDefaultOff}
  try {
    d.exec(`create temp table nodes as select j.id,j.parent,j.type,
      cast(j.key as blob) k,case when j.type='text' then cast(j.atom as blob) end a,
      case when j.type in ('integer','real') then number_text(j.atom)
           when j.type in ('true','false','null') then j.type end encoded,
      null key_encoded
      from source s,json_tree(coalesce(s.body,'null')) j where s.id=${Number(caseId)};
      create unique index temp.node_id on nodes(id);
      create index temp.node_parent on nodes(parent);`)
    sample('json_tree')
    // Keep last duplicate value/subtree, but first occurrence's property position.
    // Native BLOB equality includes NUL and does not collapse surrogate code units.
    d.exec(`create temp table member as
      select n.id,n.parent,n.k,min(n.id) over(partition by n.parent,n.k) first_id,
        max(n.id) over(partition by n.parent,n.k) last_id
      from nodes n join nodes p on n.parent=p.id where p.type='object';
      create index temp.member_parent on member(parent);
      create temp table live as
      with recursive reach(id,depth) as (
        select id,0 from nodes where parent is null
        union all select n.id,r.depth+1 from nodes n join reach r on n.parent=r.id
        join nodes p on p.id=r.id
        where p.type='array' or n.id=(select last_id from member where id=n.id)
      ) select * from reach;
      create index temp.live_depth on live(depth);`)
    const encode=(id,column,target)=>{
      carry=Buffer.alloc(0);high=''
      d.prepare(`update nodes set ${target}='"' where id=?`).run(id)
      const len=d.prepare(`select length(${column}) n from nodes where id=?`).get(id).n
      const update=d.prepare(`update nodes set ${target}=${target}||encode_piece(substr(${column},?,?),?) where id=?`)
      for(let pos=0;pos<len;pos+=CHUNK)update.run(pos+1,CHUNK,pos+CHUNK>=len?1:0,id)
      d.prepare(`update nodes set ${target}=${target}||'"' where id=?`).run(id)
    }
    const nextScalar=d.prepare('select n.id,n.type,n.parent from nodes n join live l using(id) where n.id>? order by n.id limit 1')
    for(let node=nextScalar.get(-1);node;node=nextScalar.get(node.id)) {
      const {id,type,parent}=node
      if(type==='text')encode(id,'a','encoded')
      if(parent!==null&&d.prepare('select type from nodes where id=?').get(parent).type==='object')encode(id,'k','key_encoded')
    }
    sample('encoded-scalars')
    // Experiment uses this SQLite build's increasing tree ids as encounter order;
    // upstream documents uniqueness only. This is a portability blocker, not policy.
    const maxDepth=d.prepare('select max(depth) n from live').get().n
    const nextContainer=d.prepare("select n.id,n.type from nodes n join live l using(id) where l.depth=? and n.type in ('object','array') and n.id>? order by n.id limit 1")
    for(let depth=maxDepth;depth>=0;depth--) {
      for(let node=nextContainer.get(depth,-1);node;node=nextContainer.get(depth,node.id)) {
        const {id,type}=node
        const isObject=type==='object'
        const query=isObject?`select n.key_encoded||':'||n.encoded part from nodes n join member m on m.id=n.id join live l on l.id=n.id where n.parent=? order by
          case when length(n.k)<=10 and cast(cast(n.k as text) as integer) between 0 and 4294967294
            and cast(cast(cast(n.k as text) as integer) as text)=cast(n.k as text) then 0 else 1 end,
          case when length(n.k)<=10 and cast(cast(n.k as text) as integer) between 0 and 4294967294
            and cast(cast(cast(n.k as text) as integer) as text)=cast(n.k as text) then cast(cast(n.k as text) as integer) end,m.first_id`
          :'select n.encoded part from nodes n join live l using(id) where n.parent=? order by n.id'
        d.prepare(`update nodes set encoded=?||(select coalesce(group_concat(part,','),'') from (${query}))||? where id=?`).run(isObject?'{':'[',id,isObject?'}':']',id)
      }
    }
    sample('native-complete')
    const root=d.prepare('select id,length(cast(encoded as blob)) bytes from nodes where parent is null').get()
    const get=d.prepare('select substr(cast(encoded as blob),?,65536) b from nodes where id=?')
    const sha=createHash('sha256'),fd=openSync(join(out,`${caseId}.candidate.bin`),'wx')
    try {for(let pos=0;pos<root.bytes;pos+=65536){const {b}=get.get(pos+1,root.id);maxDriverBytes=Math.max(maxDriverBytes,b.length);sha.update(b);writeSync(fd,b)}}finally{closeSync(fd)}
    result.bytes=root.bytes;result.sha256=sha.digest('hex')
    result.nativeTempPages=d.pragma('temp.page_count',{simple:true});result.nativeTempPageSize=d.pragma('temp.page_size',{simple:true})
    sample('hashed');result.sqlite=d.prepare('select sqlite_version() version').get().version
  } catch(e) {result.error=e.message;sample('error')}
  result.maxDriverBytes=maxDriverBytes;result.maxUdfBytes=maxUdfBytes;result.maxUdfResultBytes=maxUdfResultBytes;result.elapsedMs=performance.now()-start;result.stages=stages
  d.close();console.log(JSON.stringify(result))
}
