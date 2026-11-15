/** Observes real calls only. Pauses after the real first SQL establishes its
 * snapshot; file faults affect owned inputs, never domain queries/results.
 * Native admission precedes the source SELECT and owns an exclusive-lock wait. */
export function comparisonWorkerObserver(driver: string, dir: string, dbPath: string) {
  return `const fs=require('node:fs'),D=require(${JSON.stringify(driver)}),path=require('node:path'),dir=${JSON.stringify(dir)},dbPath=${JSON.stringify(dbPath)};process.env.M3_APP_PID??=String(process.pid);
const log=e=>{const line=JSON.stringify({pid:process.pid,at:Date.now(),...e})+'\\n';for(const file of ['observed.jsonl','all-observed.jsonl'])fs.appendFileSync(path.join(dir,file),line)};
const exists=n=>fs.existsSync(path.join(dir,n));const originalRead=fs.readFileSync;
fs.readFileSync=function(file,...a){const name=String(file),isInput=[path.join(dir,'curated.json'),path.join(dir,'reconcile.json')].includes(name);if(isInput)log({kind:'file',file:name});const result=originalRead.call(this,file,...a);if(name===path.join(dir,'curated.json')&&exists('repair-curation'))fs.writeFileSync(name,'{}');return result};require('node:module').syncBuiltinESMExports();
const prepare=D.prototype.prepare,pragma=D.prototype.pragma;
D.prototype.pragma=function(sql,...a){if(sql==='user_version')log({kind:'admission',sql});return pragma.call(this,this.name===dbPath&&exists('delete-journal')&&sql.replace(/\\s/g,'').toLowerCase()==='journal_mode=wal'?'journal_mode=DELETE':sql,...a)};
D.prototype.prepare=function(sql,...a){const first=sql.includes('with differences as ('),last=sql.includes('count(*)')&&sql.includes('platform_business_observation');if(first||last)log({kind:first?'source':'hydration',sql});if(first&&exists('exit-on-read')&&process.pid!==Number(process.env.M3_APP_PID))process.exit(97);const s=prepare.call(this,sql,...a);for(const method of ['all','get']){const run=s[method];s[method]=function(...args){const result=run.apply(this,args);if(first&&exists('pause-after-source')){fs.unlinkSync(path.join(dir,'pause-after-source'));log({kind:'snapshot-established'});const until=Date.now()+10000;while(!exists('release-snapshot')){if(Date.now()>until)throw new Error('M3 test snapshot release missing');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}}return result}}return s};`
}
