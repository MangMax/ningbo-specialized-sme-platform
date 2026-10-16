#!/usr/bin/env node
/**
 * RL-10 的**真浏览器验收**:`nuxt build` → 起 `.output/server/index.mjs` → 真 Chrome
 * 按**桌面 1440×900 与窄屏 390×844** 各量一遍 → 点进去、跳过去、退回来。
 *
 * ── 为什么必须真浏览器 ──────────────────────────────────────────────────
 * 这一票要证的不是「某函数返回了 8」,而是三件只有真浏览器才成立的事:
 *  ① 台账/详情面板上**真的画出了**页码,并且它是一个**可点的链接**;
 *  ② 点下去**真的打开了那一页**(页图 `<img>` 的 `naturalWidth > 0` —— 图真的解码了,
 *     不是占位符);③ 从预览**返回**后台账的筛选与展开位置**原样还在**。
 * vitest 跑在裸 node 下(`environment: 'node'`),没有排版引擎、没有导航,量不出这些。
 *
 * 与 `scripts/verify-ledger-ui.mjs` 同一分工与同一套做法:单元测试守「决定」,
 * 这个脚本守「事实」;Chrome 走 CDP,连接用 Node 24 内置 `WebSocket`,零新依赖。
 *
 * ── 断言「会红」的自检(必须先做)──────────────────────────────────────
 * 这些断言**不是**只要页面能打开就绿。两种复原缺陷的红都实测过:
 *  ① **数据侧复原**:把 `--db` 指向**补页码之前**的库(每行 `page` 都是 NULL),
 *     `① 面板出现「第 8 页」链接` 与 `② 页图 p008 加载出来` 立刻红 —— 证明断言不是空转;
 *  ② **代码侧复原**:把 `RosterEnterprisePanel.vue` 里的 `<NuxtLink :to="pageHref(v)">`
 *     换回 `<span>第 {{ v.page }} 页</span>`,`①` 的 href 断言立刻红。
 *  没做这一步的验收,绿灯只说明「页面打开了」,不说明「这个功能在」。
 *
 * 用法:
 *   NUXT_DB_PATH=<真库> node scripts/verify-evidence-page-jump.mjs [--port 3492] [--skip-build]
 * 退出码:0 = 全部通过;1 = 有一条不符合预期(并打印实测数字);2 = 用法/环境问题。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(flag('port', '3492'))
const DEBUG_PORT = PORT + 1
const SKIP_BUILD = args.includes('--skip-build')
const BASE = `http://127.0.0.1:${PORT}`

/**
 * 验收用的库。worktree 里的 `data/roster.db` 是**空**的(已 gitignore),
 * 必须显式指向真库,否则面板上一条出处都没有 —— 量不到东西,断言会被「跳过」,
 * 而跳过看起来跟通过一样。所以下面**先拷一份**(连 `-wal` 一起,只拷主文件会看不见
 * WAL 里未 checkpoint 的行),再拿这份拷贝起服务。
 */
const DB_SOURCE = flag('db', process.env.NUXT_DB_PATH ?? '')
const WORK_DB = join(mkdtempSync(join(tmpdir(), 'rl10-verify-')), 'roster.db')

const F145 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'
const F_DOCX = 'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.docx'

/** 夹具(真库里的真行):204 = 补过页码的开诚(附件二 序号 6 → 第 8 页);
 *  6 = 同序号同文件但**没有页码**的培源(该显示「页码待核」);
 *  715 = 出处是 .docx 的立华制药(Word 没有可靠分页)。 */
const KAICHENG = 204
const PEIYUAN = 6
const LIHUA = 715
const KAICHENG_PAGE = 8

const DESKTOP = { width: 1440, height: 900 }
const NARROW = { width: 390, height: 844 }

