# /// script
# requires-python = ">=3.12"
# dependencies = ["reportlab==4.4.10"]
# ///
"""Create only synthetic OCR acceptance data under a fresh OS-temp root."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas

root = Path(sys.argv[1]).resolve()
if root.exists() and any(root.iterdir()):
    raise SystemExit('Fixture root must be empty')
root.mkdir(parents=True, exist_ok=True)
files = root / 'files'
files.mkdir()
source = '# 名单校对\n\n- 保留原始正文\n\n<table><tr><th colspan="2">公布名单</th></tr><tr><td rowspan="2">宁波甲企业</td><td>2026</td></tr><tr><td>复核</td></tr></table>\n\n```json\n{"企业":"甲"}\n```\n\n' + '<table><tr>' + ''.join(f'<th>字段{i}</th>' for i in range(18)) + '</tr><tr>' + ''.join(f'<td>内容{i}</td>' for i in range(18)) + '</tr></table>\n\n<img src="https://blocked.invalid/ocr.png" onerror="alert(1)"><script>window.__ocrExecuted=true</script>\n'
source = source.rstrip('\n')
(root / 'source.md').write_text(source)
db = sqlite3.connect(root / 'roster.db')
db.execute('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)')
journal = json.loads(Path('db/migrations/meta/_journal.json').read_text())
for entry in journal['entries']:
    migration = Path('db/migrations') / (entry['tag'] + '.sql')
    sql = migration.read_text()
    db.executescript(sql)
    db.execute('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)', (hashlib.sha256(sql.encode()).hexdigest(), entry['when']))
for number, (name, count) in enumerate([('workbench-97.pdf', 97), ('second.pdf', 2)], 1):
    path = files / name
    pdf = Canvas(str(path), pagesize=(210, 297))
    for page in range(1, count + 1):
        pdf.drawString(20, 260, f'OCR acceptance - {name} page {page}')
        pdf.showPage()
    pdf.save()
    data = path.read_bytes()
    db.execute('INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,source,kind,year,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', (number,name,name,'pdf',len(data),hashlib.sha256(data).hexdigest(),'jxj','announcement',2026,'2026-10-17T00:00:00Z'))
    for page, text in ([(page, {1: source, 2: '', 47: '# 第47页\n\n第47页企业', 97: '# 第97页\n\n最终页企业'}.get(page, f'# 名单\n\n企业条目{page}')) for page in range(1, 98) if page != 3] if number == 1 else [(1, '# 第二文件\n\n独立正文')]):
        db.execute('INSERT INTO ocr_result(file_id,page_no,markdown,raw,engine,model,channel,created_at) VALUES(?,?,?,?,?,?,?,?)', (number,page,text,json.dumps({'original':name,'page':page}),'paddleocr','合成引擎','api','2026-10-17T00:00:00Z'))
# A nonempty business sentinel makes accidental deletion/rewrites observable.
db.execute("INSERT INTO title(code,name_zh,level,rank) VALUES ('specialized_sme','专精特新中小企业','municipal',2)")
db.execute("INSERT INTO enterprise(id,name,name_norm) VALUES (1,'隔离校验企业','隔离校验企业')")
db.execute("INSERT INTO record(id,enterprise_id,title_code,source) VALUES (1,1,'specialized_sme','jxj')")
db.execute("INSERT INTO record_event(id,record_id,event_type,year) VALUES (1,1,'award',2026)")
db.execute("INSERT INTO record_evidence(id,record_event_id,source_file,page) VALUES (1,1,'workbench-97.pdf',47)")
db.execute("INSERT INTO stored_file_part(file_id,title_code,event_kind,year,row_count,origin) VALUES (1,'specialized_sme','award',2026,1,'agent')")
db.commit()
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
db.close()
print(root)
