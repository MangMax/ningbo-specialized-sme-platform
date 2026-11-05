import { initializeDb } from '../../db/client'

export default defineNitroPlugin(() => {
  initializeDb()
})