const problems = []
const ok = (msg) => console.log(`✓ ${msg}`)
const bad = (msg) => {
  console.log(`✗ ${msg}`)
  problems.push(msg)
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error(`等不到 ${url}`)
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端(navigate / evaluate / click)
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const waiter = this.pending.get(msg.id)
      if (waiter) {
        this.pending.delete(msg.id)
        msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result)
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} 超时`))
      }, 30_000)
    })
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return new Cdp(ws)
}

async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result.value
}

/**
 * 轮询到就绪。**等不到就判失败**,不静默跳过 —— 静默跳过给出的是假的安心。
 *
 * 默认给到 **120s**:`/api/roster/enterprises` 每次要把整份名录快照读进内存
 * (静机实测单次 **6.3s**),冷启动的生产实例上第一次进页面会连着等好几个查询;
 * 而本机在多个 worktree 并行跑测试时 **load 会到 48–76**(实测 69),同一次等待会被拉长
 * 好几倍。等不到按失败算,但**超时要给得比负载抖动更宽** —— 否则红的是负载,不是代码。
 */
async function waitUntil(cdp, sessionId, expression, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return true
    await sleep(300)
  }
  return false
}

/**
 * 开一个**新 target**、按给定视口打开、等就绪、求值一次。
 * 每次新 target:复用 target 会带上上一页的滚动位置与文档状态,量出来的东西串味。
 */
async function openAndMeasure(cdp, url, expression, readyExpression, viewport) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...viewport, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url }, sessionId)
    if (readyExpression && !(await waitUntil(cdp, sessionId, readyExpression))) {
      throw new Error(`${url} 没有渲染出要等的东西 —— 量不出东西,按失败算`)
    }
    return await evaluate(cdp, sessionId, expression)
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

/** 在一个 target 里做一串动作(点击 → 等 → 再量),用于「点进去再退回来」。 */
async function openAndDrive(cdp, url, readyExpression, steps, viewport) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...viewport, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url }, sessionId)
    if (readyExpression && !(await waitUntil(cdp, sessionId, readyExpression))) {
      throw new Error(`${url} 没有就绪 —— 量不出东西,按失败算`)
    }
    return await steps({
      evaluate: (expr) => evaluate(cdp, sessionId, expr),
      waitUntil: (expr, timeoutMs) => waitUntil(cdp, sessionId, expr, timeoutMs),
      navigate: async (to) => {
        await cdp.send('Page.navigate', { url: to }, sessionId)
      },
      location: () => evaluate(cdp, sessionId, `(() => ({ path: location.pathname, search: location.search, href: location.href }))()`),
      sleep,
    })
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 页面探针
// ---------------------------------------------------------------------------

/**
 * 一个**页码链接**的判据:文本 `第 N 页`、`<a>`,且 `href` 指向 `/preview`。
 * 用 `closest('a')` 而不是「找 a 再读文本」:后者会把旁边的「预览」按钮一起捞进来。
 */
const PAGE_LINK_PROBE = `(() => {
  const anchors = [...document.querySelectorAll('a')];
  const hits = anchors
    .map((a) => ({ text: (a.textContent ?? '').trim(), href: a.getAttribute('href') ?? '', abs: a.href }))
    .filter((a) => /^第\\s*\\d+\\s*页$/.test(a.text) && a.href.includes('/preview'));
  return {
    hits,
    // 「页码待核」/ 「—」这两种**没有页码**的说法,用来证明「留空待核」真的画出来了。
    pendingWords: [...document.querySelectorAll('span,div')]
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => t === '页码待核' || t === '—').length,
    // 页码那一行的标签也算一个锚点:面板上到底有没有「页码」这一项。
    hasPageLabel: [...document.querySelectorAll('span,div')].some((el) => (el.textContent ?? '').trim() === '页码'),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
})()`

/** 在详情页把某条事件的「出处 N」展开(按钮文本可能是 出处 N / 收起出处)。 */
const EXPAND_EVIDENCE = `(() => {
  const btn = [...document.querySelectorAll('button')]
    .find((b) => /^(出处|收起出处)/.test((b.textContent ?? '').trim()));
  if (!btn) return false;
  btn.click();
  return true;
})()`

/**
 * 「这一条出处已经画出来了」的判据 —— 用**来源文件名带扩展名**当锚点。
 *
 * ⚠️ 这里**绝不能**拿「页码链接在不在」当就绪判据:那是**被测的那个东西**。用被测物当
 * ready 判据,缺陷一复原就变成「等不到 → 抛错退出」,而不是一条说得清的 ✗ —— 更糟的是
 * 反过来,一旦 ready 被别的东西满足,断言就被静默跳过了(`verify-ledger-ui.mjs` 的注释
 * 记过这个坑:第一版 `sleep(4500)` 没睡够,分页断言被静默跳过而脚本照样打印 ✓)。
 * 出处行不管有没有页码都会显示来源文件名,所以它是可靠的「已渲染」锚点。
 */
const EVIDENCE_ROWS_READY = `(() => /\\.(pdf|docx|xlsx|doc)\\b/i.test(document.body.innerText))()`

/** 预览页:落点是不是真的那一页。`img` 的 naturalWidth > 0 == 图真的解码出来了。 */
function previewProbe(pageNo) {
  return `(() => {
    const imgs = [...document.querySelectorAll('img')]
      .map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight }));
    const text = document.body.innerText;
    return {
      path: location.pathname,
      search: location.search,
      imgs,
      // 页图文件名是零填充的 pNNN.png(见 lib/pdf-page.ts 的 pageFileName)。
      wanted: ${JSON.stringify(`p${String(pageNo).padStart(3, '0')}.png`)},
      hasPageBadge: text.includes('第 ${pageNo} 页'),
      hasNotRenderedNote: text.includes('还没有渲染'),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  })()`
}

/** 页图真的解码出来了(而不是只有一个空 `<img>`)。 */
const pageImageLoaded = (probe) =>
  probe.imgs.some((i) => i.src.includes(probe.wanted) && i.w > 0 && i.h > 0)

// ---------------------------------------------------------------------------
// 各项检查
// ---------------------------------------------------------------------------

async function checkEvidencePanel(cdp) {
  // ① 台账展开面板:按企业视图 + 展开开诚那一行。
  //
  // 就绪判据是「页码链接真的出现」,**不是**「页面里有『页码』两个字」—— 台账的展开面板是
  // 一行紧凑的徽章条,页码在那里就是一个「第 N 页」链接,没有单独的字段名标签
  // (字段名标签那一版在完整企业详情页,见 ②)。
  const ledgerUrl = `${BASE}/?view=enterprise&q=%E5%BC%80%E8%AF%9A&expand=${KAICHENG}`
  const panel = await openAndDrive(cdp, ledgerUrl, EVIDENCE_ROWS_READY, async ({ evaluate: ev }) => ev(PAGE_LINK_PROBE), DESKTOP)

  const hit = panel.hits.find((h) => h.text === `第 ${KAICHENG_PAGE} 页`)
  if (!hit) {
    bad(`台账展开面板:没找到「第 ${KAICHENG_PAGE} 页」链接 —— 量到 ${JSON.stringify(panel.hits)}`)
  } else if (!hit.href.includes(`page=${KAICHENG_PAGE}`) || !hit.href.includes('file=')) {
    bad(`台账展开面板:href 没带页号/文件 —— ${hit.href}`)
  } else {
    ok(`台账展开面板:「第 ${KAICHENG_PAGE} 页」是可点链接 —— ${hit.href}`)
  }

  if (panel.scrollWidth > panel.clientWidth) {
    bad(`台账展开面板(桌面):横向溢出 ${panel.scrollWidth - panel.clientWidth}px`)
  }

  // ② 企业详情页:同一个页码也要在「出处」展开里有,且可点。
  const detail = await openAndDrive(
    cdp,
    `${BASE}/enterprises/${KAICHENG}`,
    `(() => !document.querySelector('[data-slot=skeleton]') && document.body.innerText.includes('出处'))()`,
    async ({ evaluate: ev, waitUntil: wu }) => {
      if (!(await ev(EXPAND_EVIDENCE))) throw new Error('详情页没有「出处」展开按钮')
      await wu(EVIDENCE_ROWS_READY, 60_000)
      return ev(PAGE_LINK_PROBE)
    },
    DESKTOP,
  )

  const detailHit = detail.hits.find((h) => h.text === `第 ${KAICHENG_PAGE} 页`)
  if (!detailHit) {
    bad(`企业详情:没找到「第 ${KAICHENG_PAGE} 页」链接 —— 量到 ${JSON.stringify(detail.hits)}`)
  } else {
    ok(`企业详情:「第 ${KAICHENG_PAGE} 页」可点 —— ${detailHit.href}`)
  }

  // ③ 没有页码的两条:PDF 但没核对 ⇒「页码待核」;.docx ⇒ 没有可跳的页。
  const pending = await openAndDrive(
    cdp,
    `${BASE}/enterprises/${PEIYUAN}`,
    `(() => !document.querySelector('[data-slot=skeleton]') && document.body.innerText.includes('出处'))()`,
    async ({ evaluate: ev, waitUntil: wu }) => {
      await ev(EXPAND_EVIDENCE)
      await wu(EVIDENCE_ROWS_READY, 60_000)
      return ev(PAGE_LINK_PROBE)
    },
    DESKTOP,
  )
  if (pending.hits.length !== 0) {
    bad(`未补页码的 PDF 出处不该有页码链接 —— 量到 ${JSON.stringify(pending.hits)}`)
  } else if (!pending.pendingWords) {
    bad('未补页码的 PDF 出处没有画出「页码待核」')
  } else {
    ok('未补页码的 PDF 出处:写「页码待核」,不给链接')
  }

  const wordDoc = await openAndDrive(
    cdp,
    `${BASE}/enterprises/${LIHUA}`,
    `(() => !document.querySelector('[data-slot=skeleton]') && document.body.innerText.includes('出处'))()`,
    async ({ evaluate: ev, waitUntil: wu }) => {
      await ev(EXPAND_EVIDENCE)
      await wu(EVIDENCE_ROWS_READY, 60_000)
      return ev(PAGE_LINK_PROBE)
    },
    DESKTOP,
  )
  if (wordDoc.hits.length !== 0) {
    bad(`Word 出处不该有页码链接 —— 量到 ${JSON.stringify(wordDoc.hits)}`)
  } else {
    ok('Word 出处:留空,不给页码链接(不跳到猜测页)')
  }

  return hit?.href ?? ''
}

async function checkJump(cdp, href) {
  if (!href) {
    bad('没有拿到跳转链接,后续跳转检查全部跳过不了 —— 按失败记')
    return
  }
  const url = new URL(href, BASE).toString()

  for (const [label, viewport] of [
    ['桌面 1440', DESKTOP],
    ['窄屏 390', NARROW],
  ]) {
    const probe = await openAndDrive(
      cdp,
      url,
      `(() => document.body.innerText.includes('第 ${KAICHENG_PAGE} 页'))()`,
      async ({ evaluate: ev, waitUntil: wu }) => {
        await wu(`(() => [...document.querySelectorAll('img')].some((i) => i.naturalWidth > 0))()`, 60_000)
        return ev(previewProbe(KAICHENG_PAGE))
      },
      viewport,
    )

    if (probe.path !== '/preview') {
      bad(`${label}:跳转落点不是 /preview —— ${probe.path}`)
    } else {
      ok(`${label}:跳转落点 /preview(带 page=${KAICHENG_PAGE})`)
    }
    if (!probe.hasPageBadge) {
      bad(`${label}:预览页看不出在看哪一页(没有「第 ${KAICHENG_PAGE} 页」)`)
    } else {
      ok(`${label}:预览页写明「第 ${KAICHENG_PAGE} 页」`)
    }
    if (!pageImageLoaded(probe)) {
      bad(`${label}:第 ${KAICHENG_PAGE} 页的页图没加载出来 —— 量到 ${JSON.stringify(probe.imgs)}`)
    } else {
      ok(`${label}:第 ${KAICHENG_PAGE} 页页图真的解码了(${probe.wanted})`)
    }
    if (probe.scrollWidth > probe.clientWidth) {
      bad(`${label}:预览页横向溢出 ${probe.scrollWidth - probe.clientWidth}px`)
    }
  }

  // 超范围页号(145号 只有 23 页):说清没渲染,**不静默降级成第 1 页**。
  const outOfRange = await openAndDrive(
    cdp,
    `${BASE}/preview?file=${encodeURIComponent(F145)}&page=999`,
    `(() => document.body.innerText.includes('还没有渲染'))()`,
    async ({ evaluate: ev }) => ev(previewProbe(999)),
    DESKTOP,
  )
  if (!outOfRange.hasNotRenderedNote) {
    bad('页号超出已渲染范围时没有说明「还没有渲染」——可能会被误读成定位成功')
  } else if (pageImageLoaded(outOfRange)) {
    bad('页号超出范围却加载出了页图 —— 说明落点错了')
  } else {
    ok('页号超出已渲染范围:明说「还没有渲染」,不假装定位成功')
  }

  // Word 来源即使被手工塞了 page 参数,也不该显示页码(它没有可复核的「第 N 页」)。
  const wordPreview = await openAndDrive(
    cdp,
    `${BASE}/preview?file=${encodeURIComponent(F_DOCX)}&page=5`,
    `(() => !document.querySelector('[data-slot=skeleton]'))()`,
    async ({ evaluate: ev, sleep: wait }) => {
      await wait(1500)
      return ev(`(() => ({ text: document.body.innerText, imgs: [...document.querySelectorAll('img')].length }))()`)
    },
    DESKTOP,
  )
  if (wordPreview.text.includes('第 5 页')) {
    bad('Word 来源被塞了 page=5 就显示了页码 —— 不该给没有可靠分页的文件定位')
  } else {
    ok('Word 来源带 page 参数也不显示页码(不跳到猜测页)')
  }
}

async function checkBackContext(cdp) {
  // 从台账(带筛选 + 展开)点进预览,再点「返回」——筛选与展开位置必须原样回来。
  const ledgerUrl = `${BASE}/?view=enterprise&q=%E5%BC%80%E8%AF%9A&expand=${KAICHENG}`
  const result = await openAndDrive(
    cdp,
    ledgerUrl,
    EVIDENCE_ROWS_READY,
    async ({ evaluate: ev, navigate, location, waitUntil: wu }) => {
      const href = await ev(`(() => {
        const a = [...document.querySelectorAll('a')].find((el) => /^第\\s*\\d+\\s*页$/.test((el.textContent ?? '').trim()));
        return a ? a.href : '';
      })()`)
      if (!href) return { href: '', beforeSearch: '', after: null }
      const before = await location()
      await navigate(href)
      await wu(`(() => location.pathname === '/preview')()`, 60_000)
      // 页面上那颗「返回」是 NuxtLink(`<a href="/?…">`),点它。
      const backHref = await ev(`(() => {
        const a = [...document.querySelectorAll('a')].find((el) => (el.getAttribute('href') ?? '').startsWith('/?'));
        return a ? a.getAttribute('href') : '';
      })()`)
      if (!backHref) return { href, beforeSearch: before.search, after: null, backHref: '' }
      await navigate(new URL(backHref, BASE).toString())
      await wu(`(() => location.pathname === '/' && !!document.querySelector('tbody tr'))()`, 60_000)
      const after = await location()
      return { href, beforeSearch: before.search, after, backHref }
    },
    DESKTOP,
  )

  if (!result.after) {
    bad(`返回上下文:没能走完「台账 → 预览 → 返回」(${JSON.stringify(result)})`)
    return
  }
  const before = new URLSearchParams(result.beforeSearch)
  const after = new URLSearchParams(result.after.search)
  const lost = ['view', 'q', 'expand'].filter((k) => before.get(k) !== after.get(k))
  if (lost.length) {
    bad(`返回后筛选/展开丢了 ${JSON.stringify(lost)}:前 ${result.beforeSearch} → 后 ${result.after.search}`)
  } else {
    ok(`返回后台账筛选与展开位置原样保留 —— ${result.after.search}`)
  }
}

// ---------------------------------------------------------------------------

async function main() {
  if (!DB_SOURCE) {
    console.error('要给 --db <真库路径>(或设 NUXT_DB_PATH)—— worktree 里的 data/roster.db 是空的。')
    process.exit(2)
  }
  if (!existsSync(DB_SOURCE)) {
    console.error(`库不存在:${DB_SOURCE}`)
    process.exit(2)
  }
  copyFileSync(DB_SOURCE, WORK_DB)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(DB_SOURCE + suffix)) copyFileSync(DB_SOURCE + suffix, WORK_DB + suffix)
  }

  if (!SKIP_BUILD) {
    console.log('▶ pnpm build')
    await run('pnpm', ['build'])
  }
  if (!existsSync('.output/server/index.mjs')) throw new Error('没有 .output/server/index.mjs —— 先 build')

  console.log(`▶ 起生产产物:PORT=${PORT},库=${DB_SOURCE}`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), NUXT_DB_PATH: WORK_DB },
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'rl10-chrome-'))
  let chrome
  let cdp

  try {
    await waitForHttp(`${BASE}/api/health`)

    const chromeBin =
      process.env.CHROME_BIN ??
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) =>
        existsSync(p),
      )
    if (!chromeBin) throw new Error('找不到 Chrome(可用 CHROME_BIN 指定)')

    console.log(`▶ 起 Chrome(--headless)调试端口 ${DEBUG_PORT}`)
    chrome = spawn(
      chromeBin,
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
    cdp = await connect(version.webSocketDebuggerUrl)

    const href = await checkEvidencePanel(cdp)
    await checkJump(cdp, href)
    await checkBackContext(cdp)
  } finally {
    try {
      await cdp?.send('Browser.close')
    } catch {
      /* ignore */
    }
    chrome?.kill()
    server.kill()
    await sleep(1000)
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
        break
      } catch {
        await sleep(500)
      }
    }
  }

  if (problems.length) {
    console.log(`\n✗ ${problems.length} 条不符合预期`)
    process.exit(1)
  }
  console.log('\n✓ 面板画出可点页码 · 点进去真的打开那一页 · 无页码留空待核 · 返回保留筛选')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
