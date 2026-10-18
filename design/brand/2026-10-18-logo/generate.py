# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools==4.60.1"]
# ///
"""Reproduce the SVG family: uv run generate.py (no system fonts required)."""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset
import sys

ROOT = Path(__file__).resolve().parent
FONT = ROOT / 'source-font.ttf'
if not FONT.exists():
    font = instantiateVariableFont(TTFont(sys.argv[1]), {'wght': 600}, inplace=True)
    options = subset.Options()
    options.name_IDs = ['*']
    sub = subset.Subsetter(options=options)
    sub.populate(text='宁波专精特新企业称号台账')
    sub.subset(font)
    font.save(FONT)
font = TTFont(FONT)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
UPM = font['head'].unitsPerEm
BLUE = '#14417E'
INK = BLUE
MARK = '<path d="M8 8h10v48H8zM18 8l28 32v16L18 24zM46 28h10v28H46z"/><path d="M42 8h14v14z"/>'

def lettering(text, size, x=0, baseline=0):
    parts = []
    cursor = x
    for char in text:
        glyph = glyphs[cmap[ord(char)]]
        pen = SVGPathPen(glyphs)
        glyph.draw(pen)
        parts.append(f'<path transform="translate({cursor:g} {baseline:g}) scale({size/UPM:g} {-size/UPM:g})" d="{pen.getCommands()}"/>')
        cursor += glyph.width * size / UPM
    return ''.join(parts)

def svg(w, h, content, label):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{label}">{content}</svg>'

for suffix, markcolor, textcolor in [('', BLUE, INK), ('-mono', '#172B45', '#172B45'), ('-white', '#FFFFFF', '#FFFFFF')]:
    assets = {
        'symbol': svg(64, 64, f'<g fill="{markcolor}">{MARK}</g>', '宁波专精特新图形标'),
        'wordmark': svg(252, 52, f'<g fill="{textcolor}">{lettering("宁波专精特新", 40, 6, 41)}</g>', '宁波专精特新'),
        'lockup': svg(332, 64, f'<g fill="{markcolor}">{MARK}</g><g fill="{textcolor}">{lettering("宁波专精特新", 40, 80, 46)}</g>', '宁波专精特新'),
    }
    for name, content in assets.items():
        (ROOT / f'{name}{suffix}.svg').write_text(content)

for suffix, color in [('', BLUE), ('-mono', '#172B45'), ('-white', '#FFFFFF')]:
    compact = svg(16, 16, f'<path fill="{color}" d="M1 2h3v12H1zM4 2l8 8v4L4 6zM12 2h3v12h-3z"/>', '宁波专精特新小尺寸图形标')
    (ROOT / f'symbol-compact{suffix}.svg').write_text(compact)
symbol = (ROOT/'symbol.svg').read_text()
wordmark = (ROOT/'wordmark.svg').read_text()
lockup = (ROOT/'lockup.svg').read_text()
white = (ROOT/'lockup-white.svg').read_text()
mono = (ROOT/'lockup-mono.svg').read_text()
html = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>宁波专精特新 · 标识</title><style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:var(--foreground,#172b45)}header{padding:12px 0 22px}h1{font-size:23px;margin:8px 0;font-weight:600}p{font-size:13px;color:#607086;line-height:1.7;margin:0}.forms{display:grid;grid-template-columns:1fr 2fr;gap:12px}.sample{background:#f3f6fa;border-radius:12px;padding:22px;min-height:140px;display:flex;flex-direction:column;justify-content:space-between;gap:24px}.sample label{font-size:11px;color:#607086}.sample .art{display:flex;justify-content:center;align-items:center;min-height:62px}.sample svg{max-width:100%;height:auto}.hero{grid-column:1/-1;min-height:174px}.hero .art{padding:12px 0}.hero svg{width:380px}.variants{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.variants .sample{min-height:128px}.night{background:#111a2c}.night label{color:#b6c6db}.small{display:flex;gap:20px;align-items:center;padding:24px 16px 12px;flex-wrap:wrap}.small svg{display:block;background:#f3f6fa;border-radius:2px}.dark-sizes svg{background:transparent}.small span{font-size:11px;color:#607086;display:block;margin-top:10px}.note{border-top:1px solid #dce3ec;padding-top:16px;margin-top:16px;font-size:12px}@media(max-width:440px){.sample{padding:18px}.forms{grid-template-columns:1fr}.hero{grid-column:auto}.variants{grid-template-columns:1fr}.hero svg{width:100%}h1{font-size:21px}}
</style><header><p>宁波专精特新 · 品牌标识</p><h1>一份名录，一个清晰的入口。</h1><p>深蓝 · 几何 N · 名录折角</p></header><main><div class="forms"><section class="sample"><label>01 / 图形标</label><div class="art">SYMBOL</div></section><section class="sample"><label>02 / 文字标</label><div class="art">WORD</div></section><section class="sample hero"><label>03 / 图文组合</label><div class="art">LOCK</div></section></div><div class="variants"><section class="sample night"><label>深色背景 / 反白</label><div class="art">WHITE</div></section><section class="sample"><label>单色 / 印刷</label><div class="art">MONO</div></section></div><div class="small">SIZES</div><div class="small dark-sizes" style="background:#111a2c;border-radius:12px">DARKSIZE</div><div class="sample" style="margin-top:12px"><label>文字标下限 / 168px · 更小场景使用图形标搭配界面文字</label><div>TEXTMIN</div></div><p class="note">沿用项目深蓝 #14417E。图形取宁波首字母 N，右上折角呼应名录页角；16px 使用去折角的专用版。文字已转路径，全部 SVG 无字体、图片或网络依赖。</p></main></html>'''
for key, value in [('SYMBOL',symbol.replace('width="64"','width="80"').replace('height="64"','height="80"')),('WORD',wordmark),('LOCK',lockup),('WHITE',white),('MONO',mono),('DARKSIZE', '<div>'+(ROOT/'symbol-compact-white.svg').read_text()+'<span style="color:#b6c6db">16px 反白</span></div>'), ('TEXTMIN',wordmark.replace('width="252"', 'width="168"').replace('height="52"', 'height="34.667"')), ('SIZES',''.join(f'<div>{((ROOT/"symbol-compact.svg").read_text() if n==16 else symbol).replace("width=\"64\"",f"width=\"{n}\"").replace("height=\"64\"",f"height=\"{n}\"")}<span>{n}px</span></div>' for n in [16,24,32,48]))]:
    html = html.replace(key, value)
(ROOT/'preview.html').write_text(html)
print('Generated 12 SVG assets and preview.html')

if '--publish' in sys.argv:
    import shutil
    public = ROOT.parents[2] / 'public'
    brand = public / 'brand'
    brand.mkdir(parents=True, exist_ok=True)
    for asset in ROOT.glob('*.svg'):
        shutil.copyfile(asset, brand / asset.name)
    favicon = (ROOT/'symbol-compact.svg').read_text().replace(' fill="#14417E"', '')
    favicon = favicon.replace('<path', '<style>path{fill:#14417E}@media(prefers-color-scheme:dark){path{fill:#FFFFFF}}</style><path', 1)
    (public/'favicon.svg').write_text(favicon)
    print('Published SVG family to public/brand and adaptive favicon to public/favicon.svg')
