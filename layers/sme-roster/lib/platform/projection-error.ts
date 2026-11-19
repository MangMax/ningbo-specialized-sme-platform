export class PlatformProjectionError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
