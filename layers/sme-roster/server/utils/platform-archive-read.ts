import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { businessProcessFilterSchema } from '../../lib/platform/business-processes'
import { declarationFilterSchema } from '../../lib/platform/declarations'
import type { PlatformFilterOptionsQuery } from '../../lib/platform/filter-options'
import { recognizedDirectoryFilterSchema } from '../../lib/platform/recognized-directory'
import { listPostgresPlatformArchive, readPostgresPlatformArchiveDetail, readPostgresPlatformArchiveOptions } from './platform-archive-postgres'
import { failPlatformBusinessRequest } from './platform-business-projection'

type Source = PlatformFilterOptionsQuery['source']

const readers = {
  declarations: {
    parse: declarationFilterSchema,
    invalidCode: 'invalid_declaration_filter',
    invalidMessage: 'Invalid declaration query parameters',
  },
  'business-processes': {
    parse: businessProcessFilterSchema,
    invalidCode: 'invalid_business_process_filter',
    invalidMessage: 'Invalid business process query parameters',
  },
  'recognized-directory': {
    parse: recognizedDirectoryFilterSchema,
    invalidCode: 'invalid_recognized_directory_filter',
    invalidMessage: 'Invalid recognized directory query parameters',
  },
}

export async function listPlatformArchive(source: Source, input: unknown) {
  const reader = readers[source]
  const postgres = usePostgresDirectoryDb()
  const filter = reader.parse.safeParse(input)
  if (!filter.success) failPlatformBusinessRequest(400, reader.invalidCode, reader.invalidMessage)
  return listPostgresPlatformArchive(postgres, source, filter.data)
}

export async function readPlatformArchiveDetail(source: Source, recordId: number) {
  const postgres = usePostgresDirectoryDb()
  return readPostgresPlatformArchiveDetail(postgres, source, recordId)
}

export async function readPlatformArchiveOptions(query: PlatformFilterOptionsQuery) {
  const postgres = usePostgresDirectoryDb()
  return readPostgresPlatformArchiveOptions(postgres, query)
}
