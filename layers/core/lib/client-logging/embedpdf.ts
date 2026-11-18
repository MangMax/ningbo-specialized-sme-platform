import type { Logger } from '@embedpdf/models'
import { safeLibraryReporter, type ClientLibraryReporter } from './library-reporter'

/** Implements the installed Logger API without inspecting even source/category/args. */
export function createEmbedPdfLogger(report: ClientLibraryReporter): Logger {
  const emit = safeLibraryReporter(report)
  return {
    isEnabled: level => ['debug', 'info', 'warn', 'error'].includes(level),
    debug: () => emit('pdf_log_debug'),
    info: () => emit('pdf_log_info'),
    warn: () => emit('pdf_log_warn'),
    error: () => emit('pdf_log_error'),
    perf: () => {},
  }
}
