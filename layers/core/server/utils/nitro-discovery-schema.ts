import type { z } from 'zod'
import type { NitroRouteMeta } from 'nitro/types'

// Nitro’s OpenAPI types omit JSON Schema string bounds and type-less anyOf from its types.
// Metadata literals retain those valid 2020-12 constraints for static extraction.
export type NitroDiscoverySchema = NonNullable<NonNullable<NonNullable<NitroRouteMeta['openAPI']>['parameters']>[number] extends infer P
  ? P extends { schema?: infer S } ? S : never : never>

export type DiscoveryJsonSchema = z.core.JSONSchema.JSONSchema
