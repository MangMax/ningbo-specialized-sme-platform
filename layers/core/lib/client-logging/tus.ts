import type { UploadOptions } from 'tus-js-client'
import { safeLibraryReporter, type ClientLibraryReporter } from './library-reporter'

/** Native tus hooks only. Keep retry decisions, progress and application callbacks intact. */
export function withTusLogging(options: UploadOptions, report: ClientLibraryReporter, errorIsActive: () => boolean = () => true): UploadOptions {
  const emit = safeLibraryReporter(report)
  let started = false, ready = false
  return {
    ...options,
    onBeforeRequest(...args) {
      if (!started) { started = true; emit('tus_upload_started') }
      return options.onBeforeRequest?.apply(this, args)
    },
    onUploadUrlAvailable(...args) {
      if (!ready) { ready = true; emit('tus_upload_ready') }
      return options.onUploadUrlAvailable?.apply(this, args)
    },
    onSuccess(...args) {
      emit('tus_upload_success')
      return options.onSuccess?.apply(this, args)
    },
    onError(...args) {
      try { if (errorIsActive()) emit('tus_upload_failure') } catch { /* Classification is diagnostic. */ }
      if (options.onError) return options.onError.apply(this, args)
      throw args[0] // tus's default terminal error behavior when no handler was supplied.
    },
  }
}
