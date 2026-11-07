import { createError } from 'h3'

export function statisticsInteger(value: unknown, fallback: number, max: number, statusMessage: string, min = 1) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw createError({ statusCode: 400, statusMessage })
  }
  return Number(value)
}
