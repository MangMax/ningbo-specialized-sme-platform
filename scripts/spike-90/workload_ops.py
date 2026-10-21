# /// script
# requires-python = ">=3.12"
# dependencies = ["psycopg[binary]==3.3.6", "psycopg-pool==3.3.3"]
# ///
"""Bounded verification/storage of the private retained-domain experiment only."""
import argparse
import json
import subprocess
from pathlib import Path
from workload import readonly, fingerprint_rows

TABLES=('platform_query','platform_relation','platform_query_title_scope','platform_query_title_scope_error')


def main():
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=('storage','verify'))
    p.add_argument('--sqlite')
    p.add_argument('--dsn-file')
    p.add_argument('--database',required=True)
    p.add_argument('--pg-container')
    p.add_argument('--output',required=True)
    args=p.parse_args()
    if not args.database.startswith('spike90_workload_'):
        raise ValueError('private spike database required')
    if args.action=='verify':
        import psycopg
        from psycopg.conninfo import make_conninfo
        with psycopg.connect(make_conninfo(Path(args.dsn_file).read_text().strip(),dbname=args.database)) as db:
            result={'tables':{t:fingerprint_rows(db,t,True) for t in TABLES}}
    else:
        if not args.pg_container.startswith('ningbo-spike90-workload-'):
            raise ValueError('owned PG container required')
        db=readonly(args.sqlite)
        names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE tbl_name IN(?,?,?,?) AND type IN('table','index')",TABLES)]
        try:
            sizes={r[0]:r[1] for r in db.execute('SELECT name,sum(pgsize) FROM dbstat WHERE name IN('+','.join('?' for _ in names)+') GROUP BY name',names)}
            sqlite_domain={'table_and_index_page_bytes':sizes,'total_page_bytes':sum(sizes.values())}
        except Exception as exc:
            sqlite_domain={'unavailable_category':type(exc).__name__}
        sql="SELECT json_build_object('database_bytes',pg_database_size(current_database()),'domain_bytes',(SELECT json_object_agg(t,pg_total_relation_size(t::regclass)) FROM unnest(ARRAY['platform_query','platform_relation','platform_query_title_scope','platform_query_title_scope_error']) t),'cluster_wal_allocated_bytes',(SELECT sum(size) FROM pg_ls_waldir()),'locks',(SELECT json_agg(x) FROM (SELECT mode,granted,count(*) FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY mode,granted) x))"
        raw=subprocess.check_output(['docker','exec',args.pg_container,'psql','-U','spike90_owner','-d',args.database,'-Atc',sql],text=True)
        result={'sqlite_file_bytes':Path(args.sqlite).stat().st_size,'sqlite_domain':sqlite_domain,'postgres':json.loads(raw),
                'limitations':['domain sizes compare same retained four tables; SQLite file includes additional domains',
                               'WAL allocation includes private cluster/import history; idle lock snapshot is not contention measurement']}
        db.close()
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'private_'+args.action+'_recorded':True}))


if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        raise SystemExit('private workload operation failed: '+type(exc).__name__) from None
