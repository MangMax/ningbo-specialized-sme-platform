import { parseCurationPatch, patchCuration } from '~~/lib/curation'

export default defineEventHandler(async (event) => {
  let patch
  try {
    patch = parseCurationPatch(await readBody(event))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: (error as Error).message })
  }
  patchCuration(useRuntimeConfig(event).curatedPath, patch)
  return { curated: patch.curated }
})
