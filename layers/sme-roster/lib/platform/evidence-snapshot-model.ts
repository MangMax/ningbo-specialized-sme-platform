import { z } from 'zod'

export const cellSchema = z.object({name:z.string(),storageClass:z.enum(['null','text','blob','integer','real']),hex:z.string().regex(/^(?:[a-fA-F0-9]{2})*$/),real64be:z.string().regex(/^[a-fA-F0-9]{16}$/).optional()})

export const snapshotSchema=z.object({encoding:z.literal('t05a-sqlite-cells-v1'),fields:z.array(cellSchema)})
