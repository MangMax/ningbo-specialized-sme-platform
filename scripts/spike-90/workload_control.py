"""Private fixture preparation and exclusive Docker workload measurement; never access production."""
import argparse
import hashlib
import json
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote, urlparse
from compare_public import run_case, canonical
from workload import readonly, fingerprint_rows

PREFIX = 'ningbo-spike90-workload-'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def inspect(name):
    if not name.startswith(PREFIX):
        raise ValueError('only owned workload containers allowed')
    obj = json.loads(docker('inspect', name))[0]
    return {k: obj[k] for k in ('Id','Image','Name')} | {
        'State': {k:obj['State'].get(k) for k in ('Status','Pid','StartedAt')},
        'Limits': {k:obj['HostConfig'][k] for k in ('NanoCpus','Memory','MemorySwap')},
        'Mounts': obj['Mounts'], 'Networks': list(obj['NetworkSettings']['Networks'])}


def private_path(value):
    path = Path(value).resolve()
    if not path.is_relative_to(Path('/tmp/ningbo-perf-83-90/workload').resolve()):
        raise ValueError('private spike workload path required')
    return path


def cgroups(names):
    return {name:docker('exec',name,'cat','/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.peak',
                       '/sys/fs/cgroup/cpu.stat','/sys/fs/cgroup/io.stat').splitlines() for name in names}


def prepare(args):
    root = private_path(args.directory)
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    target = root/'source.sqlite'
    if target.exists() or (root/'admin.dsn').exists():
        raise ValueError('use a fresh private directory; do not overwrite fixture or credentials')
    if hashlib.file_digest(open(args.source,'rb'), 'sha256').hexdigest() != args.source_sha256:
        raise ValueError('qualified source digest mismatch')
    shutil.copyfile(args.source,target)
    target.chmod(0o400)
    if hashlib.file_digest(open(target,'rb'), 'sha256').hexdigest() != args.source_sha256:
        raise ValueError('copy digest mismatch')
    password = secrets.token_urlsafe(32)
    (root/'postgres.env').write_text('POSTGRES_USER=spike90_owner\nPOSTGRES_PASSWORD='+password+'\nPOSTGRES_DB=postgres\n')
    (root/'admin.dsn').write_text('postgresql://spike90_owner:'+quote(password,safe='')+'@'+PREFIX+'pg:5432/postgres')
    for name in ('postgres.env','admin.dsn'):
        (root/name).chmod(0o600)
    proof = {'confirmedQuiescent':True,'sourcePath':'/private/source.sqlite','sourceSha256':args.source_sha256,
             'qualification':args.qualified_handoff,'sourceOrigin':str(Path(args.source).resolve())}
    (root/'provenance.json').write_text(json.dumps(proof,indent=2)+'\n')
    print(canonical({'prepared':True,'private_directory':str(root),'source_sha256':args.source_sha256}))


def derive(args):
    target=private_path(args.output)
    source=private_path(args.source)
    if target.exists():
        raise ValueError('new owned fixture required')
    shutil.copyfile(source,target)
    target.chmod(0o600)
    old=readonly(source)
    before={t:fingerprint_rows(old,t) for t in ('platform_query','platform_relation')}
    derived_before={t:old.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ('platform_query_title_scope','platform_query_title_scope_error')} if args.command=='scale2x' else {}
    old.close()
    db=sqlite3.connect(target)
    db.execute('PRAGMA foreign_keys=ON')
    if args.command=='migrate-copy':
        migration=Path(args.migration).read_text()
        db.executescript('BEGIN;'+migration+'\nCOMMIT;')
    else:
        # Synthetic unrelated archive growth only. Embedded source identities stay as original bytes.
        # Clone IDs/FKs and query identity keys are remapped; original rows remain untouched.
        qmax=db.execute('SELECT max(id) FROM platform_query').fetchone()[0]
        rmax=db.execute('SELECT max(id) FROM platform_relation').fetchone()[0]
        db.execute('BEGIN IMMEDIATE')
        for table in ('platform_query','platform_relation'):
            columns=[r[1] for r in db.execute('PRAGMA table_info('+table+')')]
            expressions=[]
            for col in columns:
                expression='"'+col+'"'
                if col=='id': expression+='+'+str(qmax if table=='platform_query' else rmax)
                elif col=='query_id': expression+='+'+str(qmax)
                elif col=='query_key': expression="'spike90:synthetic-clone:'||query_key"
                expressions.append(expression)
            db.execute('INSERT INTO '+table+'('+','.join('"'+c+'"' for c in columns)+') SELECT '+','.join(expressions)+' FROM '+table)
        db.commit()
    db.close()
    target.chmod(0o400)
    current=readonly(target)
    after={t:fingerprint_rows(current,t) for t in ('platform_query','platform_relation')}
    if args.command=='migrate-copy' and before!=after:
        raise ValueError('derived migration changed original archive rows')
    if args.command=='scale2x' and any(after[t]['rows']!=2*before[t]['rows'] or after[t]['raw_bytes']!=2*before[t]['raw_bytes'] for t in before):
        raise ValueError('2x archive rows/bytes mismatch')
    derived_after={t:current.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in derived_before}
    if any(derived_after[t]!=2*derived_before[t] for t in derived_before):
        raise ValueError('2x requires final #83 triggers to maintain derived memberships/errors')
    current.close()
    digest=hashlib.file_digest(open(target,'rb'),'sha256').hexdigest()
    report={'confirmedQuiescent':True,'sourcePath':'/private/'+target.name,'sourceSha256':digest,
            'sourceOrigin':str(source),'transformation':args.command,'before':before,'after':after,'derived_before':derived_before,'derived_after':derived_after,
            'limitations':['2x, if selected, is synthetic query/relation archive growth; other domains are not doubled; embedded evidence original IDs retained']}
    if args.command=='migrate-copy':
        report['migration_sha256']=hashlib.sha256(Path(args.migration).read_bytes()).hexdigest()
    Path(args.report).write_text(json.dumps(report,indent=2)+'\n')
    print(canonical({'prepared':args.command,'private_fixture':str(target),'query_rows':after['platform_query']['rows']}))


