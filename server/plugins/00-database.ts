import { useApplicationDb } from '../../db/client'

export default defineNitroPlugin(() => {
  useApplicationDb()
})
