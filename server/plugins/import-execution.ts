import { importExecutor } from '../utils/import-execution'
export default defineNitroPlugin(app => { app.hooks.hook('close', () => importExecutor.close()) })
