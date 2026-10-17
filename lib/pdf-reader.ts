/** PDF physical pages are one-based; point is in unscaled PDF page coordinates. */
export interface PdfReadingPosition { page: number; point?: { x: number; y: number } }
export interface PdfPositionEvent extends PdfReadingPosition { src: string }
export interface PdfReadyEvent { src: string; totalPages: number }
export type PdfReadingMode = 'continuous' | 'single'

/** User intent, never inferred from passive position changes. External restores do not emit it. */
export interface PdfNavigationRequest extends PdfPositionEvent { reason: 'explicit' | 'history' }
