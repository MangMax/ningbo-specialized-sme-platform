import { requestLogContext } from '../../lib/logging'

const FILE_WRITE_TOOLS = new Set([
  'save_ocr_result', 'delete_ocr_result', 'save_parse_result', 'set_file_category',
  'update_file', 'remove_file', 'restore_file',
])

/** The SDK extra is not an H3 event. Capture only the server request's known IDs. */
export default defineNitroPlugin(app => {
  app.hooks.hook('mcp:config:resolved', ({ config, event }) => {
    const context = requestLogContext(event)
    // Fresh per-request definitions retain other wrappers and never mutate the registry.
    config.tools = config.tools.map(tool => {
      if (!FILE_WRITE_TOOLS.has(tool.name ?? '')) return tool
      const handler = tool.handler as (...args: any[]) => any
      return { ...tool, handler: (input: any, extra: any) => handler(input, { ...extra, logContext: context }) }
    })
  })
})
