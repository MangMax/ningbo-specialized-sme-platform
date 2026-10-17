#!/usr/bin/env node
/**
 * Real-Chrome RL-10 return-chain regression with a temporary DB and synthetic API data.
 * Exercises title view → detail → PDF preview → detail → title view, plus enterprise
 * list → expanded row → full detail → list, at desktop and narrow viewports.
 * No official source documents or OCR results are used.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { minimalPdf } from '../tests/helpers/minimal-pdf.ts'
import { startIsolatedNuxt, stopOwnedChild, waitForChromeDevTools } from './lib/isolated-local-services.mjs'

const PORT_HINT = Number(process.argv[2] ?? process.env.RL10_TEST_PORT ?? 0)
let BASE
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'rl10-return-chain-'))
const FILES_ROOT = join(TEMP_ROOT, 'files')
const API_TOKEN = randomBytes(32).toString('hex')
const SOURCE_FILE = 'jxj/announcement/2024/1/rl10-synthetic-return.pdf'
const VIEWPORTS = [
  { label: 'desktop 1280×800', width: 1280, height: 800, detailScrollY: 106.5, listScrollY: 96 },
  { label: 'narrow 390×844', width: 390, height: 844, detailScrollY: 94.5, listScrollY: 296 },
]

async function postJson(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(result)}`)
  return result
}

async function seedViaApplicationApis() {
  const sourceAbs = join(FILES_ROOT, SOURCE_FILE)
  mkdirSync(dirname(sourceAbs), { recursive: true })
  writeFileSync(sourceAbs, minimalPdf({ pages: 1 }))

  await postJson('/api/files/register', {
    relPath: SOURCE_FILE,
    source: 'jxj',
    kind: 'announcement',
    year: '2024',
    batch: '1',
  })

  const records = Array.from({ length: 220 }, (_, i) => ({
    enterprise: {
      name: `宁波 RL10 浏览器回归企业 ${String(i + 1).padStart(3, '0')} 有限公司`,
      uscc: null,
      district: '海曙区',
    },
    titleCode: 'specialized_sme',
    events: [{
      eventType: 'award',
      year: 2024,
      batchSeq: 1,
      evidence: [
        {
          sourceFile: SOURCE_FILE,
          attachment: '合成附件一',
          listNo: 1,
          page: 1,
        },
      ],
    }],
  }))
  const request = {
    idempotencyKey: 'rl10-browser-return-chain-20261017#synthetic',
    sourceKind: 'announcement',
    sourceIdentity: SOURCE_FILE,
    payload: {
      announcement: {
        sourceDocument: {
          source: 'jxj',
          title: 'RL-10 合成浏览器回归夹具',
          docNumber: 'RL10-SYNTHETIC-20261017',
        },
        records,
      },
    },
  }
  await postJson('/api/roster/import/preflight', request)
  const committed = await postJson('/api/roster/import/commit', request)
  if (committed.status !== 'committed' || committed.summary?.failed !== 0) {
    throw new Error(`synthetic batch did not commit cleanly: ${JSON.stringify(committed)}`)
  }
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.sequence = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      let timeout
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`))
      }, 30_000)
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
  return response.result.value
}

async function waitUntil(cdp, sessionId, expression, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, sessionId, expression)) return
    } catch {
      // A navigation can replace the execution context between polls.
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function navigate(cdp, sessionId, url) {
  await cdp.send('Page.navigate', { url }, sessionId)
}

async function startChrome() {
  const chromePath = process.env.CHROME_BIN ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path) => existsSync(path))
  if (!chromePath) throw new Error('Chrome not found; set CHROME_BIN to its executable')

  const profile = mkdtempSync(join(tmpdir(), 'rl10-return-chain-chrome-'))
  let chrome
  try {
    chrome = spawn(chromePath, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      'about:blank',
    ], { stdio: 'ignore' })
    const version = await waitForChromeDevTools(chrome, profile)
    const cdp = new Cdp(new WebSocket(version.webSocketDebuggerUrl))
    await new Promise((resolve, reject) => {
      cdp.socket.addEventListener('open', resolve, { once: true })
      cdp.socket.addEventListener('error', reject, { once: true })
    })
    return { chrome, cdp, profile }
  } catch (error) {
    await stopOwnedChild(chrome)
    rmSync(profile, { recursive: true, force: true })
    throw error
  }
}

async function setViewport(cdp, sessionId, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId)
}

async function openInitialLedger(cdp, sessionId, path, title) {
  await navigate(cdp, sessionId, `${BASE}${path}`)
  const titleMatch = JSON.stringify(title)
  await waitUntil(
    cdp,
    sessionId,
    `document.title.includes(${titleMatch}) && !!document.querySelector('[data-evidence-return-scroll-container]')`,
  )
  await evaluate(cdp, sessionId, `(() => {
    if (document.getElementById('rl10-window-scroll-fixture')) return;
    const filler = document.createElement('section');
    filler.id = 'rl10-window-scroll-fixture';
    filler.textContent = 'Synthetic browser scroll fixture';
    filler.style.cssText = 'position:absolute;top:850px;left:0;width:1px;height:1200px;z-index:-1;pointer-events:none;';
    document.body.appendChild(filler);
  })()`)
  await evaluate(cdp, sessionId, 'sessionStorage.clear()')
}

async function setScrollOffsets(cdp, sessionId, { tableTop, windowTop }) {
  return evaluate(cdp, sessionId, `(() => {
    const scroller = document.querySelector('[data-evidence-return-scroll-container]');
    if (!scroller) throw new Error('roster scroll container missing');
    scroller.scrollTop = Math.min(${tableTop}, scroller.scrollHeight - scroller.clientHeight - 1);
    window.scrollTo({ top: ${windowTop}, behavior: 'instant' });
    return {
      tableTop: scroller.scrollTop,
      tableMax: scroller.scrollHeight - scroller.clientHeight,
      windowTop: window.scrollY,
      windowMax: document.documentElement.scrollHeight - window.innerHeight,
    };
  })()`)
}

async function runTitlePreviewReturn(cdp, sessionId, viewport) {
  await setViewport(cdp, sessionId, viewport)
  await openInitialLedger(cdp, sessionId, '/?view=title&page=2&pageSize=100', '按企业×称号')
  await waitUntil(cdp, sessionId, "document.querySelectorAll('[data-evidence-return-scroll-container] tbody tr').length > 0")

  const before = await setScrollOffsets(cdp, sessionId, { tableTop: 1538.5, windowTop: viewport.listScrollY })
  assert(before.tableTop > 0, `${viewport.label}: title table did not scroll: ${JSON.stringify(before)}`)
  assert(Math.abs(before.tableTop - 1538.5) <= 1,
    `${viewport.label}: title table could not reach the measured return offset: ${JSON.stringify(before)}`)
  assert(before.windowTop > 0, `${viewport.label}: title page window did not scroll: ${JSON.stringify(before)}`)
  await sleep(150)

  const detailHref = await evaluate(cdp, sessionId, `(() => {
    const scroller = document.querySelector('[data-evidence-return-scroll-container]');
    const box = scroller.getBoundingClientRect();
    const link = [...scroller.querySelectorAll('a[href^="/enterprises/"]')].find((a) => {
      const r = a.getBoundingClientRect();
      return r.bottom > box.top && r.top < box.bottom;
    });
    if (!link) throw new Error('visible title-view company name link missing');
    const url = new URL(link.href);
    const back = new URLSearchParams(url.searchParams.get('back'));
    if (back.get('view') !== 'title' || back.get('page') !== '2' || back.get('pageSize') !== '100') {
      throw new Error('title-view name link lost its return query: ' + link.href);
    }
    link.click();
    return url.pathname + url.search;
  })()`)
  await waitUntil(cdp, sessionId, `location.pathname.startsWith('/enterprises/') && !!document.querySelector('h1')`)
  const detailPath = await evaluate(cdp, sessionId, 'location.pathname + location.search')
  assert(detailPath === detailHref, `${viewport.label}: title link navigated to ${detailPath}, expected ${detailHref}`)
  await waitUntil(cdp, sessionId, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith('出处 '))")

  await evaluate(cdp, sessionId, `(() => {
    const disclosure = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('出处 '));
    disclosure.click();
  })()`)
  await waitUntil(cdp, sessionId, "[...document.querySelectorAll('a[href^=\"/preview\"]')].some((a) => a.textContent.includes('第 1 页'))")
  const sourceState = await evaluate(cdp, sessionId, `(() => {
    const pageLink = [...document.querySelectorAll('a[href^="/preview"]')].find((a) => a.textContent.includes('第 1 页'));
    if (!pageLink) throw new Error('opened detail evidence did not expose its PDF page link');
    const url = new URL(pageLink.href);
    if (url.searchParams.get('back') !== location.pathname + location.search) {
      throw new Error('detail PDF link did not preserve the full detail route');
    }
    window.scrollTo({ top: ${viewport.detailScrollY}, behavior: 'instant' });
    return { href: url.pathname + url.search, scrollY: window.scrollY };
  })()`)
  assert(sourceState.scrollY > 0, `${viewport.label}: detail page did not scroll: ${JSON.stringify(sourceState)}`)
  await evaluate(cdp, sessionId, 'window.__rl10ScrollCalls.length = 0')
  await evaluate(cdp, sessionId, `document.querySelector('a[href^="${sourceState.href.split('?')[0]}"]').click()`)
  await waitUntil(cdp, sessionId, "location.pathname === '/preview' && [...document.querySelectorAll('a')].some((a) => a.textContent.includes('返回'))")
  await evaluate(cdp, sessionId, 'window.__rl10ScrollCalls.length = 0')

  const returnToDetail = await evaluate(cdp, sessionId, `(() => {
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent.includes('返回') && a.href.includes('/enterprises/'));
    if (!link) throw new Error('PDF preview return link to detail missing');
    const router = document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router;
    const target = link.getAttribute('href');
    const resolved = router.resolve(target);
    const meta = resolved.meta.scrollToTop;
    const scrollToTop = typeof meta === 'function' ? meta(resolved, router.currentRoute.value) : meta;
    link.click();
    return {
      href: link.href,
      resolvedPath: resolved.fullPath,
      matched: resolved.matched.length,
      scrollToTop,
      saved: sessionStorage.getItem('roster:evidence-preview-return'),
    };
  })()`)
  await waitUntil(cdp, sessionId, `location.pathname.startsWith('/enterprises/') && !!document.querySelector('h1')`)
  await sleep(600)
  const detailAfter = await evaluate(cdp, sessionId, `({
    path: location.pathname + location.search,
    scrollY: window.scrollY,
    opened: [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('收起出处')).length,
    calls: window.__rl10ScrollCalls,
  })`)
  assert(detailAfter.path === new URL(returnToDetail.href).pathname + new URL(returnToDetail.href).search,
    `${viewport.label}: preview returned to wrong detail route: ${JSON.stringify(detailAfter)}`)
  assert(returnToDetail.scrollToTop === false,
    `${viewport.label}: Nuxt did not suppress its preview-return top reset: ${JSON.stringify(returnToDetail)}`)
  assert(Math.abs(detailAfter.scrollY - sourceState.scrollY) <= 2,
    `${viewport.label}: detail scroll changed ${sourceState.scrollY}→${detailAfter.scrollY}; route decision ${JSON.stringify(returnToDetail)}, route state ${JSON.stringify(detailAfter)}`)
  assert(detailAfter.opened > 0, `${viewport.label}: evidence disclosure collapsed after PDF return`)
  assert(!detailAfter.calls.some((call) => call.top === 0),
    `${viewport.label}: Nuxt applied a later top:0 after detail restore: ${JSON.stringify(detailAfter.calls)}`)

  await evaluate(cdp, sessionId, `(() => {
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent.includes('名录台账') && a.href.includes('view=title'));
    if (!link) throw new Error('title-view breadcrumb return link missing');
    link.click();
  })()`)
  await evaluate(cdp, sessionId, 'window.__rl10ScrollCalls.length = 0')
  await waitUntil(cdp, sessionId, `location.pathname === '/' && new URLSearchParams(location.search).get('view') === 'title' && new URLSearchParams(location.search).get('page') === '2' && !!document.querySelector('[data-evidence-return-scroll-container]')`)
  await sleep(600)
  const ledgerAfter = await evaluate(cdp, sessionId, `({
    path: location.pathname + location.search,
    tableTop: document.querySelector('[data-evidence-return-scroll-container]').scrollTop,
    windowTop: window.scrollY,
    calls: window.__rl10ScrollCalls,
    state: sessionStorage.getItem('roster:evidence-preview-return'),
  })`)
  assert(new URLSearchParams(new URL(`${BASE}${ledgerAfter.path}`).search).get('view') === 'title',
    `${viewport.label}: title view lost after return: ${JSON.stringify(ledgerAfter)}`)
  assert(new URLSearchParams(new URL(`${BASE}${ledgerAfter.path}`).search).get('page') === '2',
    `${viewport.label}: title page lost after return: ${JSON.stringify(ledgerAfter)}`)
  assert(new URLSearchParams(new URL(`${BASE}${ledgerAfter.path}`).search).get('pageSize') === '100',
    `${viewport.label}: title page size lost after return: ${JSON.stringify(ledgerAfter)}`)
  assert(Math.abs(ledgerAfter.tableTop - before.tableTop) <= 2,
    `${viewport.label}: title table scroll changed ${before.tableTop}→${ledgerAfter.tableTop}`)
  assert(Math.abs(ledgerAfter.windowTop - before.windowTop) <= 2,
    `${viewport.label}: title window scroll changed ${before.windowTop}→${ledgerAfter.windowTop}`)
  assert(!ledgerAfter.calls.some((call) => call.top === 0),
    `${viewport.label}: Nuxt applied a later top:0 after title restore: ${JSON.stringify(ledgerAfter.calls)}`)
  assert(ledgerAfter.state === null, `${viewport.label}: title return state was not consumed`)

  console.log(`✓ ${viewport.label} title → PDF → detail → title: detail ${sourceState.scrollY}→${detailAfter.scrollY}, evidence open; table ${before.tableTop}→${ledgerAfter.tableTop}, window ${before.windowTop}→${ledgerAfter.windowTop}`)
}

async function runExpandedEnterpriseReturn(cdp, sessionId, viewport) {
  await setViewport(cdp, sessionId, viewport)
  await openInitialLedger(cdp, sessionId, '/?page=2&pageSize=100', '按企业')

  await waitUntil(cdp, sessionId, "[...document.querySelectorAll('[data-evidence-return-scroll-container] button')].some((b) => b.textContent.trim() === '展开')")
  const before = await setScrollOffsets(cdp, sessionId, { tableTop: 1538.5, windowTop: viewport.listScrollY })
  assert(before.tableTop > 0, `${viewport.label}: enterprise table did not scroll: ${JSON.stringify(before)}`)
  assert(Math.abs(before.tableTop - 1538.5) <= 1,
    `${viewport.label}: enterprise table could not reach the measured return offset: ${JSON.stringify(before)}`)

  await evaluate(cdp, sessionId, `(() => {
    const scroller = document.querySelector('[data-evidence-return-scroll-container]');
    const box = scroller.getBoundingClientRect();
    const button = [...scroller.querySelectorAll('button')].find((b) => {
      const r = b.getBoundingClientRect();
      return b.textContent.trim() === '展开' && r.bottom > box.top && r.top < box.bottom;
    });
    if (!button) throw new Error('visible enterprise row expand button missing');
    const row = button.closest('tr');
    if (!row?.querySelector('button[title]')) throw new Error('expanded enterprise row identity missing');
    button.click();
  })()`)
  await waitUntil(cdp, sessionId, "[...document.querySelectorAll('a')].some((a) => a.textContent.includes('完整企业页'))")

  const stateBeforeDetail = await setScrollOffsets(cdp, sessionId, { tableTop: before.tableTop, windowTop: viewport.listScrollY })
  const detailHref = await evaluate(cdp, sessionId, `(() => {
    const scroller = document.querySelector('[data-evidence-return-scroll-container]');
    const link = [...scroller.querySelectorAll('a')].find((a) => a.textContent.includes('完整企业页'));
    if (!link) throw new Error('full detail link missing in expanded enterprise row');
    const url = new URL(link.href);
    const back = new URLSearchParams(url.searchParams.get('back'));
    if (back.get('page') !== '2' || back.get('pageSize') !== '100' || back.get('expand') === null) {
      throw new Error('expanded return query missing page/pageSize/expand: ' + link.href);
    }
    link.click();
    return url.pathname + url.search;
  })()`)
  await waitUntil(cdp, sessionId, `location.pathname.startsWith('/enterprises/') && !!document.querySelector('h1')`)
  assert(await evaluate(cdp, sessionId, 'location.pathname + location.search') === detailHref,
    `${viewport.label}: enterprise full-detail navigation path mismatch`)
  await evaluate(cdp, sessionId, 'window.__rl10ScrollCalls.length = 0')

  const backHref = await evaluate(cdp, sessionId, `(() => {
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent.includes('名录台账') && a.href.includes('expand='));
    if (!link) throw new Error('expanded enterprise breadcrumb return missing');
    link.click();
    return link.href;
  })()`)
  await waitUntil(cdp, sessionId, `location.pathname === '/' && new URLSearchParams(location.search).get('page') === '2' && new URLSearchParams(location.search).get('expand') !== null && !!document.querySelector('[data-evidence-return-scroll-container]')`)
  await waitUntil(cdp, sessionId, "[...document.querySelectorAll('a')].some((a) => a.textContent.includes('完整企业页'))")
  await sleep(600)

  const after = await evaluate(cdp, sessionId, `({
    path: location.pathname + location.search,
    tableTop: document.querySelector('[data-evidence-return-scroll-container]').scrollTop,
    windowTop: window.scrollY,
    expanded: [...document.querySelectorAll('[data-evidence-return-scroll-container] button[aria-expanded="true"]')].length,
    detailLinks: [...document.querySelectorAll('a')].filter((a) => a.textContent.includes('完整企业页')).length,
    calls: window.__rl10ScrollCalls,
    state: sessionStorage.getItem('roster:evidence-preview-return'),
  })`)
  const expected = new URL(backHref)
  const actual = new URL(`${BASE}${after.path}`)
  assert(actual.searchParams.get('page') === expected.searchParams.get('page'),
    `${viewport.label}: enterprise ledger page changed: ${JSON.stringify(after)}`)
  assert(actual.searchParams.get('expand') === expected.searchParams.get('expand'),
    `${viewport.label}: expanded row was lost: ${JSON.stringify(after)}`)
  assert(actual.searchParams.get('pageSize') === '100',
    `${viewport.label}: enterprise page size was lost: ${JSON.stringify(after)}`)
  assert(Math.abs(after.tableTop - stateBeforeDetail.tableTop) <= 2,
    `${viewport.label}: expanded enterprise table scroll changed ${stateBeforeDetail.tableTop}→${after.tableTop}`)
  assert(Math.abs(after.windowTop - stateBeforeDetail.windowTop) <= 2,
    `${viewport.label}: expanded enterprise window scroll changed ${stateBeforeDetail.windowTop}→${after.windowTop}`)
  assert(!after.calls.some((call) => call.top === 0),
    `${viewport.label}: Nuxt applied a later top:0 after enterprise return: ${JSON.stringify(after.calls)}`)
  assert(after.expanded > 0 && after.detailLinks > 0,
    `${viewport.label}: expanded enterprise row did not finish rendering: ${JSON.stringify(after)}`)
  assert(after.state === null, `${viewport.label}: enterprise return state was not consumed`)

  console.log(`✓ ${viewport.label} enterprise detail → ledger: table ${stateBeforeDetail.tableTop}→${after.tableTop}, window ${stateBeforeDetail.windowTop}→${after.windowTop}, expanded row retained`)
}

async function main() {
  let service
  let chrome
  let cdp
  let profile
  let targetId

  try {
    service = await startIsolatedNuxt({
      cwd: process.cwd(),
      portHint: PORT_HINT,
      env: {
        NUXT_DB_PATH: join(TEMP_ROOT, 'roster.db'),
        NUXT_FILES_DIR: FILES_ROOT,
        NUXT_INCOMING_DIR: join(TEMP_ROOT, 'incoming'),
        NUXT_API_TOKEN: API_TOKEN,
      },
    })
    BASE = service.baseUrl
    await seedViaApplicationApis()
    const browser = await startChrome()
    chrome = browser.chrome
    cdp = browser.cdp
    profile = browser.profile

    const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
    targetId = target.targetId
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = attached.sessionId
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__rl10ScrollCalls = [];
        const nativeScrollTo = window.scrollTo.bind(window);
        window.scrollTo = (...args) => {
          const p = typeof args[0] === 'object' ? args[0] : { left: args[0], top: args[1] };
          window.__rl10ScrollCalls.push({ ...p, stack: new Error().stack });
          return nativeScrollTo(...args);
        };
      })();`,
    }, sessionId)

    for (const viewport of VIEWPORTS) {
      await runTitlePreviewReturn(cdp, sessionId, viewport)
      await runExpandedEnterpriseReturn(cdp, sessionId, viewport)
    }
    await cdp.send('Target.closeTarget', { targetId })
  } finally {
    await stopOwnedChild(chrome)
    await service?.stop()
    rmSync(TEMP_ROOT, { recursive: true, force: true })
    if (profile) rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