def manifest(args):
    db = readonly(args.sqlite)
    ids = [r[0] for r in db.execute('SELECT id FROM platform_query WHERE raw_response IS NOT NULL ORDER BY id LIMIT 1')]
    if not ids:
        raise ValueError('retained fixture needs a raw-response case')
    qid = ids[0]
    cases = [
        {'name':'summary-page','kind':'summary','args':{'pageSize':25}},
        {'name':'title-filter','kind':'summary','args':{'titleCode':'specialized_sme','pageSize':25}},
        {'name':'title-deep-page','kind':'summary','args':{'titleCode':'specialized_sme','page':100,'pageSize':25}},
        {'name':'failed','kind':'summary','args':{'status':'failed','pageSize':25}},
        {'name':'exact-summary','kind':'summary','args':{'queryId':qid}},
        {'name':'empty-key','kind':'summary','args':{'queryKey':'spike90:nonexistent:synthetic'}},
        {'name':'raw-byte-chunk','kind':'evidence','args':{'queryId':qid,'field':'rawResponse','offset':1,'length':65536}},
        {'name':'original-collection','kind':'evidence','args':{'queryId':qid,'field':'collectionEvidence'}},
        {'name':'ordered-relations','kind':'evidence','args':{'queryId':qid,'field':'relations'}}]
    Path(args.output).write_text(json.dumps({'cases':cases},indent=2)+'\n')
    db.close()
    print(canonical({'prepared_cases':len(cases),'private_manifest':True}))


