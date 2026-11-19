import { installApplicationUi } from '../../lib/install-application-ui'

export default defineNuxtPlugin({
  name: 'app-modules',
  enforce: 'pre',
  setup: installApplicationUi,
})
