export interface FileContentIdentity {
  sha256: string
  bytes: number
}

export interface StoredFileContentIdentity extends FileContentIdentity {
  fileId: number
  relPath: string
}

export interface FileContentConflict {
  code: 'file_content_conflict'
  fileId: number
  relPath: string
  registered: FileContentIdentity
  observed: FileContentIdentity
}

export function compareFileContentIdentity(
  registered: StoredFileContentIdentity,
  observed: FileContentIdentity,
): FileContentConflict | null {
  if (registered.sha256 === observed.sha256 && registered.bytes === observed.bytes) return null
  return {
    code: 'file_content_conflict',
    fileId: registered.fileId,
    relPath: registered.relPath,
    registered: { sha256: registered.sha256, bytes: registered.bytes },
    observed: { sha256: observed.sha256, bytes: observed.bytes },
  }
}
