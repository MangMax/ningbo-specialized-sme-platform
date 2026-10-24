// Synthetic selected-source mechanics only. Never pass an application DB path.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const [mode, rootArg, family, sizeArg, unrelatedArg] = process.argv.slice(2);
const root = resolve(rootArg || '.');
const size = Number(sizeArg), unrelated = Number(unrelatedArg || 0);
const path = join(root,`synthetic-${family}-${size}-${unrelated}.db`);
const sha = value => createHash('sha256').update(value).digest('hex');
const mem = stage => ({stage,...process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS});
function database() { return createRequire(join(process.env.SPIKE_REPO, 'package.json'))('better-sqlite3'); }
function raw(n, escape) { const unit = escape ? '\u0000"\\\n' : 'x'; return unit.repeat(Math.ceil(n/unit.length)).slice(0,n); }
if (mode === 'seed') {
  const Database = database();
  copyFileSync(join(root,'domain-export/domain-synthetic.db'), path);
  const db = new Database(path);
  const body = raw(size,family==='escape');
  db.prepare('update record_event set revision=2 where id=1').run();
  db.prepare('update platform_query set raw_response=?,collection_evidence=? where id=1').run(
    ['raw','escape'].includes(family)?body:'<small>', family==='collection'?JSON.stringify({padding:body}):null);
  db.prepare('update platform_relation set raw_fields=? where id=1').run(family==='fields'?JSON.stringify({padding:body}):null);
  const add = db.prepare("insert into platform_query(interface,query_key,rdjb,queried_at,status,raw_response,created_at) values('business_list',?,'2',?,'success',?,'synthetic')");
  db.transaction(()=>{for(let i=0;i<unrelated;i++) add.run('unrelated/'+i,'unrelated/'+i,'z'.repeat(1024*1024));})();
  db.close();
} else if (mode === 'oracle' || mode === 'sql') {
  const samples = [mem('beforeOpen')];
  const Database = database(); const db = new Database(path);
  db.pragma('cache_size = -2048'); db.pragma('temp_store = FILE');
  samples.push(mem('open'));
  const t = performance.now();
  let digest, bytes, maxDriverBytes=0, chunks=0, copyEqual=null;
  const fieldBytes = db.prepare('select length(cast(raw_response as blob)) raw,length(cast(collection_evidence as blob)) collection from platform_query where id=1').get();
  fieldBytes.fields = db.prepare('select length(cast(raw_fields as blob)) n from platform_relation where id=1').get().n;
  if (mode === 'oracle') {
    // Frozen *real-domain* provenance, independently updated from stored source values.
    const base = JSON.parse(JSON.parse(readFileSync(join(root,'domain-export/domain-differential.json'),'utf8'))[0].legacy);
    const row = db.prepare('select raw_response,collection_evidence from platform_query where id=1').get();
    const fields = db.prepare('select raw_fields from platform_relation where id=1').get().raw_fields;
    base.event.revision=2; base.query.rawResponse=row.raw_response;
    base.query.collectionEvidence=row.collection_evidence===null?null:JSON.parse(row.collection_evidence);
    base.relation.rawFields=fields===null?null:JSON.parse(fields);
    samples.push(mem('hydratedOracle'));
    const text = JSON.stringify(base); digest=sha(text); bytes=Buffer.byteLength(text);
    maxDriverBytes = Math.max(Buffer.byteLength(row.raw_response || ''),Buffer.byteLength(row.collection_evidence || ''),Buffer.byteLength(fields || ''));
    samples.push(mem('serializedOracle'));
  } else {
    const sql = readFileSync(join(root,'domain-export/snapshot.sql'),'utf8');
    db.exec('create temp table snapshots(id integer primary key,payload text); create temp table audit(payload text)');
    db.prepare('insert into snapshots(payload) '+sql).run(1,1);
    samples.push(mem('nativeSnapshot'));
    bytes=db.prepare('select length(cast(payload as blob)) n from snapshots where id=1').get().n;
    const statement=db.prepare('select substr(cast(payload as blob),?,65536) part from snapshots where id=1');
    const hash = createHash('sha256');
    for(let pos=1;pos<=bytes;pos+=65536) {
      const {part}=statement.get(pos); maxDriverBytes=Math.max(maxDriverBytes,part.byteLength);
      hash.update(part); chunks++;
      if(chunks%32===0) { samples.push(mem('chunk'+chunks)); global.gc?.(); }
    }
    digest=hash.digest('hex'); samples.push(mem('chunkedHash'));
    db.exec('insert into audit select payload from snapshots where id=1');
    copyEqual=!!db.prepare('select (select payload from snapshots where id=1)=(select payload from audit limit 1) ok').get().ok;
    samples.push(mem('nativeAuditCopy'));
  }
  const elapsedMs=performance.now()-t;
  db.close(); samples.push(mem('closed'));
  const result={mode,family,size,unrelated,fieldBytes,bytes,digest,maxDriverBytes,chunks,copyEqual,elapsedMs,samples};
  if(process.send) process.send(result); else console.log(JSON.stringify(result));
} else if (mode === 'run') {
  mkdirSync(join(root,'memory'),{recursive:true});
  const parentSamples=[mem('start')]; let ipcMaxBytes=0;
  async function child(kind,fam,n,other) {
    return new Promise((res,rej)=>{
      const p=fork(fileURLToPath(import.meta.url),[kind,root,fam,String(n),String(other)],{execArgv:['--expose-gc'],stdio:['ignore','ignore','pipe','ipc']});
      let data,stderr=''; p.stderr.on('data',b=>{stderr+=b});
      p.on('message',m=>{data=m;ipcMaxBytes=Math.max(ipcMaxBytes,Buffer.byteLength(JSON.stringify(m)))});
      const timer=setInterval(()=>parentSamples.push(mem('child/'+kind)),25);
      p.on('exit',code=>{clearInterval(timer); code===0?res(data):rej(Error(`${kind}: exit ${code} ${stderr}`))});
      p.on('error',rej);
    });
  }
  const results=[];
  const cases=['raw','collection','fields','escape'].flatMap(f=>[65536,1048576,4194304,16777216].map(n=>[f,n,0]));
  cases.push(['raw',1048576,32],['escape',1048576,32]);
  for(const [f,n,other] of cases) {
    await child('seed',f,n,other);
    const oracle=await child('oracle',f,n,other);
    const sql=await child('sql',f,n,other);
    const entry={family:f,size:n,unrelated:other,equal:oracle.digest===sql.digest&&oracle.bytes===sql.bytes,oracle,sql};
    writeFileSync(join(root,'memory',`${f}-${n}-${other}.json`),JSON.stringify(entry,null,2));
    results.push(entry); console.log(JSON.stringify({family:f,size:n,unrelated:other,equal:entry.equal,sqlMs:sql.elapsedMs,sqlRSSMiB:Math.max(...sql.samples.map(x=>x.maxRSSKiB))/1024}));
  }
  writeFileSync(join(root,'memory-results.json'),JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,results,parentSamples,ipcMaxBytes},null,2));
}
