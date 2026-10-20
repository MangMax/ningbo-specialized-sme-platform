# /// script
# requires-python = ">=3.12"
# dependencies = ["psycopg[binary]==3.3.6", "psycopg-pool==3.3.3"]
# ///
"""Narrow retained-archive read comparator. Import only into a NEW isolated PG database."""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
import queue
import resource
import secrets
import sqlite3
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

TITLES = {'innovative_sme': '1', 'specialized_sme': '2', 'little_giant': '3'}
META = ['id', 'interface', 'query_key', 'rdjb', 'title_code', 'queried_at', 'status', 'failure_reason', 'created_at']
CAMEL = dict(zip(META, ['id', 'interface', 'queryKey', 'rdjb', 'titleCode', 'queriedAt', 'status', 'failureReason', 'createdAt']))
TABLES = ('platform_query', 'platform_relation')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def hash_value(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def readonly(path):
    # Only qualified, quiescent own copies are accepted by the runbook. No WAL changes are expected.
    db = sqlite3.connect('file:' + quote(str(Path(path).resolve())) + '?mode=ro&immutable=1', uri=True, check_same_thread=False)
    db.execute('PRAGMA query_only=ON')
    db.row_factory = sqlite3.Row
    return db


class Adapter:
    def __init__(self, backend, target, pool_size=5):
        self.backend = backend
        self.metrics = threading.local()
        self.sqlite_pool = None
        self.pg_pool = None
        if backend == 'sqlite':
            self.sqlite_pool = queue.Queue(pool_size)
            for _ in range(pool_size):
                self.sqlite_pool.put(readonly(target))
        else:
            from psycopg_pool import ConnectionPool
            from psycopg.rows import dict_row
            self.pg_pool = ConnectionPool(target, min_size=pool_size, max_size=pool_size,
                                          kwargs={'row_factory': dict_row}, timeout=10)
            self.pg_pool.wait()

    @contextmanager
    def transaction(self):
        if self.sqlite_pool:
            db = self.sqlite_pool.get(timeout=10)
            try:
                db.execute('BEGIN')
                yield db
            finally:
                db.rollback()
                self.sqlite_pool.put(db)
        else:
            with self.pg_pool.connection() as db:
                with db.transaction():
                    db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                    yield db

    def rows(self, db, sql, params=()):
        if self.backend == 'postgres':
            sql = sql.replace('?', '%s')
        start = time.perf_counter_ns()
        rows = [dict(row) for row in db.execute(sql, params).fetchall()]
        self.metrics.sql_ms = getattr(self.metrics, 'sql_ms', 0) + (time.perf_counter_ns()-start)/1e6
        self.metrics.query_count = getattr(self.metrics, 'query_count', 0) + 1
        self.metrics.returned_bytes = getattr(self.metrics, 'returned_bytes', 0) + sum(
            len(v.encode()) if isinstance(v,str) else len(v) if isinstance(v,(bytes,memoryview)) else 8 if isinstance(v,int) else 0
            for row in rows for v in row.values())
        return rows

    def summary(self, db, args):
        clauses, params = [], []
        for name, column in [('queryId', 'id'), ('interface', 'interface'), ('queryKey', 'query_key'), ('status', 'status')]:
            if args.get(name) is not None:
                clauses.append(column + '=?')
                params.append(args[name])
        if args.get('uscc'):
            clauses.append('(query_key=? OR id IN(SELECT query_id FROM platform_relation WHERE uscc_raw=?))')
            params.extend([args['uscc'], args['uscc']])
        if args.get('enterpriseId') is not None:
            clauses.append('id IN(SELECT query_id FROM platform_relation WHERE enterprise_id=?)')
            params.append(args['enterpriseId'])
        title = args.get('titleCode')
        if title:
            without_title = ' AND '.join(clauses) if clauses else '1=1'
            malformed = self.rows(db, 'SELECT id FROM platform_query WHERE id IN(SELECT query_id FROM platform_query_title_scope_error) AND ('+without_title+') AND (title_code IS NULL OR title_code<>?) LIMIT 1', [*params,title])
            if malformed:
                raise ValueError('malformed archived JSON in selected title scope')
            clauses.append('id IN(SELECT id FROM platform_query WHERE title_code=? UNION SELECT query_id FROM platform_query_title_scope WHERE rdjb=?)')
            params.extend([title,TITLES.get(title,'')])
        where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
        page, size = int(args.get('page', 1)), int(args.get('pageSize', 25))
        if page < 1 or size < 1 or size > 200:
            raise ValueError('invalid paging')
        counts = {row['status']: row['n'] for row in self.rows(db, 'SELECT status,count(*) n FROM platform_query' + (' INDEXED BY platform_query_status_time_idx' if title and self.backend=='sqlite' else '') + where + ' GROUP BY status', params)}
        ids = [row['id'] for row in self.rows(db, 'SELECT id FROM platform_query' + (' INDEXED BY '+('platform_query_status_time_idx' if args.get('status') else 'platform_query_time_idx') if title and self.backend=='sqlite' else '') + where + ' ORDER BY queried_at DESC,id DESC LIMIT ? OFFSET ?', [*params, size, (page-1)*size])]
        by_id = {}
        if ids:
            rows = self.rows(db, 'SELECT ' + ','.join(META) + ',(SELECT count(*) FROM platform_relation r WHERE r.query_id=platform_query.id) relation_count FROM platform_query WHERE id IN(' + ','.join('?' for _ in ids) + ')', ids)
            by_id = {row['id']: {**{CAMEL[k]: row[k] for k in META}, 'relationCount': row['relation_count']} for row in rows}
        return {'rows': [{'relationsIncluded': False, 'query': by_id[i], 'relations': []} for i in ids],
                'total': sum(counts.values()), 'page': page, 'pageSize': size, 'counts': counts}

    def evidence(self, db, args):
        query_id, field = int(args['queryId']), args['field']
        if field == 'relations':
            if not self.rows(db, 'SELECT id FROM platform_query WHERE id=?', [query_id]):
                raise LookupError('missing query')
            page, size = int(args.get('page', 1)), int(args.get('pageSize', 100))
            n = self.rows(db, 'SELECT count(*) n FROM platform_relation WHERE query_id=?', [query_id])[0]['n']
            rows = self.rows(db, 'SELECT id,sequence_no FROM platform_relation WHERE query_id=? ORDER BY sequence_no LIMIT ? OFFSET ?', [query_id, size, (page-1)*size])
            return {'queryId': query_id, 'field': field, 'total': n, 'page': page, 'pageSize': size,
                    'rows': [{'id': r['id'], 'sequenceNo': r['sequence_no']} for r in rows]}
        if field not in ('rawResponse', 'collectionEvidence'):
            raise ValueError('only original raw/evidence bytes and relation discovery are in scope')
        column = 'raw_response' if field == 'rawResponse' else 'collection_evidence'
        offset, length = int(args.get('offset', 0)), int(args.get('length', 65536))
        if offset < 0 or not 1 <= length <= 65536:
            raise ValueError('invalid byte range')
        expression = 'cast(' + column + ' as blob)' if self.backend == 'sqlite' else "convert_to(" + column + ",'UTF8')"
        found = self.rows(db, 'SELECT substr(' + expression + ',?,?) data,length(' + expression + ') total_bytes FROM platform_query WHERE id=?', [offset+1, length, query_id])
        if not found:
            raise LookupError('missing query')
        data = bytes(found[0]['data'] or b'')
        total = found[0]['total_bytes']
        return {'queryId': query_id, 'field': field, 'encoding': 'base64', 'offset': offset,
                'byteLength': len(data), 'totalBytes': total or 0, 'isNull': total is None,
                'hasMore': offset + len(data) < (total or 0), 'data': base64.b64encode(data).decode()}

    def read(self, case):
        self.metrics.sql_ms, self.metrics.query_count, self.metrics.returned_bytes = 0, 0, 0
        with self.transaction() as db:
            return self.summary(db, case['args']) if case['kind'] == 'summary' else self.evidence(db, case['args'])

    def environment(self):
        result={'backend':self.backend,'python':sys.version,'sqlite_library':sqlite3.sqlite_version,
                'pool_size':5,'adapter_source_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'psycopg':importlib.metadata.version('psycopg'),'psycopg_pool':importlib.metadata.version('psycopg-pool')}
        with self.transaction() as db:
            if self.backend=='sqlite':
                result['sqlite_config']={key:db.execute('PRAGMA '+key).fetchone()[0] for key in ('cache_size','mmap_size','journal_mode','query_only')}
            else:
                result['postgres_config']={key:db.execute('SELECT current_setting(%s) AS value',[key]).fetchone()['value'] for key in ('server_version','shared_buffers','work_mem','max_connections','default_transaction_isolation','timezone','server_encoding')}
        return result


def fingerprint_rows(db, table, pg=False):
    order = 'query_id,rdjb' if table=='platform_query_title_scope' else 'query_id' if table=='platform_query_title_scope_error' else 'id'
    cursor = db.cursor(name='spike90_hash_'+table) if pg else db.cursor()
    if pg:
        cursor.itersize = 100  # A regular libpq result would buffer the entire retained archive.
    cursor.execute('SELECT * FROM ' + table + ' ORDER BY '+order)
    digest, count, raw_bytes = hashlib.sha256(), 0, 0
    columns = [item.name if pg else item[0] for item in cursor.description]
    for row in cursor:
        value = dict(zip(columns, row))
        digest.update((canonical(value) + '\n').encode())
        count += 1
        raw_bytes += sum(len(value.get(k).encode()) for k in ('raw_response', 'collection_evidence', 'raw_fields', 'source_text') if isinstance(value.get(k), str))
    cursor.close()
    return {'rows': count, 'ordered_sha256': digest.hexdigest(), 'raw_bytes': raw_bytes}


def import_archive(args):
    import psycopg
    proof = json.loads(Path(args.provenance).read_text())
    if proof.get('confirmedQuiescent') is not True or Path(proof['sourcePath']).resolve() != Path(args.sqlite).resolve():
        raise ValueError('qualified quiescent source provenance required')
    expected = proof['sourceSha256']
    digest = hashlib.file_digest(open(args.sqlite, 'rb'), 'sha256').hexdigest()
    if digest != expected:
        raise ValueError('source digest mismatch')
    if not args.database.startswith('spike90_workload_'):
        raise ValueError('dedicated NEW spike90_workload_* database required')
    dsn = Path(args.dsn_file).read_text().strip()
    from psycopg.conninfo import make_conninfo
    from psycopg import sql
    with psycopg.connect(dsn, autocommit=True) as admin:
        # CREATE DATABASE must fail if target exists: no accidental overwrite/re-import.
        admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0 ENCODING \'UTF8\' LC_COLLATE \'C\' LC_CTYPE \'C\'').format(sql.Identifier(args.database)))
    source = readonly(args.sqlite)
    report = {'source_sha256': digest, 'database': args.database, 'tables': {}, 'limitations': ['only complete platform query/relation domain imported', 'other domain foreign keys are retained as IDs, not migrated tables']}
    with psycopg.connect(make_conninfo(dsn, dbname=args.database)) as target:
        available={r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        tables=(*TABLES,'platform_query_title_scope','platform_query_title_scope_error')
        if not set(tables)<=available:
            raise ValueError('apply final qualified #83 migration to own copy before importing optimized workload')
        for table in tables:
            info = source.execute('PRAGMA table_info(' + table + ')').fetchall()
            definitions = [sql.SQL('{} {}').format(sql.Identifier(r['name']), sql.SQL('BIGINT' if r['type'].upper() == 'INTEGER' else 'TEXT')) for r in info]
            target.execute(sql.SQL('CREATE TABLE {} ({})').format(sql.Identifier(table), sql.SQL(',').join(definitions)))
            columns = [r['name'] for r in info]
            with target.cursor().copy(sql.SQL('COPY {} ({}) FROM STDIN').format(sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, columns)))) as copy:
                for row in source.execute('SELECT * FROM ' + table):
                    copy.write_row(tuple(row))
            pk = 'query_id,rdjb' if table=='platform_query_title_scope' else 'query_id' if table=='platform_query_title_scope_error' else 'id'
            target.execute(sql.SQL('ALTER TABLE {} ADD PRIMARY KEY ('+pk+')').format(sql.Identifier(table)))
            target.execute(sql.SQL('ANALYZE {}').format(sql.Identifier(table)))
            left, right = fingerprint_rows(source, table), fingerprint_rows(target, table, True)
            if left != right:
                raise ValueError('retained rows mismatch: ' + table)
            report['tables'][table] = left
        for ddl in ['CREATE INDEX ON platform_query(title_code,id)', 'CREATE INDEX ON platform_query_title_scope(rdjb,query_id)', 'CREATE INDEX ON platform_query(queried_at DESC,id DESC)', 'CREATE INDEX ON platform_query(status,queried_at DESC,id DESC)',
                    'CREATE INDEX ON platform_query(query_key)', 'CREATE UNIQUE INDEX ON platform_query(interface,query_key,rdjb,queried_at)',
                    'CREATE UNIQUE INDEX ON platform_relation(query_id,sequence_no)', 'CREATE INDEX ON platform_relation(uscc_raw,query_id)',
                    'CREATE INDEX ON platform_relation(enterprise_id)', 'CREATE INDEX ON platform_relation(relation_key)']:
            target.execute(ddl)
        target.execute('ALTER TABLE platform_relation ADD FOREIGN KEY(query_id) REFERENCES platform_query(id)')
        report['database_bytes'] = target.execute('SELECT pg_database_size(current_database())').fetchone()[0]
        if args.reader_dsn_file:
            role, password = args.database + '_reader', secrets.token_urlsafe(32)
            target.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE').format(sql.Identifier(role),sql.Literal(password)))
            target.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
            target.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(sql.Identifier(role)))
            target.execute(sql.SQL('GRANT SELECT ON ALL TABLES IN SCHEMA public TO {}').format(sql.Identifier(role)))
            target.execute(sql.SQL('ALTER ROLE {} SET default_transaction_read_only=on').format(sql.Identifier(role)))
            reader_path=Path(args.reader_dsn_file)
            reader_path.write_text(make_conninfo(dsn,dbname=args.database,user=role,password=password))
            reader_path.chmod(0o600)
            report['reader_role_created']=True
    source.close()
    report['source_unchanged'] = hashlib.file_digest(open(args.sqlite, 'rb'), 'sha256').hexdigest() == expected
    if not report['source_unchanged']:
        raise ValueError('source changed during copy')
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(canonical({'imported_verified': True, 'counts': {k:v['rows'] for k,v in report['tables'].items()}}))


