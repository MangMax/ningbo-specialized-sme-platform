export type FileAdmissionPolicy = (path: string, siblings?: ReadonlySet<string>) =>
  { inScope: boolean; reason: string; detail: string }

export interface FileFilter {
  readonly key: string
  readonly label: string
  readonly placeholder: string
  readonly width: string
  readonly description?: string
  readonly options: readonly { value: string; label: string }[]
}

export interface FileDetailDraft {
  valid: boolean
  patch: Record<string, unknown>
}

export interface FileCategory {
  readonly admission: FileAdmissionPolicy
  readonly filters?: readonly FileFilter[]
  readonly columns?: readonly { label: string; width: number; tooltip?: string; align?: 'right' }[]
}

export function evaluateFileAdmission(
  categories: readonly { admission?: FileAdmissionPolicy }[],
  path: string,
  siblings?: ReadonlySet<string>,
) {
  for (const category of categories) {
    const result = category.admission?.(path, siblings)
    if (result && !result.inScope) return result
  }
  return undefined
}
/** 客户端在 `Upload-Metadata` 里声明的键(全部为可选,由规则决定必需项)。 */
export type UploadMetadata = Record<string, string | null | undefined>
export type FileLanding = (metadata: UploadMetadata) => string[]
