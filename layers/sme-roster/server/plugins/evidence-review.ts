import { closeReviewSnapshots114 } from '../utils/evidence-review-114'

export default defineNitroPlugin(app => {
  app.hooks.hook('close', closeReviewSnapshots114)
})