def serve(args):
    target = args.sqlite if args.backend == 'sqlite' else Path(args.dsn_file).read_text().strip()
    adapter = Adapter(args.backend, target)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            start = time.perf_counter_ns()
            try:
                parsed = urlparse(self.path)
                if parsed.path == '/health':
                    result = {'ok': True}
                elif parsed.path == '/environment':
                    result = adapter.environment()
                elif parsed.path == '/read':
                    case = json.loads(parse_qs(parsed.query)['case'][0])
                    result = adapter.read(case)
                else:
                    raise LookupError('unknown path')
                sql_end = time.perf_counter_ns()
                data = canonical(result).encode()
                serialize_end = time.perf_counter_ns()
                code = 200
            except Exception as exc:
                code = 404 if isinstance(exc, LookupError) else 400 if isinstance(exc, ValueError) else 503
                data = canonical({'error': type(exc).__name__}).encode()
                sql_end = serialize_end = time.perf_counter_ns()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-Workload-Read-Ms', str((sql_end-start)/1e6))
            self.send_header('X-Workload-Sql-Ms', str(getattr(adapter.metrics, 'sql_ms', 0)))
            self.send_header('X-Workload-Sql-Count', str(getattr(adapter.metrics, 'query_count', 0)))
            self.send_header('X-Workload-Sql-Returned-Bytes', str(getattr(adapter.metrics, 'returned_bytes', 0)))
            self.send_header('X-Workload-Serialize-Ms', str((serialize_end-sql_end)/1e6))
            self.send_header('X-Workload-Maxrss', str(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss))
            self.end_headers()
            self.wfile.write(data)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


def main():
    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest='action', required=True)
    imp = subs.add_parser('import')
    for option in ('sqlite', 'provenance', 'dsn-file', 'database', 'output'):
        imp.add_argument('--' + option, required=True)
    imp.add_argument('--reader-dsn-file')
    server = subs.add_parser('serve')
    server.add_argument('--backend', choices=('sqlite', 'postgres'), required=True)
    server.add_argument('--sqlite')
    server.add_argument('--dsn-file')
    server.add_argument('--host', default='127.0.0.1')
    server.add_argument('--port', type=int, default=55493)
    args = parser.parse_args()
    try:
        import_archive(args) if args.action == 'import' else serve(args)
    except Exception as exc:
        if args.action == 'import':
            Path(args.output).write_text(json.dumps({'failed': True, 'category': type(exc).__name__})+'\n')
        raise SystemExit('isolated workload failure: '+type(exc).__name__) from None


if __name__ == '__main__':
    main()
