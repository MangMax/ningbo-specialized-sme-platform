#!/usr/bin/env node
/**
 * RL-09 复核清单页的**真实浏览器**验收:`nuxt build` → 起 `.output/server/index.mjs`
 * → 真 Chrome → **桌面(1440×900)与窄屏(390×844)都量**。
 *
 * 与 `verify-prod-openapi.mjs` / `verify-ledger-ui.mjs` 同一分工:
 * **单元测试守「决定」(`tests/roster-review-*.test.ts`),这个脚本守「事实」** ——
 * 真排版下量出来的宽度、真渲染出来的行列、真点开抽屉里的出处、真点出来的加载状态。
 *
 * ── 它守的几条(每条都对应票面 #9 或本轮 UI 方向的一句话)────────────────
 *  ① 清单**是该年份到期的行**:到期年份列**每一格都等于目标年份**
 *    (守「三年规则 + 目标年份筛选」—— 少了年份筛选就会量到别的年份的行,立刻红);
 *  ② 列齐:企业名称 / 称号 / 到期年份 / 锚点(依据) / 批次;
 *  ③ 点开一行,**抽屉里给得出依据与出处**(「不允许只给一个名单」);
 *  ④ 待确认清单成区:切过去能看到「待确认原因」列;
 *  ⑤ 导出地址与列表**同一套筛选参数**(不带分页);
 *  ⑥ 桌面与窄屏都**没有页面级横向溢出**,分页条在视口内;
 *  ⑦ 界面形态:筛选控件是项目组件(**页面上不许有原生 `<select>`**)、**没有 tab 切换**、
 *    不出现解释性小字;
 *  ⑧ **翻页时出现「正在加载」**(给接口加人工延迟后判定,不靠等)。
 *
 * ── 「先把缺陷复原,确认断言会红」(本仓的验收规矩)──────────────────────
 * 本脚本写完后**逐条复原过一次缺陷**并确认对应断言变红(记录在 PR 描述里):
 *  - 去掉读模型里的 `lifecycle.dueYear !== filter.year` ⇒ ① 立刻报错(量到非目标年份的行);
 *  - 去掉表格的 `overflow-x-auto` 外层 ⇒ ⑥ 在窄屏报出具体溢出像素;
 *  - 把「正在加载」那一段去掉 ⇒ ⑧ 报错。
 *
 * 用法:
 *   NUXT_DB_PATH=/abs/path/roster.db node scripts/verify-review-ui.mjs [--port 3493] [--skip-build]
 * 退出码 0 = 全部通过;非 0 = 有一条不符合预期(并打印实测数字)。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { openAndMeasure, setLatency, sleep, startChrome, waitForHttp, withPage } from './lib/cdp.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(flag('port', '3493'))
const DEBUG_PORT = PORT + 1
const SKIP_BUILD = args.includes('--skip-build')
const BASE = `http://127.0.0.1:${PORT}`

/** 目标年份:与页面同一条口径(`defaultTargetYear` = 下一年)。 */
const TARGET_YEAR = new Date().getFullYear() + 1

const DESKTOP = { width: 1440, height: 900 }
const NARROW = { width: 390, height: 844 }

/** 表格的列(到期清单)。 */
const DUE_HEADERS = ['企业名称', '称号', '到期年份', '锚点(依据)', '批次', '来源']
const PENDING_HEADERS = ['企业名称', '称号', '暂定到期年份', '待确认原因', '批次', '来源']

/** 页面上不该出现的**解释性小字**(本轮 UI 方向:页面不解释,免得把界面写成说明书)。 */
const FORBIDDEN_TEXT = ['说明', '注意:', '此列表', '不得直接当工作单用', '不按目标年份筛', '口径:']

const problems = []
const ok = (msg) => console.log(`✓ ${msg}`)
const bad = (msg) => {
  console.log(`✗ ${msg}`)
  problems.push(msg)
}

function run(cmd, argv) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

/**
 * 就绪判据:**没有骨架屏**、且**表格里有数据行**、且**分页条在**。
 * 骨架屏自己也是 `tbody tr`,不排除它就会量到加载中的页面(RL-17 踩过这个坑)。
 */
