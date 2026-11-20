import { useDb } from '@db'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { businessProcessFilterSchema } from '../../lib/platform/business-processes'
import { declarationFilterSchema } from '../../lib/platform/declarations'
import type { PlatformFilterOptionsQuery } from '../../lib/platform/filter-options'
import { recognizedDirectoryFilterSchema } from '../../lib/platform/recognized-directory'
import { listPostgresPlatformArchive, readPostgresPlatformArchiveDetail, readPostgresPlatformArchiveOptions } from './platform-archive-postgres'
import { getTargetBusinessProcess, listTargetBusinessProcesses, readTargetBusinessProcessOptions } from './platform-business-processes-target'
import { fail } from './platform-business-read'
import { getTargetDeclaration, listTargetDeclarations, readTargetDeclarationOptions } from './platform-declarations-target'
import { getTargetRecognizedRecord, listTargetRecognizedDirectory, readTargetRecognizedOptions } from './platform-recognized-target'

type Source = PlatformFilterOptionsQuery['source']

// An explicit PostgreSQL connection selects the native reader for the entire
// action. Connection and query failures propagate to the transport.
const readers = {
  declarations: {
    parse: declarationFilterSchema,
    invalidCode: 'invalid_declaration_filter',
    invalidMessage: 'Invalid declaration query parameters',
    list: listTargetDeclarations, detail: getTargetDeclaration, options: readTargetDeclarationOptions,
  },
  'business-processes': {
    parse: businessProcessFilterSchema,
    invalidCode: 'invalid_business_process_filter',
    invalidMessage: 'Invalid business process query parameters',
    list: listTargetBusinessProcesses, detail: getTargetBusinessProcess, options: readTargetBusinessProcessOptions,
  },
  'recognized-directory': {
    parse: recognizedDirectoryFilterSchema,
    invalidCode: 'invalid_recognized_directory_filter',
    invalidMessage: 'Invalid recognized directory query parameters',
    list: listTargetRecognizedDirectory, detail: getTargetRecognizedRecord, options: readTargetRecognizedOptions,
  },
}

export async function listPlatformArchive(source: Source, input: unknown) {
  const reader = readers[source]
  const postgres = usePostgresDirectoryDb()
  if (!postgres) return reader.list(input, useDb())
  const filter = reader.parse.safeParse(input)
  if (!filter.success) fail(400, reader.invalidCode, reader.invalidMessage)
  return listPostgresPlatformArchive(postgres, source, filter.data)
}

export async function readPlatformArchiveDetail(source: Source, recordId: number) {
  const postgres = usePostgresDirectoryDb()
  return postgres ? readPostgresPlatformArchiveDetail(postgres, source, recordId) : readers[source].detail(useDb(), recordId)
}

export async function readPlatformArchiveOptions(query: PlatformFilterOptionsQuery) {
  const postgres = usePostgresDirectoryDb()
  return postgres ? readPostgresPlatformArchiveOptions(postgres, query) : readers[query.source].options(query.view, useDb())
}
