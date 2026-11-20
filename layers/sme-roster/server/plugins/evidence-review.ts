import { closePostgresReviewSnapshots } from '../utils/evidence-review-reads-postgres'
import { closeReviewSnapshots114 } from '../utils/evidence-review-114'

export default defineNitroPlugin(app => {
  app.hooks.hook('close', async () => {
    closeReviewSnapshots114()
    await closePostgresReviewSnapshots()
  })
})
