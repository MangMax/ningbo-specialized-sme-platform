import { RDJB_TITLE_CODES } from '../platform/recognized-evidence'

type EffectScope = { collectionId: number; titleCode: string | null; rdjb: string; sequenceNo: number }
type PageScope = { collectionId: number; status: string | null; sequenceStart: number | null; sequenceEnd: number | null; rdjb: string | null }
export function platformEffectsForTitle<T extends EffectScope>(rows: T[], pages: PageScope[], title: string) {
  return rows.filter(r => {
    let rowTitle = r.titleCode ?? RDJB_TITLE_CODES[r.rdjb] ?? null
    if (r.rdjb.includes(',')) {
      const page = pages.find(p => p.collectionId === r.collectionId && p.status === 'success' && p.sequenceStart !== null && p.sequenceEnd !== null && r.sequenceNo >= p.sequenceStart && r.sequenceNo <= p.sequenceEnd)
      rowTitle = page?.rdjb ? RDJB_TITLE_CODES[page.rdjb] ?? r.titleCode : r.titleCode
    }
    return rowTitle === title || rowTitle === null && r.rdjb.split(',').includes(({ innovative_sme: '1', specialized_sme: '2', little_giant: '3' } as Record<string, string>)[title]!)
  })
}
