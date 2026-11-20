export const libraryUploadCategory = 'core'
export const libraryUploadDirectory = 'uploads'

export const isLibraryUploadPath = (path: string) => path.startsWith(`${libraryUploadDirectory}/`)
