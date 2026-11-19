import { onBeforeUnmount, provide, type InjectionKey } from 'vue'
import { useRenderCapability } from '@embedpdf/plugin-render/vue'
import { PdfErrorCode } from '@embedpdf/models'

interface ImageLease { ready: Promise<string>; release: () => void }
export interface PdfPageImages { acquire: (pageIndex: number, scale: number) => ImageLease }
export const pdfPageImagesKey: InjectionKey<PdfPageImages> = Symbol('PDF page images')

/** Share decoded rasters between navigation preparation and virtual page consumers.
 * Only mounted consumers plus two idle images are retained, never the whole PDF.
 */
export function usePdfPageImages(documentId: string): PdfPageImages {
  const { provides: render } = useRenderCapability()
  const entries = new Map<string, { users: number; url: string | null; ready: Promise<string>; dispose: () => void }>()
  let closed = false
  function prune() {
    const idle = [...entries].filter(([, entry]) => !entry.users)
    for (const [key, entry] of idle.slice(0, Math.max(0, idle.length - 2))) { entry.dispose(); entries.delete(key) }
  }
  function acquire(pageIndex: number, scale: number): ImageLease {
    const dpr = window.devicePixelRatio || 1
    const key = `${pageIndex}:${scale}:${dpr}`
    let entry = entries.get(key)
    if (!entry) {
      const task = render.value?.forDocument(documentId).renderPage({ pageIndex, options: { scaleFactor: scale, dpr } })
      let active = true
      let rejectReady: (reason: unknown) => void = () => {}
      let url: string | null = null
      const ready = new Promise<string>((resolve, reject) => {
        rejectReady = reject
        if (!task || closed) { reject(new Error('PDF renderer unavailable')); return }
        task.wait(async blob => {
          if (!active) return
          url = URL.createObjectURL(blob)
          const image = new Image()
          image.src = url
          try {
            await image.decode()
            if (active) { const current = entries.get(key); if (current) current.url = url; resolve(url!) }
          } catch (error) { reject(error) }
        }, reject)
      })
      entry = { users: 0, url: null, ready, dispose: () => {
        active = false
        task?.abort({ code: PdfErrorCode.Cancelled, message: 'page image released' })
        rejectReady(new Error('page image released'))
        if (url) URL.revokeObjectURL(url)
      } }
      entries.set(key, entry)
      const created = entry
      void ready.catch(() => { if (entries.get(key) === created) { created.dispose(); entries.delete(key) } })
    }
    // Refresh insertion order for the small idle LRU.
    entries.delete(key); entries.set(key, entry)
    entry.users++
    const held = entry
    let released = false
    return { ready: held.ready, release: () => {
      if (released) return
      released = true; held.users--
      if (!held.users && !held.url) { held.dispose(); if (entries.get(key) === held) entries.delete(key) }
      prune()
    } }
  }
  onBeforeUnmount(() => { closed = true; entries.forEach(entry => entry.dispose()); entries.clear() })
  const images = { acquire }
  provide(pdfPageImagesKey, images)
  return images
}
