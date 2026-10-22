#!/usr/bin/env node
/**
 * Real-Chrome RL-10 return-chain regression with a temporary DB and synthetic API data.
 * Exercises the integrated enterprise list → drawer → detail → original PDF →
 * detail → list, preserving filters, disclosure, expansion and both scroll layers.
 * No official source documents or OCR results are used.
 * Run with --built after pnpm build to verify the production artifact instead of Vite dev.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { minimalPdf } from '../tests/helpers/minimal-pdf.ts'
import { reserveLoopbackPort, startIsolatedNuxt, stopOwnedChild, waitForChromeDevTools, waitForHttp } from './lib/isolated-local-services.mjs'

const PORT_HINT = Number(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? process.env.RL10_TEST_PORT ?? 0)
let BASE
const EVIDENCE_DIR = process.env.RL10_EVIDENCE_DIR
if (EVIDENCE_DIR) mkdirSync(EVIDENCE_DIR, { recursive: true })
const KEEP_FIXTURES = process.env.RL10_KEEP_FIXTURES === '1' || process.env.RL10_FIXTURE_ONLY === '1'
const observations = []
let beforeReadHashes
function fixtureHashes() {
  const hashes = {}
  function walk(dir) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else hashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(FILES_ROOT)
  for (const suffix of ['', '-wal']) {
    const path = join(TEMP_ROOT, 'roster.db') + suffix
    if (existsSync(path)) hashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return hashes
}
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'rl10-return-chain-'))
const FILES_ROOT = join(TEMP_ROOT, 'files')
const API_TOKEN = randomBytes(32).toString('hex')
const SOURCE_FILE = 'jxj/announcement/2024/1/rl10-synthetic-return.pdf'
const VIEWPORTS = [
  { label: 'desktop 1280×800', width: 1280, height: 800, detailScrollY: 2000, listScrollY: 96, listScrollLeft: 80 },
  { label: 'narrow 390×844', width: 390, height: 844, detailScrollY: 2000, listScrollY: 296, listScrollLeft: 0 },
]

async function startApp(env) {
  if (!process.argv.includes('--built')) return startIsolatedNuxt({ cwd: process.cwd(), portHint: PORT_HINT, env })
  const port = await reserveLoopbackPort(PORT_HINT)
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: { ...process.env, ...env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  try {
    await waitForHttp(`${baseUrl}/`, { child })
    return { baseUrl, stop: () => stopOwnedChild(child) }
  } catch (error) {
    await stopOwnedChild(child)
    throw error
  }
}

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
  writeFileSync(sourceAbs, minimalPdf({ pages: 3 }))
  writeFileSync(join(FILES_ROOT, 'second.pdf'), minimalPdf({ pages: 2 }))

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
          page: 3,
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
  const state = await evaluate(cdp, sessionId, `({title:document.title,url:location.href,text:document.body.innerText.slice(0,800)})`).catch(() => null)
  throw new Error(`Timed out waiting for browser condition: ${expression}; state: ${JSON.stringify(state)}`)
}

/** Wait for the real route/data/scroll terminal condition to remain true across several samples. */
async function waitForStableCondition(cdp, sessionId, expression, timeoutMs = 60_000, stableSamples = 10) {
  const deadline = Date.now() + timeoutMs
  let consecutive = 0
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, sessionId, expression)) {
        consecutive += 1
        if (consecutive >= stableSamples) return
      } else {
        consecutive = 0
      }
    } catch {
      consecutive = 0
      // A navigation can replace the execution context between polls.
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for stable browser condition (${consecutive}/${stableSamples}): ${expression}`)
}

/** Return a measured terminal state only after route, content, storage and offsets stop changing. */
async function waitForStableValue(cdp, sessionId, expression, timeoutMs = 60_000, stableSamples = 20) {
  const deadline = Date.now() + timeoutMs
  let previous = ''
  let consecutive = 0
  let lastValue
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(cdp, sessionId, expression)
      if (lastValue?.ready) {
        const current = JSON.stringify(lastValue)
        if (current === previous) consecutive += 1
        else consecutive = 1
        previous = current
        if (consecutive >= stableSamples) return lastValue
      } else {
        previous = ''
        consecutive = 0
      }
    } catch {
      previous = ''
      consecutive = 0
      // A navigation can replace the execution context between polls.
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for stable measured state (${consecutive}/${stableSamples}): ${JSON.stringify(lastValue)}`)
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
    `document.title.includes(${titleMatch}) && !!document.querySelector('[data-testid="enterprise-table-scroll"]')`,
  )
  await evaluate(cdp, sessionId, `(() => {
    if (document.getElementById('rl10-window-scroll-fixture')) return;
    const filler = document.createElement('section');
    filler.id = 'rl10-window-scroll-fixture';
    filler.textContent = 'Synthetic browser scroll fixture';
    filler.style.cssText = 'position:absolute;top:2500px;left:0;width:1px;height:1200px;z-index:-1;pointer-events:none;';
    document.body.appendChild(filler);
  })()`)
  await evaluate(cdp, sessionId, 'sessionStorage.clear()')
  await waitForRealScrollableLedger(cdp, sessionId)
}

