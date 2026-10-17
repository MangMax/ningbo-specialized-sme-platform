# Shared PDF reader (#41)

`components/preview/PdfPreview.vue` is the public read-only boundary. File previews already use it through `FilePreview`; source routing, evidence pages, URL/history and back context belong to #42.

```vue
<PdfPreview
  ref="reader"
  :src="fileUrl"
  :name="fileName"
  :target-page="physicalPage"
  @ready="onLayoutReady"
  @position-change="onVisiblePosition"
  @error="onReaderError"
/>
```

- `src` identifies the document. Changing it destroys the previous engine and clears visible reading state. `name` is display-only.
- `targetPage?: number` is a one-based physical PDF page. For restoring an anchor, pass `targetPosition?: PdfReadingPosition` instead; it takes precedence over `targetPage`.
- `PdfReadingPosition = { page: number; point?: { x: number; y: number } }`. Coordinates are unscaled PDF page coordinates from the scroll capability, not screen pixels.
- Exposed `navigate(position)` uses the same queue/validation path as the toolbar, thumbnails, native bookmarks and search results. It works before readiness and also allows repeating a target equal to the current prop.
- `ready({ src, totalPages })` means the document layout can accept navigation. It **does not** confirm that a requested page has rendered. The newest pre-ready target wins.
- `position-change({ src, page, point })` reports the actual visible, rendered page and reading anchor. Confirm a source target against this event. Initialization and passive scrolling also emit it; consumers should deduplicate/throttle URL updates. Event consumers must not assign every observed page back to `targetPage`, which would turn passive reading into navigation.
- `error(message: string)` reports load/resource failures and invalid requested pages. Invalid navigation retains the current document/page; fatal errors show a retry action. Retry retains the most recent requested target. No event changes roster/evidence data.
- Removing the component disposes its startup request, worker engine, plugin tree and subscriptions. Document replacement and retries create a fresh owned session. Theme, zoom, sidebar, fullscreen and reading-mode changes retain that session.

#42 should retain the original evidence target separately, use `navigate` for “return to source page” and history restores, and store position events only as browsing state. Unknown evidence pages remain unknown even when the reader displays page 1. #41 contains no route/history/evidence business changes.

## Engine and resources

All direct EmbedPDF dependencies are pinned to **2.15.1**, matching the original lockfile. The full viewer dependency was removed. Public `EmbedPDF`, plugin capabilities, `Scroller`, render/selection/search layers and virtual thumbnail pane provide the engine behavior; application components own the UI. Continuous reading uses the virtual scroller (one-page buffer); single-page reading mounts only its current page.

Official API references (checked against installed 2.15.1 declaration files and source):

