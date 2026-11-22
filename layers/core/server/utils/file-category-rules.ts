import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { evaluateFileAdmission, type ResolveUploadPlacement, type UploadMetadata } from '../../lib/core/file-categories'
import type { FileCategoryServer } from './file-store'
import { FileMaintenanceError, splitRegistrationPath, UploadRegistrationError, type FileRow } from './file-store-contract'

export function createFileCategoryRules(categories: readonly FileCategoryServer[]) {
  for (const category of categories) {
    if (category.registration && typeof category.registration.matchesPath !== 'function') {
      throw new Error(`${category.id}: registration requires matchesPath`)
    }
    if (category.registration && typeof category.registration.prepare !== 'function' && typeof category.registration.preparePostgres !== 'function') {
      throw new Error(`${category.id}: registration requires a writer`)
    }
    if (category.landing && !category.registration) {
      throw new Error(`${category.id}: upload placement requires registration`)
    }
  }
  const metadataByKey = new Map(categories.flatMap(category => category.metadata
    ? Object.keys(category.metadata.properties).map(key => [key, category.metadata!] as const)
    : []))
  const defaults = categories.filter(category => category.defaultLanding)
  if (defaults.length > 1) throw new Error('Multiple default file categories')
  const [defaultCategory] = defaults
  if (defaultCategory && !defaultCategory.landing) {
    throw new Error(`${defaultCategory.id}: default file category requires upload placement`)
  }
  function checkAdmission(relPath: string, siblings?: ReadonlySet<string>) {
    return evaluateFileAdmission(categories, relPath, siblings)
  }

  function registrationCategory(relPath: string) {
    const owners = categories.filter(category => category.registration?.matchesPath(relPath))
    if (owners.length > 1) throw new UploadRegistrationError('落位路径匹配多个上传分类')
    return owners[0] ?? defaultCategory
  }

  function resolveUploadPlacement(metadata: UploadMetadata, { postgres = false } = {}): ReturnType<ResolveUploadPlacement> {
    const requested = metadata.fileCategory
    const category = requested ? categories.find(item => item.id === requested) : defaultCategory
    if (!category?.landing) throw { status_code: 400, body: '未登记上传落位规则\n' }
    if (postgres && !category.registration?.preparePostgres) {
      throw { status_code: 503, body: '此文件分类尚未接入 PostgreSQL 文件库\n' }
    }
    const segments = category.landing(metadata)
    function assertOwnership(relPath: string) {
      try {
        splitRegistrationPath(relPath)
        if (registrationCategory(relPath) !== category) {
          throw new UploadRegistrationError('上传分类与实际落位不符')
        }
      } catch (error) {
        if (!(error instanceof UploadRegistrationError)) throw error
        throw { status_code: error.statusCode, body: `${error.message}\n` }
      }
    }
    assertOwnership(segments.join('/'))
    return { segments, assertOwnership }
  }

  function resolveFileRegistration(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new UploadRegistrationError('请求体必须是对象')
    }
    const { fileCategory, ...input } = body as Record<string, unknown>
    const requested = fileCategory === undefined ? undefined : categories.find(category => category.id === fileCategory)
    if (fileCategory !== undefined && !requested?.registration) {
      throw new UploadRegistrationError('未登记上传分类')
    }

    let relPath: string
    try {
      // Tus returns the actual disk path, including any surrounding whitespace.
      relPath = String(input.relPath ?? '')
    } catch (error) {
      throw new UploadRegistrationError((error as Error).message)
    }
    const owner = registrationCategory(relPath)
    if (requested && owner !== requested) {
      throw new UploadRegistrationError('上传分类与实际落位不符')
    }
    if (!owner?.registration) throw new UploadRegistrationError('无法确定登记上传分类')
    return { registration: owner.registration, relPath, input: { ...input, relPath } }
  }

  function divideMetadata(input: object) {
    const groups = new Map<NonNullable<FileCategoryServer['metadata']>, Record<string, unknown>>()
    for (const [key, value] of Object.entries(input)) {
      const owner = metadataByKey.get(key)
      if (!owner) throw new Error(`不可修改的字段:${key}`)
      const group = groups.get(owner) ?? {}
      group[key] = value
      groups.set(owner, group)
    }
    return groups
  }

  function parseMetadataPatch(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求体必须是对象')
    return Object.assign({}, ...Array.from(divideMetadata(input), ([owner, fields]) => owner.parse(fields)))
  }

  async function updatePostgresFileMetadata(db: NodePgDatabase, file: FileRow, patch: object) {
    for (const [owner, fields] of divideMetadata(patch)) {
      if (!owner.writePostgres) throw new FileMaintenanceError(503, '业务分类元数据尚未接入 PostgreSQL 文件库')
      if (!await owner.writePostgres(db, file, fields)) throw new FileMaintenanceError(404, '未找到可更新的文件分类')
    }
  }

  return {
    checkAdmission, resolveUploadPlacement, resolveFileRegistration, divideMetadata, parseMetadataPatch, updatePostgresFileMetadata,
    extensionSnapshot: (row: FileRow) => Object.assign({}, ...categories.map(category => category.snapshot?.(row))),
  }
}
