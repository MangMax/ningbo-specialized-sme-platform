import { onMounted, ref, type Ref } from 'vue'
import { TASK_EXPORTS, type TaskExportTitle } from '~~/lib/task-center'
import { isJobId } from '~~/lib/job'
import { useExportRequestLog } from './useExportRequestLog'

export const taskBrowserHeaders = { 'x-task-center-browser': '1' }

/** Shared full-title protocol. Query filters deliberately have no input here. */
export function useCurrentRosterExport(readOnlyReason?: Readonly<Ref<string>>) {
  const requestLog = useExportRequestLog()
  const exportRoutes = ref<Partial<Record<TaskExportTitle, boolean>>>({})
  const discovering = ref(false), discoveryFailed = ref(false), submitting = ref(false)
  async function discoverExports() {
    if (discovering.value) return
    discovering.value = true; discoveryFailed.value = false; exportRoutes.value = {}
    try {
      const capabilities = await $fetch<{ exports: { titleCode: string; path: string; ready: boolean }[] }>('/api/roster/exports/current/capabilities')
      exportRoutes.value = Object.fromEntries(TASK_EXPORTS.map(t => [t.titleCode, capabilities.exports.some(entry => entry.titleCode === t.titleCode && entry.path === t.path && entry.ready === true)]))
    } catch { discoveryFailed.value = true }
    finally { discovering.value = false }
  }
  const disabledReason = (code: TaskExportTitle) => {
    if (discovering.value) return '正在发现可用的导出接口。'
    if (discoveryFailed.value) return '导出接口能力未确认，请重新发现后再提交。'
    if (!exportRoutes.value[code]) return '该称号的专用导出接口尚未上线。'
    return readOnlyReason?.value ?? ''
  }
  async function submitExport(code: TaskExportTitle, regenerateOf?: string): Promise<{ jobId: string } | { error: string } | null> {
    if (submitting.value || disabledReason(code)) return null
    const entry = TASK_EXPORTS.find(t => t.titleCode === code)!
    const key = `${code}:${regenerateOf ?? 'initial'}`
    submitting.value = true
    try {
      let intent: { clientRequestId: string; jobId?: string }
      try {
        intent = { ...(requestLog.get(key) ?? { clientRequestId: crypto.randomUUID() }) }
        requestLog.remember(key, intent)
      }
      catch { return { error: '无法保存请求标识，本次未发送导出请求。请恢复浏览器会话存储后重试。' } }
      const response = await $fetch.raw<{ jobId: string }>(entry.path, {
        method: 'POST', headers: taskBrowserHeaders,
        body: { clientRequestId: intent.clientRequestId, ...(regenerateOf ? { regenerateOf } : {}) }, retry: 0,
      })
      if (response.status !== 202 || !isJobId(response._data?.jobId)) throw new Error('Unconfirmed acceptance')
      intent.jobId = response._data.jobId
      try {
        if (regenerateOf) requestLog.forget(key, intent.clientRequestId)
        else requestLog.remember(key, intent)
      } catch {
        // The server has accepted this request. Storage bookkeeping failure must
        // not turn its real receipt into an ambiguous submission or discard its UUID.
      }
      return { jobId: intent.jobId }
    } catch {
      return { error: '提交尚未确认（没有拿到完整的 202 受理回执）。请求标识已保留，重提沿用同一标识，不会重复建任务。' }
    } finally { submitting.value = false }
  }
  onMounted(() => { void discoverExports() })
  return { exportRequests: requestLog.entries, exportRoutes, discovering, discoveryFailed, submitting, discoverExports, disabledReason, submitExport }
}