const READY = `(() => (
  !document.querySelector('[data-slot=skeleton]') &&
  document.querySelectorAll('[data-testid=review-table] tbody tr').length > 0 &&
  !!document.querySelector('[data-slot=pagination]')
))()`

/** 在页面里量:溢出、分页条、列头、行内容、导出链接、计数、界面形态。 */
const MEASURE = `(() => {
  const de = document.documentElement;
  const table = document.querySelector('[data-testid=review-table]');
  const pagination = document.querySelector('[data-slot=pagination]');
  const rect = pagination ? pagination.getBoundingClientRect() : null;
  const headers = table ? [...table.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim()) : [];
  const rows = table ? [...table.querySelectorAll('tbody tr')] : [];
  const cell = (row, i) => (row.querySelectorAll('td')[i]?.textContent ?? '').trim();
  const exportLink = document.querySelector('[data-testid=review-export]');
  const yearTrigger = document.querySelector('[data-testid=review-year]');
  return {
    title: document.title,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: window.innerWidth,
    headers,
    rowCount: rows.length,
    dueYears: rows.map((r) => cell(r, 2)),
    titleCells: rows.map((r) => cell(r, 1)),
    nativeSelects: document.querySelectorAll('select').length,
    tablists: document.querySelectorAll('[role=tablist]').length,
    loadingVisible: !!document.querySelector('[data-testid=review-loading]'),
    countsText: (document.querySelector('[data-testid=review-counts]')?.textContent ?? '').trim(),
    bodyText: document.body.innerText,
    exportHref: exportLink ? exportLink.getAttribute('href') : null,
    yearTriggerText: yearTrigger ? (yearTrigger.textContent ?? '').trim() : null,
    pagination: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) } : null,
    paginationRows: pagination
      ? new Set([...pagination.querySelectorAll('[data-slot=pagination-item],[data-slot=pagination-previous],[data-slot=pagination-next]')]
          .map((el) => Math.round(el.getBoundingClientRect().top))).size
      : 0,
  };
})()`

/** 一条通用的溢出 + 分页条断言(桌面与窄屏共用)。 */
function checkLayout(m, label) {
  if (m.scrollWidth > m.clientWidth) {
    bad(`${label}:页面级横向溢出 ${m.scrollWidth - m.clientWidth}px(scrollWidth ${m.scrollWidth} / clientWidth ${m.clientWidth})`)
  } else {
    ok(`${label}:无页面级横向溢出(scrollWidth ${m.scrollWidth} ≤ clientWidth ${m.clientWidth})`)
  }
  if (!m.pagination) {
    bad(`${label}:没量到分页条 —— 这一页有数据就必须有分页条,量不到说明断言被跳过了`)
  } else if (m.pagination.right > m.innerWidth) {
    bad(`${label}:分页条越界,right=${m.pagination.right} > innerWidth=${m.innerWidth}`)
  } else {
    ok(`${label}:分页条在视口内(right ${m.pagination.right} ≤ ${m.innerWidth},宽 ${m.pagination.width},占 ${m.paginationRows} 行)`)
  }
}

/** 界面形态:不许有原生 `<select>`,不许有 tab 切换,不许出现解释性小字。 */
function checkShape(m, label) {
  if (m.nativeSelects) bad(`${label}:页面上有 ${m.nativeSelects} 个原生 <select> —— 筛选必须用项目组件`)
  else ok(`${label}:没有原生 <select>`)
  if (m.tablists) bad(`${label}:页面上有 ${m.tablists} 个 tab 列表 —— 本轮方向是「一张表」,不做 tab 切换`)
  else ok(`${label}:没有 tab 切换`)
  const hit = FORBIDDEN_TEXT.filter((s) => m.bodyText.includes(s))
  if (hit.length) bad(`${label}:页面出现解释性小字 ${JSON.stringify(hit)}`)
  else ok(`${label}:没有解释性小字`)
}