async function waitForRealScrollableLedger(cdp, sessionId) {
  await waitUntil(cdp, sessionId, `(() => {
    const scroller = document.querySelector('[data-testid="enterprise-table-scroll"]');
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
    return [...scroller.querySelectorAll('tbody tr')].some((row) =>
      !row.hasAttribute('aria-hidden') &&
      !row.querySelector('[data-slot="skeleton"]') &&
      row.textContent.trim().length > 0
    );
  })()`)
}

async function setScrollOffsets(cdp, sessionId, { tableTop, tableLeft = 0, windowTop }) {
  return evaluate(cdp, sessionId, `(() => {
    const scroller = document.querySelector('[data-testid="enterprise-table-scroll"]');
    if (!scroller) throw new Error('roster scroll container missing');
    const tableMax = scroller.scrollHeight - scroller.clientHeight;
    const tableLeftMax = scroller.scrollWidth - scroller.clientWidth;
    if (tableMax <= 0) throw new Error('roster table has no vertical scroll range; data rows may not be ready');
    if (${tableLeft} > 0 && tableLeftMax <= 0) throw new Error('roster table has no horizontal scroll range');
    scroller.scrollTop = Math.min(${tableTop}, tableMax);
    scroller.scrollLeft = Math.min(${tableLeft}, tableLeftMax);
    window.scrollTo({ top: ${windowTop}, behavior: 'instant' });
    return {
      tableTop: scroller.scrollTop,
      tableMax,
      tableLeft: scroller.scrollLeft,
      tableLeftMax,
      windowTop: window.scrollY,
      windowMax: document.documentElement.scrollHeight - window.innerHeight,
    };
  })()`)
}