- [Headless Vue setup](https://www.embedpdf.com/docs/vue/headless/getting-started)
- [Scroll and layout readiness](https://www.embedpdf.com/docs/vue/headless/plugins/plugin-scroll)
- [Plugin composition](https://www.embedpdf.com/docs/vue/headless/understanding-plugins)

`public/pdfium.wasm` matches the installed `@embedpdf/pdfium@2.15.1` asset (SHA-256 `5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa`). A same-origin absolute URL is required inside the worker. The worker code is bundled locally by Vite and instantiated as a blob worker by the official engine. No UI/font/stamp/annotation plugins or CDN resources are registered; font fallback is disabled.

Before creating a worker, the reader fetches and validates the same-origin WASM. In 2.15.1, a worker WASM initialization failure can otherwise leave open-document tasks pending indefinitely. This startup request is cancelled on unmount; the worker's subsequent resource fetch can use the browser HTTP cache. It is not repeated for theme or layout changes.

## Validation boundaries

`tests/pdf-reader.test.ts` controls engine readiness and actual-visible-position events at the shared component. `tests/pdf-reader-engine.test.ts` controls resource creation/failure/disposal. These tests do not establish real PDF rendering; the isolated browser acceptance artifacts and command logs are under `/tmp/ningbo-pdf-40-42/41/`.

## Source navigation and history (#42)

The shared reader now owns up to 100 in-memory reading locations per document, including page-coordinate anchors. Toolbar, keyboard, thumbnails, native outline and search all enter the same explicit navigation path. `navigation-request({src,page,point?,reason:'explicit'|'history'})` announces validated user intent; it does **not** confirm visibility. The visit is committed only on a rendered position event for that destination. Passive scrolling, initialization and `navigate(position)` / target-prop restores never append visits. `navigate(position, 'explicit')` is available for the source-return action. Document changes clear both history directions; no reading history is persisted.

When several short pages fit in the viewport at once, the engine's dominant page may stay at 1. A requested page is reported only after its render is loaded and its public visibility metric is positive. That visible selection remains stable until the scroll offset changes, then normal dominant-page reporting resumes. No page number alone establishes visibility.

`pages/preview.vue` composes `SourcePdfPreview` with `useSourcePdfRoute`:

- Legacy `file/page/back` links still open the same physical PDF target. The initial `page` is also the source target when `sourcePage` is absent.
- Canonical reading URLs use `page` for the actual browsing page and `sourcePage=N` for the original source target. `sourcePage=unknown` preserves missing evidence pages even when reading page 1. Invalid source values remain invalid, rather than becoming unknown or page 1. Optional `x/y` encode finite nonnegative PDF coordinates, rounded to 0.01 units.
- Only external URL changes drive reader target props. Owned URL writes are ignored as echoes. Confirmed explicit visits push browser history; passive page changes replace, and repeated anchor changes debounce for 300ms. Pending writes are invalidated when leaving or externally restoring the route.
- Browser Back/Forward restores document/page/anchor without appending reader history. “阅读位置后退/前进”, “回到来源第 N 页” and the enterprise-context “返回” remain distinct actions.
- Original PDF is the default, independent of `/api/pdf-pages`; its page count comes from reader readiness. A page-image view mounts its existing gallery only when selected. Opening directly into the gallery does not start the original engine. After first use the original reader stays mounted while switching tabs, preserving its history; selecting a gallery page restores that physical page on returning to original, without recording an extra visit.
- The original rendered position, not a requested target or gallery cache count, confirms source location. Failures retain their requested target for retry. Invalid and out-of-range targets remain explicit. Gallery generation/retry remains inside the separate gallery view.
- The existing safe-back parser and `fileUrl`/file API root boundary remain unchanged. No reader event changes evidence, list numbers, source files or OCR.

The integrated RL-20 list replaced the retired title/expanded-row views with an enterprise drawer before #42. The current list now reconnects the existing session return seam: the complete-enterprise-page link saves its filtered `expand` context and table/window scroll; the list restores only after current rows render, and reuses the existing Nuxt delayed-scroll suppression. Legacy component return-chain tests remain in place.

Synthetic browser acceptance: `RL10_EVIDENCE_DIR=/tmp/<run> node scripts/verify-roster-return-chain.mjs <free-port>` creates its own DB/files/incoming and browser profile, exercises actual rendered square-count pixels plus source/internal/browser navigation and the list→drawer→detail→PDF return chain at 1280×800 and 390×844, then checks original source/database hashes. `RL10_KEEP_FIXTURES=1` retains the generated fixture and writes its location to `fixture.json`; `RL10_FIXTURE_ONLY=1` seeds and exits for a separately launched read-only production server. Run this and `verify-detail-return-scroll.mjs` serially: Nuxt owns a per-worktree dev lock. Neither script reads real business databases or source files.
## Recoverable page rendering and native destinations

A page bitmap failure stays local to that physical page, including virtualized buffer pages. Its alert names the failed page and offers a page-only retry; the document session, last confirmed position, navigation, and other rendered pages stay mounted. Only a successful retry load makes that page eligible for visible-position reports again. Document/startup failures still use the document retry path.

Native XYZ and coordinate-bearing Fit destinations preserve their page anchor through the shared navigation boundary. Engine 2.15.1 destinations use PDF bottom-left user space; the application converts the top coordinate to the scroll capability's top-left unscaled page space. Page-only or unresolvable destinations remain page-only.

Gallery `page-change` reports also synchronize the share URL immediately, retaining `sourcePage` and using replace: gallery initialization and external restores are never inferred to be reader visits. View-switch URL writes read the latest query when their queued operation executes so a rapid switch cannot overwrite a newly confirmed gallery page with the previous original page.

On source pages the source-return action and actual-page toolbar carry normal source/current state. Visible status space is reserved for pending, unknown, invalid, out-of-range and failed states; a normal successful status remains announced. The visible “位置历史” label separates reading-location arrows from physical-page controls. Context-return labels name the validated destination without changing safe-back rules.