/** 列头断言。 */
function checkHeaders(m, label, expected) {
  const missing = expected.filter((h) => !m.headers.includes(h))
  if (missing.length) bad(`${label}:缺列 ${JSON.stringify(missing)}(现有 ${JSON.stringify(m.headers)})`)
  else ok(`${label}:列齐 ${JSON.stringify(m.headers)}`)
}

async function main() {
  const dbPath = process.env.NUXT_DB_PATH
  if (!dbPath) {
    throw new Error(
      '必须显式给 NUXT_DB_PATH 指向真库 —— worktree 里的 data/roster.db 是空的,量不到数据行。\n' +
        '  例:NUXT_DB_PATH=/abs/path/roster.db node scripts/verify-review-ui.mjs',
    )
  }
  if (!existsSync(resolve(dbPath))) throw new Error(`NUXT_DB_PATH 指向的库不存在:${dbPath}`)

  if (!SKIP_BUILD) {
    console.log('▶ pnpm build')
    await run('pnpm', ['build'])
  }
  if (!existsSync('.output/server/index.mjs')) {
    throw new Error('没有 .output/server/index.mjs —— 先 pnpm build,或去掉 --skip-build')
  }

  console.log(`▶ 起生产产物:PORT=${PORT} NUXT_DB_PATH=${dbPath}`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), NUXT_DB_PATH: dbPath },
  })

  let chrome
  try {
    await waitForHttp(`${BASE}/api/health`)
    console.log(`▶ 起 Chrome(--headless)调试端口 ${DEBUG_PORT}`)
    chrome = await startChrome({ debugPort: DEBUG_PORT })
    const cdp = chrome.cdp

    // ── ① 桌面:到期清单 ────────────────────────────────────────────────
    const dueUrl = `${BASE}/reviews?year=${TARGET_YEAR}`
    const due = await openAndMeasure(cdp, { url: dueUrl, viewport: DESKTOP, expression: MEASURE, readyExpression: READY })
    const dueLabel = `桌面 到期清单(/reviews?year=${TARGET_YEAR})`
    console.log(`\n▶ ${dueLabel}:${due.rowCount} 行 · 计数「${due.countsText}」`)

    checkLayout(due, dueLabel)
    checkShape(due, dueLabel)
    checkHeaders(due, dueLabel, DUE_HEADERS)

    const wrongYears = [...new Set(due.dueYears.filter((y) => y !== String(TARGET_YEAR)))]
    if (!due.rowCount) bad(`${dueLabel}:一行都没有 —— 断言无从成立,按失败算`)
    else if (wrongYears.length) {
      bad(`${dueLabel}:到期年份列出现非 ${TARGET_YEAR} 的年份 ${JSON.stringify(wrongYears.slice(0, 5))}`)
    } else ok(`${dueLabel}:${due.rowCount} 行的到期年份都等于目标年份 ${TARGET_YEAR}`)

    if (!due.title?.trim()) bad(`${dueLabel}:document.title 是空字符串`)
    else if (!due.title.includes(String(TARGET_YEAR))) bad(`${dueLabel}:document.title = ${JSON.stringify(due.title)},看不出是哪一年`)
    else ok(`${dueLabel}:document.title = ${JSON.stringify(due.title)}`)

    if (due.yearTriggerText && !due.yearTriggerText.includes(String(TARGET_YEAR))) {
      bad(`${dueLabel}:年份控件显示 ${JSON.stringify(due.yearTriggerText)},不是 ${TARGET_YEAR}`)
    } else ok(`${dueLabel}:年份控件显示 ${JSON.stringify(due.yearTriggerText)}`)

    if (!due.exportHref) bad(`${dueLabel}:没有导出链接`)
    else {
      const p = new URLSearchParams(new URL(due.exportHref, BASE).search)
      if (p.get('year') !== String(TARGET_YEAR)) bad(`${dueLabel}:导出链接年份不符 ${due.exportHref}`)
      else if (p.has('page') || p.has('pageSize')) bad(`${dueLabel}:导出链接带上了分页 ${due.exportHref}`)
      // 导出地址**必须**带上当前分层:接口把「没给 status」当成「两个工作表都写」,
      // 省掉它,「到期清单」页导出来的文件里就会多一个页面上没有的「待确认清单」。
      else if (p.get('status') !== 'due') bad(`${dueLabel}:导出链接没带 status=due ⇒ 会多导出一个工作表 ${due.exportHref}`)
      else ok(`${dueLabel}:导出链接自带 status=due ${due.exportHref}`)
    }

    // ── ③ 点开一行:抽屉里给得出依据与出处 ─────────────────────────────
    const drawer = await withPage(cdp, { url: dueUrl, viewport: DESKTOP, readyExpression: READY }, async (page) => {
      await page.click('[data-testid=review-row]')
      const opened = await page.waitUntil(`!!document.querySelector('[data-testid=review-detail]')`, 8000)
      if (!opened) return { opened: false }
      return {
        opened: true,
        text: await page.evaluate(`(() => {
          const el = document.querySelector('[data-testid=review-detail]');
          const ev = el.querySelector('[data-testid=review-detail-evidence]');
          return {
            body: (el.innerText ?? ''),
            evidence: (ev?.innerText ?? '').trim(),
          };
        })()`),
      }
    })
    if (!drawer.opened) bad(`${dueLabel}:点行没有打开侧边抽屉`)
    else {
      ok(`${dueLabel}:点行打开了侧边抽屉`)
      if (!drawer.text.evidence || drawer.text.evidence === '—') bad(`${dueLabel}:抽屉里没有出处`)
      else ok(`${dueLabel}:抽屉里有出处「${drawer.text.evidence.split('\n')[0]}」`)
      const missing = ['锚点依据', '首次认定', '批次', '来源', '到期年份'].filter((f) => !drawer.text.body.includes(f))
      if (missing.length) bad(`${dueLabel}:抽屉缺字段 ${JSON.stringify(missing)}`)
      else ok(`${dueLabel}:抽屉字段齐(锚点依据 / 首次认定 / 批次 / 来源 / 到期年份)`)
    }

    // ── ⑧ 翻页时要出现「正在加载」─────────────────────────────────────
    const loading = await withPage(cdp, { url: dueUrl, viewport: DESKTOP, readyExpression: READY }, async (page) => {
      // 接口只要几十毫秒,轮询根本抓不到那一瞬 —— 先给页面加 1.5s 人工延迟,
      // 断言才是确定的,而不是「大多数时候能过」。
      await setLatency(cdp, page.sessionId, 1500)
      const clicked = await page.click('[data-slot=pagination-next]')
      if (!clicked) return { clicked: false }
      const seen = await page.waitUntil(`!!document.querySelector('[data-testid=review-loading]')`, 8000)
      return { clicked: true, seen }
    })
    if (!loading.clicked) bad(`${dueLabel}:点不到「下一页」,加载状态无从验起`)
    else if (!loading.seen) bad(`${dueLabel}:翻页时没有出现「正在加载」状态`)
    else ok(`${dueLabel}:翻页时出现「正在加载」状态`)

    // ── ② 窄屏:到期清单 ────────────────────────────────────────────────
    const dueNarrow = await openAndMeasure(cdp, { url: dueUrl, viewport: NARROW, expression: MEASURE, readyExpression: READY })
    console.log('')
    checkLayout(dueNarrow, `窄屏 到期清单(/reviews?year=${TARGET_YEAR})`)

    // ── ④ 待确认清单(桌面 + 窄屏)──────────────────────────────────────
    const pendingUrl = `${BASE}/reviews?year=${TARGET_YEAR}&status=pending`
    const pending = await openAndMeasure(cdp, { url: pendingUrl, viewport: DESKTOP, expression: MEASURE, readyExpression: READY })
    const pendingLabel = '桌面 待确认清单(/reviews?status=pending)'
    console.log(`\n▶ ${pendingLabel}:${pending.rowCount} 行 · 计数「${pending.countsText}」`)
    checkLayout(pending, pendingLabel)
    checkShape(pending, pendingLabel)
    checkHeaders(pending, pendingLabel, PENDING_HEADERS)

    if (!pending.exportHref) bad(`${pendingLabel}:没有导出链接`)
    else {
      const p = new URLSearchParams(new URL(pending.exportHref, BASE).search)
      if (p.get('status') !== 'pending') bad(`${pendingLabel}:导出链接没带 status=pending ${pending.exportHref}`)
      else ok(`${pendingLabel}:导出链接自带 status=pending`)
    }

    // 待确认清单**不按年份筛**:它是确认队列,与目标年份无关。
    const pendingOtherYear = await openAndMeasure(cdp, {
      url: `${BASE}/reviews?year=2031&status=pending`,
      viewport: DESKTOP,
      expression: MEASURE,
      readyExpression: READY,
    })
    if (pendingOtherYear.rowCount !== pending.rowCount) {
      bad(`${pendingLabel}:换到 2031 年后行数变了(${pending.rowCount} → ${pendingOtherYear.rowCount}) —— 待确认清单本应不按年份筛`)
    } else ok(`${pendingLabel}:换年份行数不变(${pending.rowCount}),与「待确认清单不按年份筛」一致`)

    const pendingNarrow = await openAndMeasure(cdp, { url: pendingUrl, viewport: NARROW, expression: MEASURE, readyExpression: READY })
    console.log('')
    checkLayout(pendingNarrow, '窄屏 待确认清单(/reviews?status=pending)')

    // ── ⑤ 深链 + 称号筛选(用数据挑一个真有行的称号)──────────────────
    // 写死称号是不行的 —— 真实库里目前**没有小巨人记录**(那份工作簿还没导),
    // 写死就会去量一张空表,然后把「量不到」当成失败。
    const apiDue = await (await fetch(`${dueUrl.replace('/reviews?', '/api/roster/reviews?')}`)).json()
    const topTitle = Object.entries(apiDue.counts?.titles ?? {}).sort((a, b) => b[1].due - a[1].due)[0]?.[0]
    if (!topTitle) {
      bad(`${dueLabel}:接口的 counts.titles 是空的,拿不到可筛的称号`)
    } else {
      console.log(`\n▶ 该年份到期最多的称号:${topTitle}(接口 counts.due=${apiDue.counts.titles[topTitle].due})`)
      const filtered = await openAndMeasure(cdp, {
        url: `${BASE}/reviews?year=${TARGET_YEAR}&title=${topTitle}`,
        viewport: DESKTOP,
        expression: MEASURE,
        readyExpression: READY,
      })
      const filteredLabel = `桌面 深链(/reviews?year=${TARGET_YEAR}&title=${topTitle})`
      console.log(`▶ ${filteredLabel}:${filtered.rowCount} 行 · 计数「${filtered.countsText}」`)
      // 行数被分页截断,所以比**计数**而不是比行数。
      const shown = Number(filtered.countsText.replace(/[^\d]/g, ''))
      const expect = apiDue.counts.titles[topTitle].due
      if (shown !== expect) bad(`${filteredLabel}:页面计数 ${shown} ≠ 接口 counts.due ${expect}`)
      else ok(`${filteredLabel}:页面计数与接口 counts.due 一致(${shown})`)
      if (new Set(filtered.titleCells).size !== 1) {
        bad(`${filteredLabel}:行里出现了多个称号 ${JSON.stringify([...new Set(filtered.titleCells)])} —— 筛选没生效`)
      } else ok(`${filteredLabel}:行内只有该称号(${[...new Set(filtered.titleCells)][0]})`)
      if (filtered.dueYears.some((y) => y !== String(TARGET_YEAR))) bad(`${filteredLabel}:筛完出现非目标年份的行`)
      else ok(`${filteredLabel}:到期年份仍全为 ${TARGET_YEAR}`)
    }
  } finally {
    await chrome?.close()
    server.kill()
  }

  if (problems.length) {
    console.log(`\n✗ ${problems.length} 条不符合预期`)
    process.exit(1)
  }
  console.log(
    `\n✓ 桌面与窄屏都无横向溢出、分页条在视口内;到期年份全为 ${TARGET_YEAR};列齐;抽屉给得出依据与出处;` +
      '待确认清单成区且不按年份筛;翻页有加载状态;导出链接自带分层;筛选用项目组件、无 tab、无解释小字',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
