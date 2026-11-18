import type { z } from 'zod'
import type { NitroRouteMeta } from 'nitropack/types'

// Nitro 2.13 omits JSON Schema string bounds and type-less anyOf from its types.
// Metadata literals retain those valid 2020-12 constraints for static extraction.
export type NitroDiscoverySchema = NonNullable<NonNullable<NonNullable<NitroRouteMeta['openAPI']>['parameters']>[number] extends infer P
  ? P extends { schema?: infer S } ? S : never : never>

export type DiscoveryJsonSchema = z.core.JSONSchema.JSONSchema
