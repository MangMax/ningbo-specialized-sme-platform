"""Small independent literals for the narrow read adapter. No retained data required."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from workload import Adapter


def seed(path):
    db = sqlite3.connect(path)
    db.execute('CREATE TABLE platform_query(id INTEGER PRIMARY KEY,interface TEXT,query_key TEXT,rdjb TEXT,title_code TEXT,queried_at TEXT,status TEXT,failure_reason TEXT,created_at TEXT,raw_response TEXT,collection_evidence TEXT)')
    db.execute('CREATE TABLE platform_relation(id INTEGER PRIMARY KEY,query_id INTEGER,sequence_no INTEGER,enterprise_id INTEGER,uscc_raw TEXT,raw_fields TEXT,source_text TEXT,relation_key TEXT)')
    for i, status in enumerate(['success','failed','partial','no_record','not_queried'], 1):
        # title_code OR string-array scope; numeric 2 must remain different from string '2'.
        scope = ['2'] if i in (1, 2) else [2] if i == 3 else None
        evidence = json.dumps({'titleScope': {'rdjb': scope}}) if i != 5 else None
        db.execute('INSERT INTO platform_query VALUES(?,?,?,?,?,?,?,?,?,?,?)', [i,'recognized_list','synthetic:'+str(i),'', 'specialized_sme' if i == 4 else None,'2026-10-20',status,None,'2026-10-20', None if i==1 else '' if i==2 else '甲🙂乙',evidence])
    for rid, seq in [(9,2),(8,1)]:
        db.execute('INSERT INTO platform_relation VALUES(?,?,?,?,?,?,?,?)', [rid,1,seq,None,'synthetic:linked',None,None,None])
    db.execute('CREATE INDEX platform_query_status_time_idx ON platform_query(status,queried_at,id)')
    db.execute('CREATE INDEX platform_query_time_idx ON platform_query(queried_at,id)')
    db.execute('CREATE TABLE platform_query_title_scope(query_id INTEGER,rdjb TEXT,PRIMARY KEY(query_id,rdjb))')
    db.execute('CREATE TABLE platform_query_title_scope_error(query_id INTEGER PRIMARY KEY)')
    db.executemany('INSERT INTO platform_query_title_scope VALUES(?,?)', [(1,'2'),(2,'2')])
    db.commit()
    db.close()


def cases():
    return [
        {'name':'all-five-statuses','kind':'summary','args':{}},
        {'name':'title-strings-not-numbers','kind':'summary','args':{'titleCode':'specialized_sme'}},
        {'name':'deep-page','kind':'summary','args':{'page':2,'pageSize':2}},
        {'name':'empty-page','kind':'summary','args':{'page':10,'pageSize':2}},
        {'name':'failed-filter','kind':'summary','args':{'status':'failed'}},
        {'name':'linked-uscc','kind':'summary','args':{'uscc':'synthetic:linked'}},
        *[{'name':'raw-'+str(i),'kind':'evidence','args':{'queryId':i,'field':'rawResponse','offset':2,'length':4}} for i in [1,2,3]],
        {'name':'null-evidence','kind':'evidence','args':{'queryId':5,'field':'collectionEvidence'}},
        {'name':'ordered-relations','kind':'evidence','args':{'queryId':1,'field':'relations'}},
    ]


class WorkloadReadTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='spike90-workload-')
        self.path = Path(self.folder.name)/'fixture.sqlite'
        seed(self.path)
        self.adapter = Adapter('sqlite', self.path, pool_size=1)

    def tearDown(self):
        self.adapter.sqlite_pool.get().close()
        self.folder.cleanup()

    def read(self, kind, **args):
        return self.adapter.read({'kind':kind,'args':args})

    def test_summary_preserves_five_states_and_stable_tie_order(self):
        result = self.read('summary')
        self.assertEqual([row['query']['id'] for row in result['rows']], [5,4,3,2,1])
        self.assertEqual(result['counts'], {'success':1,'failed':1,'partial':1,'no_record':1,'not_queried':1})
        self.assertEqual(result['rows'][-1]['query']['relationCount'], 2)
        self.assertTrue(all(row['relationsIncluded'] is False and row['relations']==[] for row in result['rows']))

    def test_title_filter_preserves_json_string_numeric_null_distinctions(self):
        result = self.read('summary',titleCode='specialized_sme')
        self.assertEqual([row['query']['id'] for row in result['rows']], [4,2,1])
        self.assertEqual(result['total'], 3)

    def test_relation_uscc_matches_query_without_collapsing_relations(self):
        result = self.read('summary',uscc='synthetic:linked')
        self.assertEqual(result['total'],1)
        self.assertEqual(result['rows'][0]['query']['relationCount'],2)

    def test_title_error_marker_respects_other_filters_and_direct_title(self):
        db=sqlite3.connect(self.path)
        for ident,title in [(6,'specialized_sme'),(7,None)]:
            db.execute('INSERT INTO platform_query VALUES(?,?,?,?,?,?,?,?,?,?,?)',[ident,'recognized_list','bad:'+str(ident),'',title,'2026-10-20','partial',None,'2026-10-20',None,'{invalid'])
            db.execute('INSERT INTO platform_query_title_scope_error VALUES(?)',[ident])
        db.commit();db.close()
        self.assertEqual(self.read('summary',queryId=6,titleCode='specialized_sme')['total'],1)
        self.assertEqual(self.read('summary',queryId=1,titleCode='specialized_sme')['total'],1)
        with self.assertRaises(ValueError):
            self.read('summary',queryId=7,titleCode='specialized_sme')

    def test_deep_page_and_status_counts_keep_filter_scope(self):
        self.assertEqual([r['query']['id'] for r in self.read('summary',page=2,pageSize=2)['rows']],[3,2])
        result=self.read('summary',status='failed',titleCode='specialized_sme')
        self.assertEqual(result['counts'],{'failed':1})
        self.assertEqual(result['rows'][0]['query']['id'],2)

    def test_byte_slice_and_null_empty_are_distinct(self):
        null = self.read('evidence',queryId=1,field='rawResponse')
        empty = self.read('evidence',queryId=2,field='rawResponse')
        piece = self.read('evidence',queryId=3,field='rawResponse',offset=2,length=4)
        self.assertTrue(null['isNull'])
        self.assertFalse(empty['isNull'])
        self.assertEqual(piece['data'],'svCfmQ==')  # UTF-8 bytes crossing both Chinese/emoji boundaries.
        self.assertEqual(piece['totalBytes'],10)
        self.assertTrue(piece['hasMore'])

    def test_relation_discovery_preserves_sequence_and_empty_page_count(self):
        result = self.read('evidence',queryId=1,field='relations')
        self.assertEqual(result['rows'],[{'id':8,'sequenceNo':1},{'id':9,'sequenceNo':2}])
        page = self.read('summary',page=20,pageSize=2)
        self.assertEqual(page['rows'],[])
        self.assertEqual(page['total'],5)


if __name__ == '__main__':
    unittest.main()
