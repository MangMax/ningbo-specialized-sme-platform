"""CLI checks for the prepared isolated comparator; no app/business database."""
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class ComparatorCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hits = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                cls.hits.append(self.path)
                if self.path == '/disconnect':
                    self.connection.shutdown(2)
                    self.connection.close()
                    return
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/redirect-target')
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('X-Workload-Sql-Ms', '1.25')
                self.end_headers()
                self.wfile.write(b'not-json' if self.path == '/invalid-json' else b'{"ok":true}')

            def do_POST(self):
                cls.hits.append('POST')
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def run_cli(self, cases, *extra):
        with tempfile.TemporaryDirectory(prefix='spike90-comparator-') as folder:
            manifest, output = Path(folder) / 'manifest.json', Path(folder) / 'result.json'
            manifest.write_text(json.dumps({'cases': cases}))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('compare_public.py')),
                                     '--manifest', str(manifest), '--output', str(output),
                                     '--sqlite-url', self.url, '--postgres-url', self.url,
                                     '--candidate-sha', 'test-fixture', *extra], capture_output=True, text=True)
            return result, json.loads(output.read_text()) if output.exists() else None

    def case(self, path='/ok', **changes):
        return {'name': 'fixture', 'method': 'GET', 'path': path,
                'expectedStatus': 200, 'samples': 2, 'concurrency': [1], **changes}

    def test_same_json_is_equivalent_and_retains_each_sample(self):
        result, report = self.run_cli([self.case()])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report['cases']['fixture']['semantic_equivalent'])
        self.assertEqual(len(report['cases']['fixture']['sqlite']['hot']['1']['samples']), 2)
        self.assertEqual(report['cases']['fixture']['sqlite']['first']['server_metrics']['Sql-Ms'], 1.25)

    def test_empty_manifest_is_rejected(self):
        result, report = self.run_cli([])
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(report)

    def test_unmarked_post_requires_explicit_write_opt_in(self):
        before = self.hits.count('POST')
        result, report = self.run_cli([self.case(method='POST', body={})])
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(report)
        self.assertEqual(self.hits.count('POST'), before)

    def test_opted_in_post_can_run(self):
        result, report = self.run_cli([self.case(method='POST', body={})], '--enable-isolated-writes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report['cases']['fixture']['semantic_equivalent'])

    def test_invalid_json_is_recorded_and_fails_equivalence(self):
        result, report = self.run_cli([self.case('/invalid-json')])
        self.assertEqual(result.returncode, 2)
        sample = report['cases']['fixture']['sqlite']['first']
        self.assertEqual(sample['error'], 'invalid_json')
        self.assertEqual(sample['status'], 200)
        self.assertFalse(report['cases']['fixture']['semantic_equivalent'])

    def test_disconnect_is_recorded_and_all_samples_are_retained(self):
        result, report = self.run_cli([self.case('/disconnect')])
        self.assertEqual(result.returncode, 2)
        side = report['cases']['fixture']['sqlite']
        self.assertEqual(side['first']['error'], 'RemoteDisconnected')
        self.assertEqual(side['hot']['1']['failed_samples'], 2)
        self.assertEqual(len(side['hot']['1']['samples']), 2)
        self.assertFalse(report['cases']['fixture']['semantic_equivalent'])

    def test_expected_status_is_checked_even_when_backends_match(self):
        result, report = self.run_cli([self.case(expectedStatus=201)])
        self.assertEqual(result.returncode, 2)
        self.assertFalse(report['cases']['fixture']['semantic_equivalent'])

    def test_redirect_is_not_followed_and_fails_equivalence(self):
        before = self.hits.count('/redirect-target')
        result, report = self.run_cli([self.case('/redirect')])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.hits.count('/redirect-target'), before)
        self.assertEqual(report['cases']['fixture']['sqlite']['first']['status'], 302)
        self.assertFalse(report['cases']['fixture']['semantic_equivalent'])


if __name__ == '__main__':
    unittest.main()
