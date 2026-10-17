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
- Exposed `navigate(position, { animate?: boolean })` uses the same queue/validation path as the toolbar, thumbnails, native bookmarks and search results. It works before readiness and also allows repeating a target equal to the current prop.
- `ready({ src, totalPages })` means the document layout can accept navigation. It **does not** confirm that a requested page has rendered. The newest pre-ready target wins.
- `position-change({ src, page, point })` reports the actual visible, rendered page and reading anchor. Confirm a source target against this event. Initialization and passive scrolling also emit it; consumers should deduplicate/throttle URL updates. Event consumers must not assign every observed page back to `targetPage`, which would turn passive reading into navigation.
- `error(message: string)` reports load/resource failures and invalid requested pages. Invalid navigation retains the current document/page; fatal errors show a retry action. Retry retains the most recent requested target. No event changes roster/evidence data.
- Removing the component disposes its startup request, worker engine, plugin tree and subscriptions. Document replacement and retries create a fresh owned session. Theme, zoom, sidebar, fullscreen and reading-mode changes retain that session.

#42 should retain the original evidence target separately, use `navigate` for “return to source page” and history restores, and store position events only as browsing state. Unknown evidence pages remain unknown even when the reader displays page 1. #41 contains no route/history/evidence business changes.

## Engine and resources

All direct EmbedPDF dependencies are pinned to **2.15.1**, matching the original lockfile. The full viewer dependency was removed. Public `EmbedPDF`, plugin capabilities, `Scroller`, render/selection/search layers and virtual thumbnail pane provide the engine behavior; application components own the UI. Continuous reading uses the virtual scroller (two-page buffer); single-page reading mounts only its current page.

Official API references (checked against installed 2.15.1 declaration files and source):

- [Headless Vue setup](https://www.embedpdf.com/docs/vue/headless/getting-started)
- [Scroll and layout readiness](https://www.embedpdf.com/docs/vue/headless/plugins/plugin-scroll)
- [Plugin composition](https://www.embedpdf.com/docs/vue/headless/understanding-plugins)

`public/pdfium.wasm` matches the installed `@embedpdf/pdfium@2.15.1` asset (SHA-256 `5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa`). A same-origin absolute URL is required inside the worker. The worker code is bundled locally by Vite and instantiated as a blob worker by the official engine. No UI/font/stamp/annotation plugins or CDN resources are registered; font fallback is disabled.

Before creating a worker, the reader fetches and validates the same-origin WASM. In 2.15.1, a worker WASM initialization failure can otherwise leave open-document tasks pending indefinitely. This startup request is cancelled on unmount; the worker's subsequent resource fetch can use the browser HTTP cache. It is not repeated for theme or layout changes.

## Validation boundaries

`tests/pdf-reader.test.ts` controls engine readiness and actual-visible-position events at the shared component. `tests/pdf-reader-engine.test.ts` controls resource creation/failure/disposal. These tests do not establish real PDF rendering; the isolated browser acceptance artifacts and command logs are under `/tmp/ningbo-pdf-40-42/41/`.

## Recoverable page rendering and native destinations

A page bitmap failure stays local to that physical page, including virtualized buffer pages. Its alert names the failed page and offers a page-only retry; the document session, last confirmed position, navigation, and other rendered pages stay mounted. Only a successful retry load makes that page eligible for visible-position reports again. Document/startup failures still use the document retry path.

Native XYZ and coordinate-bearing Fit destinations preserve their page anchor through the shared navigation boundary. Engine 2.15.1 destinations use PDF bottom-left user space; the application converts the top coordinate to the scroll capability's top-left unscaled page space. Page-only or unresolvable destinations remain page-only.

## Motion and prepared destinations

Explicit actions opt into short motion. Initial/external position restores remain instant; adjacent page-only actions use the public smooth scroll capability, while distant destinations receive a short arrival transition. The current page stays readable with a pending-target status until the latest target raster has decoded. Navigation and virtual page consumers share public `RenderCapability.renderPage` tasks in a document-owned image pool: mounted consumers plus at most two idle rasters, no whole-document prerender or assumed plugin cache. Scale changes retain the last successful image until the next one decodes. Errors retain the current page with a target-specific retry. All image URLs/tasks are disposed on document unmount.

Position confirmation requires an actual loaded page and positive visibility, and waits for public viewport smooth-scroll activity to stop. The frame fallback only rechecks no-distance scroll metrics. A requested short page may be confirmed from its loaded visibility even when several pages fit and the dominant page differs. Passive scroll releases that preference when the offset changes.

Tool and navigation panels retain both transition directions, immediately become inert when closed, and return focus to their toggles. CSS container queries use the reader width (768px threshold), so embedded/narrow readers overlay navigation without squeezing the page. Auto-fit remains driven by the public viewport resize/zoom debounce; stable scrollbar gutter and physical-page keys are preserved. Reduced motion removes panel/page displacement and uses instant navigation.