async function saveEvidence(cdp, sessionId, name, state) {
  observations.push({ name, ...state })
  if (!EVIDENCE_DIR) return
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync(join(EVIDENCE_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'))
  writeFileSync(join(EVIDENCE_DIR, 'observations.json'), JSON.stringify(observations, null, 2))
}

// Inspect original rendered pixels through the app's semantic page boundary. The known
// PDF has N black squares on page N; a toolbar number or mislabeled page cannot pass.
function originalPixels(page) {
  return `(() => {
    const output = document.querySelector('output[aria-label="当前实际页"]');
    if (!output?.textContent.trim().startsWith('${page} /')) return null;
    const element = document.querySelector('[aria-label="PDF 第 ${page} 页"]');
    const image = element?.querySelector('img');
    if (!image?.complete || !image.naturalWidth) return null;
    const r = element.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, Math.round(canvas.height * 30 / 200), canvas.width, 1).data;
    let runs = 0, dark = false;
    for (let x = 0; x < canvas.width; x++) {
      const next = pixels[x * 4] < 100 && pixels[x * 4 + 3] > 100;
      if (next && !dark) runs++; dark = next;
    }
    return { runs, width: innerWidth, height: innerHeight, path: location.pathname + location.search, pageRect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  })()`
}
async function expectOriginal(cdp, sessionId, page) {
  const state = await waitForStableValue(cdp, sessionId, `(() => { const state = ${originalPixels(page)}; return { ready: state?.runs === ${page}, ...state }; })()`, 60_000, 3)
  console.log(`  actual page ${page}: ${state.runs} square pixels (${state.width}px)` )
  return state
}
async function clickLabel(cdp, sessionId, label) {
  await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (!button || button.disabled) throw new Error('Unavailable button: ' + ${JSON.stringify(label)});
    button.click();
  })()`)
}
async function jump(cdp, sessionId, page) {
  await evaluate(cdp, sessionId, `(() => {
    const input = document.querySelector('input[aria-label="跳转页码"]');
    if (!input || input.disabled) throw new Error('Page input not ready');
    input.value = '${page}'; input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await evaluate(cdp, sessionId, `document.querySelector('input[aria-label="跳转页码"]').closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`)
  return expectOriginal(cdp, sessionId, page)
}
async function exerciseReading(cdp, sessionId, viewport) {
  const prefix = viewport.width === 390 ? '390' : 'desktop'
  const start = await expectOriginal(cdp, sessionId, 3)
  assert(!existsSync(join(FILES_ROOT, 'jxj/announcement/2024/1/.rl10-synthetic-return.pdf.pages')), 'original reading generated page images')
  await saveEvidence(cdp, sessionId, `${prefix}-source-page3`, start)
  const second = await jump(cdp, sessionId, 2)
  await saveEvidence(cdp, sessionId, `${prefix}-browse-page2`, second)
  await clickLabel(cdp, sessionId, '阅读位置后退')
  await expectOriginal(cdp, sessionId, 3)
  await clickLabel(cdp, sessionId, '阅读位置前进')
  await expectOriginal(cdp, sessionId, 2)
  await evaluate(cdp, sessionId, "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '回到来源第 3 页').click()")
  await expectOriginal(cdp, sessionId, 3)
  // A direct share includes sourcePage and actual page, and reopens without generated images.
  await jump(cdp, sessionId, 2)
  await waitUntil(cdp, sessionId, "new URLSearchParams(location.search).get('page') === '2' && new URLSearchParams(location.search).get('sourcePage') === '3'")
  const documentId = await evaluate(cdp, sessionId, 'window.__rl10DocumentId')
  await cdp.send('Page.reload', {}, sessionId)
  await waitUntil(cdp, sessionId, `window.__rl10DocumentId && window.__rl10DocumentId !== ${JSON.stringify(documentId)}`)
  await expectOriginal(cdp, sessionId, 2)
  await jump(cdp, sessionId, 1)
  await waitUntil(cdp, sessionId, "new URLSearchParams(location.search).get('page') === '1'")
  await evaluate(cdp, sessionId, 'history.back()')
  await expectOriginal(cdp, sessionId, 2)
  await evaluate(cdp, sessionId, 'history.forward()')
  await expectOriginal(cdp, sessionId, 1)
  await evaluate(cdp, sessionId, "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '回到来源第 3 页').click()")
  await expectOriginal(cdp, sessionId, 3)
  await saveEvidence(cdp, sessionId, `${prefix}-returned-source-page3`, await evaluate(cdp, sessionId, originalPixels(3)))
}

async function runCurrentLedgerReturn(cdp, sessionId, viewport) {
  await setViewport(cdp, sessionId, viewport)
  await openInitialLedger(cdp, sessionId, '/?district=海曙区&q=RL10&page=2&pageSize=100&sort=name', '企业列表')
  await setScrollOffsets(cdp, sessionId, { tableTop: 1538, tableLeft: viewport.listScrollLeft, windowTop: viewport.listScrollY })
  const selected = await evaluate(cdp, sessionId, `(() => {
    const scroller = document.querySelector('[data-testid="enterprise-table-scroll"]');
    const box = scroller.getBoundingClientRect();
    const button = [...scroller.querySelectorAll('button')].find(b => {
      const r = b.getBoundingClientRect(); return b.textContent.includes('RL10') && r.bottom > box.top && r.top < box.bottom;
    });
    if (!button) throw new Error('No visible enterprise button');
    button.click(); return button.textContent.trim();
  })()`)
  await waitUntil(cdp, sessionId, `!!document.querySelector('[data-testid="enterprise-drawer"]') && [...document.querySelectorAll('a')].some(a => a.textContent.includes('完整企业页'))`)
  // Drawer rendering precedes the asynchronous router.replace. Wait for the
  // public URL to identify that same enterprise before capturing the return URL.
  await waitUntil(cdp, sessionId, `(() => {
    const link = [...document.querySelectorAll('a')].find(a => a.textContent.includes('完整企业页'));
    if (!link) return false;
    const id = new URL(link.href).pathname.split('/').pop();
    return !!id && new URLSearchParams(location.search).get('expand') === id;
  })()`)
  const listBefore = await setScrollOffsets(cdp, sessionId, { tableTop: 1538, tableLeft: viewport.listScrollLeft, windowTop: viewport.listScrollY })
  const listPath = await evaluate(cdp, sessionId, 'location.pathname + location.search')
  const expanded = new URL(listPath, BASE).searchParams.get('expand')
  assert(expanded, 'drawer expansion did not reach URL')
  await evaluate(cdp, sessionId, "[...document.querySelectorAll('a')].find(a => a.textContent.includes('完整企业页')).click()")
  await waitUntil(cdp, sessionId, `location.pathname.startsWith('/enterprises/') && !!document.querySelector('[id^="record-event-"] button[aria-expanded]')`)
  const detailPath = await evaluate(cdp, sessionId, 'location.pathname + location.search')
  await evaluate(cdp, sessionId, `document.querySelector('[id^="record-event-"] button[aria-expanded]').click()`)
  await waitUntil(cdp, sessionId, `[...document.querySelectorAll('a[href^="/preview"]')].some(a => a.textContent.includes('第 3 页'))`)
  const detailBefore = await evaluate(cdp, sessionId, `(() => {
    window.scrollTo({ top: ${viewport.detailScrollY}, behavior: 'instant' });
    const scrollY = window.scrollY;
    const link = [...document.querySelectorAll('a[href^="/preview"]')].find(a => a.textContent.includes('第 3 页'));
    link.click(); return { scrollY };
  })()`)
  await waitUntil(cdp, sessionId, "location.pathname === '/preview'")
  await exerciseReading(cdp, sessionId, viewport)
  await evaluate(cdp, sessionId, 'window.__rl10ScrollCalls.length = 0')
  await evaluate(cdp, sessionId, "[...document.querySelectorAll('a')].find(a => a.textContent.trim() === '返回企业详情').click()")
  await waitForStableCondition(cdp, sessionId, `location.pathname + location.search === ${JSON.stringify(detailPath)} && Math.abs(window.scrollY - ${detailBefore.scrollY}) <= 2 && !!document.querySelector('[id^="record-event-"] button[aria-expanded="true"]') && !window.__rl10ScrollCalls.some(p => p.top === 0)`)
  const detailAfter = await evaluate(cdp, sessionId, `({path:location.pathname+location.search,scrollY:window.scrollY,disclosure:!!document.querySelector('[id^="record-event-"] button[aria-expanded="true"]'),calls:window.__rl10ScrollCalls})`)
  await saveEvidence(cdp, sessionId, `${viewport.width}-detail-return`, { before: detailBefore, after: detailAfter })
  await evaluate(cdp, sessionId, 'window.__rl10ScrollCalls.length = 0')
  await evaluate(cdp, sessionId, "[...document.querySelectorAll('a')].find(a => a.textContent.includes('企业列表') && a.getAttribute('href')?.startsWith('/?')).click()")
  await waitForRealScrollableLedger(cdp, sessionId)
  await waitForStableCondition(cdp, sessionId, `(() => {
    const scroller = document.querySelector('[data-testid="enterprise-table-scroll"]');
    const query = new URLSearchParams(location.search);
    return location.pathname === '/' && query.get('expand') === '${expanded}' && query.get('q') === 'RL10' && query.get('district') === '海曙区' && query.get('page') === '2' && query.get('pageSize') === '100' && query.get('sort') === 'name' &&
      Math.abs(scroller.scrollTop - ${listBefore.tableTop}) <= 2 && Math.abs(scroller.scrollLeft - ${listBefore.tableLeft}) <= 2 && Math.abs(window.scrollY - ${listBefore.windowTop}) <= 2 &&
      !!document.querySelector('[data-testid="enterprise-drawer"]') && sessionStorage.getItem('roster:evidence-preview-return') === null && !window.__rl10ScrollCalls.some(p => p.top === 0);
  })()`)
  const listAfter = await evaluate(cdp, sessionId, `({ path: location.pathname + location.search, tableTop: document.querySelector('[data-testid="enterprise-table-scroll"]').scrollTop, tableLeft: document.querySelector('[data-testid="enterprise-table-scroll"]').scrollLeft, windowTop: window.scrollY, expanded: !!document.querySelector('[data-testid="enterprise-drawer"]'), calls: window.__rl10ScrollCalls })`)
  await saveEvidence(cdp, sessionId, `${viewport.width}-ledger-return`, { before: listBefore, after: listAfter, selected, listPath })
  console.log(`✓ ${viewport.label} source pixels, explicit/internal/browser history, reload, source return; detail ${detailBefore.scrollY}→${detailAfter.scrollY}; ledger ${listBefore.tableTop}/${listBefore.tableLeft}→${listAfter.tableTop}/${listAfter.tableLeft}, window ${listBefore.windowTop}→${listAfter.windowTop}, expanded=${expanded}`)
}

async function runComparisonRouteReturn(cdp, sessionId, viewport) {
  await setViewport(cdp, sessionId, viewport)
  await navigate(cdp, sessionId, `${BASE}/comparison?mode=legacy&q=RL10&district=海曙区&page=2&pageSize=25`)
  await waitUntil(cdp, sessionId, `document.querySelectorAll('[data-testid="comparison-enterprise-name"]').length === 25`)
  await evaluate(cdp, sessionId, `(() => {
    const input = document.querySelector('input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'RL10 浏览器');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitUntil(cdp, sessionId, `new URLSearchParams(location.search).get('q') === 'RL10 浏览器' && new URLSearchParams(location.search).get('page') === '1' && !document.querySelector('[data-testid="comparison-pagination"] button[aria-label="下一页"]').disabled`)
  await clickLabel(cdp, sessionId, '下一页')
  await waitUntil(cdp, sessionId, `new URLSearchParams(location.search).get('page') === '2' && document.querySelector('[data-testid="comparison-enterprise-name"]')?.textContent.includes('026')`)
  const comparisonPath = await evaluate(cdp, sessionId, 'location.pathname + location.search')
  await evaluate(cdp, sessionId, `document.querySelector('[data-testid="comparison-enterprise-name"]').click()`)
  await waitUntil(cdp, sessionId, `location.pathname.startsWith('/enterprises/') && !!document.querySelector('[id^="record-event-"] button[aria-expanded]')`)
  assert(await evaluate(cdp, sessionId, `new URLSearchParams(location.search).get('returnTo') === ${JSON.stringify(comparisonPath)}`), 'comparison detail lost return query')
  const detailPath = await evaluate(cdp, sessionId, 'location.pathname + location.search')
  // Browser back/forward must re-enter the same result and enterprise, not just
  // render a static deep-link href with the right spelling.
  await evaluate(cdp, sessionId, 'history.back()')
  await waitUntil(cdp, sessionId, `location.pathname + location.search === ${JSON.stringify(comparisonPath)} && document.querySelector('[data-testid="comparison-enterprise-name"]')?.textContent.includes('026')`)
  await evaluate(cdp, sessionId, 'history.forward()')
  await waitUntil(cdp, sessionId, `location.pathname + location.search === ${JSON.stringify(detailPath)} && !!document.querySelector('[id^="record-event-"] button[aria-expanded]')`)
  await evaluate(cdp, sessionId, `document.querySelector('[id^="record-event-"] button[aria-expanded]').click()`)
  await waitUntil(cdp, sessionId, `[...document.querySelectorAll('a[href^="/preview"]')].some(a => a.textContent.includes('第 3 页'))`)
  const detailScroll = await evaluate(cdp, sessionId, `(() => {
    window.scrollTo({ top: ${viewport.detailScrollY}, behavior: 'instant' });
    const scrollY = window.scrollY;
    [...document.querySelectorAll('a[href^="/preview"]')].find(a => a.textContent.includes('第 3 页')).click();
    return scrollY;
  })()`)
  await expectOriginal(cdp, sessionId, 3)
  await evaluate(cdp, sessionId, `[...document.querySelectorAll('a')].find(a => a.textContent.trim() === '返回企业详情').click()`)
  await waitForStableCondition(cdp, sessionId, `location.pathname + location.search === ${JSON.stringify(detailPath)} && Math.abs(window.scrollY - ${detailScroll}) <= 2 && !!document.querySelector('[id^="record-event-"] button[aria-expanded="true"]')`)
  await evaluate(cdp, sessionId, `[...document.querySelectorAll('a')].find(a => a.getAttribute('href') === ${JSON.stringify(comparisonPath)}).click()`)
  await waitUntil(cdp, sessionId, `location.pathname + location.search === ${JSON.stringify(comparisonPath)} && document.querySelector('[data-testid="comparison-enterprise-name"]')?.textContent.includes('026')`)
  await saveEvidence(cdp, sessionId, `${viewport.width}-comparison-return`, { comparisonPath, detailPath, detailScroll })
  console.log(`✓ ${viewport.label} comparison filter, page, detail deep link, browser back/forward and source return`)
}

async function main() {
  let service
  let chrome
  let cdp
  let profile
  let targetId

  try {
    service = await startApp({
      NUXT_DB_PATH: join(TEMP_ROOT, 'roster.db'),
      NUXT_FILES_DIR: FILES_ROOT,
      NUXT_INCOMING_DIR: join(TEMP_ROOT, 'incoming'),
      NUXT_API_TOKEN: API_TOKEN,
    })
    BASE = service.baseUrl
    await seedViaApplicationApis()
    // Checkpoint through SQLite only after the seed phase, then read acceptance must be immutable.
    const { default: Database } = await import('better-sqlite3')
    const checkpoint = new Database(join(TEMP_ROOT, 'roster.db'))
    checkpoint.pragma('wal_checkpoint(TRUNCATE)'); checkpoint.close()
    beforeReadHashes = fixtureHashes()
    if (EVIDENCE_DIR) writeFileSync(join(EVIDENCE_DIR, 'read-before.json'), JSON.stringify(beforeReadHashes, null, 2))
    console.log(`Isolated fixture: ${TEMP_ROOT}; app: ${BASE}`)
    if (EVIDENCE_DIR) writeFileSync(join(EVIDENCE_DIR, 'fixture.json'), JSON.stringify({ root: TEMP_ROOT, base: BASE, source: SOURCE_FILE }, null, 2))
    if (process.env.RL10_FIXTURE_ONLY === '1') return
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
        window.__rl10DocumentId = crypto.randomUUID();
        // Recreate the isolated window-scroll range after a PDF reload as well.
        addEventListener('DOMContentLoaded', () => {
          if (document.getElementById('rl10-window-scroll-fixture')) return;
          const filler = document.createElement('section'); filler.id = 'rl10-window-scroll-fixture';
          filler.textContent = 'Synthetic browser scroll fixture';
          filler.style.cssText = 'position:absolute;top:2500px;left:0;width:1px;height:1200px;z-index:-1;pointer-events:none;';
          document.body.appendChild(filler);
        });
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
      await runCurrentLedgerReturn(cdp, sessionId, viewport)
      await runComparisonRouteReturn(cdp, sessionId, viewport)
    }
    await cdp.send('Target.closeTarget', { targetId })
    const afterReadHashes = fixtureHashes()
    if (EVIDENCE_DIR) writeFileSync(join(EVIDENCE_DIR, 'read-after.json'), JSON.stringify(afterReadHashes, null, 2))
    assert(JSON.stringify(afterReadHashes) === JSON.stringify(beforeReadHashes), 'read acceptance modified the synthetic database or source files')
    console.log('✓ synthetic database and source-file SHA-256 unchanged; no page-image files generated by original reading')
  } finally {
    await stopOwnedChild(chrome)
    await service?.stop()
    if (!KEEP_FIXTURES) rmSync(TEMP_ROOT, { recursive: true, force: true })
    if (profile) rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