def measure(args):
    import urllib.request
    for url in (args.sqlite_url,args.postgres_url):
        parsed=urlparse(url)
        if parsed.scheme!='http' or parsed.hostname not in ('localhost','127.0.0.1') or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment:
            raise ValueError('isolated loopback adapter URLs required')
    if args.samples<1:
        raise ValueError('positive sample count required')
    names = [args.sqlite_container,args.postgres_container,args.pg_container]
    before = {name:inspect(name) for name in names}
    expected_limits = [(1_000_000_000,4096*1024**2),(250_000_000,512*1024**2),(750_000_000,3584*1024**2)]
    for name,(cpu,memory) in zip(names,expected_limits):
        if before[name]['Limits']['NanoCpus'] != cpu or before[name]['Limits']['Memory'] != memory or before[name]['Limits']['MemorySwap'] != memory:
            raise ValueError('actual container limits differ from accepted total envelope')
        if before[name]['Networks']!=[PREFIX+'net']:
            raise ValueError('only owned private Docker network allowed')
    if json.loads(docker('network','inspect',PREFIX+'net'))[0]['Internal'] is not True:
        raise ValueError('owned Docker network must be internal')
    if before[names[0]]['Image'] != before[names[1]]['Image']:
        raise ValueError('both adapters must use exact same image')
    oracle = json.loads(Path(args.oracle).read_text())
    cases = json.loads(Path(args.manifest).read_text())['cases']
    environments={}
    expected_source=hashlib.sha256(Path(__file__).with_name('workload.py').read_bytes()).hexdigest()
    for backend,url in [('sqlite',args.sqlite_url),('postgres',args.postgres_url)]:
        with urllib.request.urlopen(url+'/environment',timeout=30) as response:
            environments[backend]=json.load(response)
        if environments[backend]['adapter_source_sha256']!=expected_source:
            raise ValueError('actual container adapter source differs from measured source')
    result = {'actual_containers':before,'oracle':oracle,'samples_per_width':args.samples,
              'actual_environments':environments,
              'limitations':['cold-process only; OS and PG page cache retained','total CPU/RSS envelopes equal; component allocation differs',
                             'same Python adapters, not actual Node application latency','SQL timing includes row materialization; shaping residual is not JSON-only cost',
                             'PG app role is isolated readonly reader; production write privileges are separate','small timing samples do not establish tail SLOs',
                             'docker stats sampled about once per second; cgroup peak includes container startup/import history'], 'cases':{},'resource_samples':[]}
    stats=subprocess.Popen(['docker','stats','--format','{{json .}}',*names],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def collect():
        for line in stats.stdout:
            try:
                result['resource_samples'].append({'monotonic_s':time.monotonic(),'stats':json.loads(line)})
            except ValueError:
                result.setdefault('resource_sampler_errors',[]).append('invalid_json')
    collector=threading.Thread(target=collect,daemon=True)
    collector.start()
    try:
        for index,case in enumerate(cases):
            result['cases'][case['name']] = entry = {}
            entry['cgroups_before']=cgroups(names)
            ordered = [('sqlite',args.sqlite_url,args.sqlite_container),('postgres',args.postgres_url,args.postgres_container)]
            if index%2:
                ordered.reverse()
            for backend,url,container in ordered:
                docker('restart',container)
                ready=False
                for _ in range(300):
                    try:
                        with urllib.request.urlopen(url+'/health',timeout=1) as response:
                            ready=response.status==200
                    except OSError:
                        pass
                    if ready:
                        break
                    time.sleep(.1)
                if not ready:
                    raise RuntimeError('owned adapter failed readiness')
                query = {'name':case['name'],'method':'GET','path':'/read?case='+quote(canonical(case),safe=''),
                         'expectedStatus':200,'samples':args.samples,'concurrency':[1,2,5]}
                entry[backend+'_measurement_start']=time.monotonic()
                entry[backend] = run_case(url,query,'')
                entry[backend+'_measurement_end']=time.monotonic()
            expected = oracle['cases'][case['name']]['semantic_sha256']
            entry['oracle_equivalent'] = all(entry[b]['first']['status']==200 and entry[b]['first']['error'] is None and entry[b]['first']['semantic_sha256']==expected
                and all(r['status_and_semantics_stable'] for r in entry[b]['hot'].values()) for b in ('sqlite','postgres'))
            entry['docker_stats_after'] = [json.loads(line) for line in docker('stats','--no-stream','--format','{{json .}}',*names).splitlines()]
            entry['cgroups_after']=cgroups(names)
            Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    except Exception as exc:
        result['failure_category'] = type(exc).__name__
        Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
        raise SystemExit('isolated run failed; category='+type(exc).__name__)
    finally:
        stats.terminate()
        stats.wait(timeout=10)
        collector.join(timeout=10)
        Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    passed=all(c['oracle_equivalent'] for c in result['cases'].values())
    print(canonical({'cases':len(cases),'all_actual_node_oracle_equivalent':passed}))
    if not passed:
        raise SystemExit(2)


def main():
    p=argparse.ArgumentParser()
    subs=p.add_subparsers(dest='command',required=True)
    prep=subs.add_parser('prepare')
    for key in ('source','source-sha256','qualified-handoff','directory'):
        prep.add_argument('--'+key,required=True)
    for name in ('migrate-copy','scale2x'):
        transform=subs.add_parser(name)
        for key in ('source','output','report'):
            transform.add_argument('--'+key,required=True)
        if name=='migrate-copy':
            transform.add_argument('--migration',required=True)
    man=subs.add_parser('manifest')
    man.add_argument('--sqlite',required=True)
    man.add_argument('--output',required=True)
    run=subs.add_parser('measure')
    for key in ('manifest','oracle','output','sqlite-container','postgres-container','pg-container','sqlite-url','postgres-url'):
        run.add_argument('--'+key,required=True)
    run.add_argument('--samples',type=int,default=20)
    args=p.parse_args()
    {'prepare':prepare,'migrate-copy':derive,'scale2x':derive,'manifest':manifest,'measure':measure}[args.command](args)


if __name__=='__main__':
    main()
