# /// script
# requires-python = ">=3.12"
# dependencies = ["reportlab==4.4.10"]
# ///
"""Create only synthetic OCR acceptance data under a fresh OS-temp root.

The page images are part of the acceptance material: they use A4 at 200 DPI
(the verification script requests 200 DPI through the existing API) and draw
the same headings/long table as the synthetic OCR text, so reviewers can
compare like with like. Nothing here touches a production database or file.
"""
import hashlib
import json
import sqlite3
import subprocess
import os
import sys
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

root = Path(sys.argv[1]).resolve()
if root.exists() and any(root.iterdir()):
    raise SystemExit('Fixture root must be empty')
root.mkdir(parents=True, exist_ok=True)
subprocess.run([os.environ.get('NODE_BINARY', 'node'), '--input-type=module', '-e', """
import { createRequire } from 'node:module';
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti');
const { initializeDb } = await createJiti(import.meta.url).import('./db/client.ts');
initializeDb({ dbPath: process.argv[1], create: true }).$client.close();
""", str(root / 'roster.db')], check=True)
files = root / 'files'
files.mkdir()

# pdfium (the server-side renderer) does not embed the built-in CID fonts and
# renders their CJK glyphs blank. Use an embedded TrueType CJK font when the
# machine has one; keep the CID font only as a fallback for non-macOS dev boxes.
CJK_TTF = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
if CJK_TTF.exists():
    pdfmetrics.registerFont(TTFont('FixtureCJK', str(CJK_TTF)))
    FONT = 'FixtureCJK'
else:
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    FONT = 'STSong-Light'
W, H = A4

source = '# 名单校对\n\n- 保留原始正文\n\n<table><tr><th colspan="2">公布名单</th></tr><tr><td rowspan="2">宁波甲企业</td><td>2026</td></tr><tr><td>复核</td></tr></table>\n\n```json\n{"企业":"甲"}\n```\n\n' + '<table><tr>' + ''.join(f'<th>字段{i}</th>' for i in range(18)) + '</tr><tr>' + ''.join(f'<td>内容{i}</td>' for i in range(18)) + '</tr></table>\n\n<img src="https://blocked.invalid/ocr.png" onerror="alert(1)"><script>window.__ocrExecuted=true</script>\n'
source = source.rstrip('\n')
(root / 'source.md').write_text(source)


def footer(pdf: Canvas, name: str, page: int, total: int) -> None:
    pdf.setFont(FONT, 10)
    pdf.setFillGray(0.35)
    pdf.drawString(40, 28, name)
    pdf.drawRightString(W - 40, 28, f'第 {page} / {total} 页')
    pdf.setFillGray(0)


def title(pdf: Canvas, text: str, y: float = H - 72, size: int = 18) -> None:
    pdf.setFont(FONT, size)
    pdf.drawString(40, y, text)


def grid(pdf: Canvas, x: float, y: float, widths: list[float], rows: list[float]) -> None:
    """Draw a simple table grid; y is the top edge."""
    pdf.setLineWidth(0.5)
    left = x
    for width in widths:
        left += width
        pdf.line(left, y, left, y - sum(rows))
    top = y
    for height in [0] + rows:
        top -= height
        pdf.line(x, top, x + sum(widths), top)


def draw_first_page(pdf: Canvas) -> None:
    title(pdf, '名单校对', y=H - 86, size=30)
    pdf.setFont(FONT, 15)
    pdf.drawString(46, H - 124, '• 保留原始正文')

    # 公布名单: header row + 宁波甲企业 (rowspan 2) / 2026 / 复核.
    x, y = 40, H - 168
    widths, rows = [315, 200], [38, 38, 38]
    grid(pdf, x, y, widths, rows)
    pdf.setFont(FONT, 15)
    pdf.drawCentredString(x + 257, y - 25, '公布名单')
    pdf.drawString(x + 10, y - 62, '宁波甲企业')
    pdf.drawString(x + widths[0] + 10, y - 62, '2026')
    pdf.drawString(x + widths[0] + 10, y - 100, '复核')

    # Code block.
    pdf.setFont(FONT, 14)
    pdf.rect(40, H - 360, 380, 62)
    pdf.drawString(52, H - 326, '{"企业":"甲"}')

    # 18-column long table, matching the OCR HTML table.
    x, y = 40, H - 392
    widths = [(W - 80) / 18] * 18
    rows = [34, 34]
    grid(pdf, x, y, widths, rows)
    pdf.setFont(FONT, 8)
    for index in range(18):
        cx = x + sum(widths[:index]) + widths[index] / 2
        pdf.drawCentredString(cx, y - 22, f'字段{index}')
        pdf.drawCentredString(cx, y - 56, f'内容{index}')

    pdf.setFont(FONT, 13)
    pdf.drawString(40, H - 516, '本页用于校对：标题、名单表、代码与 18 列长表。')


def draw_regular_page(pdf: Canvas, page: int) -> None:
    title(pdf, f'名单 第 {page} 页', size=30, y=H - 92)
    pdf.setFont(FONT, 15)
    pdf.drawString(46, H - 132, f'企业条目{page}')
    x, y = 40, H - 176
    widths = [(W - 80) / 6] * 6
    rows = [36, 44]
    grid(pdf, x, y, widths, rows)
    pdf.setFont(FONT, 11)
    for index in range(6):
        cx = x + sum(widths[:index]) + widths[index] / 2
        pdf.drawCentredString(cx, y - 24, f'字段{index}')
        pdf.drawCentredString(cx, y - 62, f'内容{index}')


for number, (name, count) in enumerate([('workbench-97.pdf', 97), ('second.pdf', 2)], 1):
    path = files / name
    pdf = Canvas(str(path), pagesize=A4)
    for page in range(1, count + 1):
        if number == 1 and page == 1:
            draw_first_page(pdf)
        elif number == 1 and page == 3:
            title(pdf, '本页暂未识别', size=32, y=H - 92)
            pdf.setFont(FONT, 16)
            pdf.drawString(46, H - 136, '这一页留给手工录入。')
        elif number == 1 and page == 47:
            title(pdf, '第47页', size=34, y=H - 96)
            pdf.setFont(FONT, 18)
            pdf.drawString(46, H - 144, '第47页企业')
        elif number == 1 and page == 97:
            title(pdf, '第97页', size=34, y=H - 96)
            pdf.setFont(FONT, 18)
            pdf.drawString(46, H - 144, '最终页企业')
        elif number == 2 and page == 1:
            title(pdf, '第二文件', size=34, y=H - 96)
            pdf.setFont(FONT, 18)
            pdf.drawString(46, H - 144, '独立正文')
        elif number == 2 and page == 2:
            title(pdf, '第二文件 · 第 2 页', size=30, y=H - 92)
        else:
            draw_regular_page(pdf, page)
        footer(pdf, name, page, count)
        pdf.showPage()
    pdf.save()
    data = path.read_bytes()
    db = sqlite3.connect(root / 'roster.db')
    db.execute('INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,source,kind,year,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', (number, name, name, 'pdf', len(data), hashlib.sha256(data).hexdigest(), 'jxj', 'announcement', 2026, '2026-10-17T00:00:00Z'))
    if number == 1:
        page_texts = {1: source, 2: '', 47: '# 第47页\n\n第47页企业', 97: '# 第97页\n\n最终页企业'}
        for page in range(1, 98):
            if page == 3:
                continue
            text = page_texts.get(page, f'# 名单\n\n企业条目{page}')
            db.execute('INSERT INTO ocr_result(file_id,page_no,markdown,raw,engine,model,channel,created_at) VALUES(?,?,?,?,?,?,?,?)', (number, page, text, json.dumps({'original': name, 'page': page}), 'paddleocr', '合成引擎', 'api', '2026-10-17T00:00:00Z'))
    else:
        for page, text in [(1, '# 第二文件\n\n独立正文'), (2, '# 第二文件 · 第 2 页\n\n第二页正文')]:
            db.execute('INSERT INTO ocr_result(file_id,page_no,markdown,raw,engine,model,channel,created_at) VALUES(?,?,?,?,?,?,?,?)', (number, page, text, json.dumps({'original': name, 'page': page}), 'paddleocr', '合成引擎', 'api', '2026-10-17T00:00:00Z'))
    db.commit()
    db.close()

db = sqlite3.connect(root / 'roster.db')
# A nonempty business sentinel makes accidental deletion/rewrites observable.
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
