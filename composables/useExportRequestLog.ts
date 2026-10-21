import { onMounted, shallowRef } from 'vue'

/** `${titleCode}:initial`, or `${titleCode}:${regenerateOf}` for a regeneration. */
const KEY_PATTERN = /^(little_giant|specialized_sme|innovative_sme):(initial|[0-9A-HJKMNP-TV-Z]{26})$/
const UUID_PATTERN = /^[a-f0-9-]{36}$/
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export type ExportRequest = { clientRequestId: string; jobId?: string }

/**
 * 本次会话里“我发起的导出请求”。
 *
 * 只保存**请求身份**：`clientRequestId`（保证重提不重建任务）与已受理的 `jobId`
 * （找回同一任务）。不存 token、不存任务状态、不存产物 —— 任务状态永远以服务端
 * 列表/详情为准，所以这条记录不会过期失真。
 *
 * 生命周期 = 一个标签页会话（sessionStorage）：切 Tab、页面内跳转、刷新都还在；
 * 关掉标签页即消失。
 */
export function useExportRequestLog() {
  const storageKey = 'task-center-export-requests-v1'
  const entries = shallowRef<Record<string, ExportRequest>>({})

  function read() {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}') as Record<string, ExportRequest>
    const restored: Record<string, ExportRequest> = {}
    for (const [key, value] of Object.entries(saved)) {
      if (!KEY_PATTERN.test(key)) continue
      if (typeof value?.clientRequestId !== 'string' || !UUID_PATTERN.test(value.clientRequestId)) continue
      restored[key] = {
        clientRequestId: value.clientRequestId,
        ...(typeof value.jobId === 'string' && ULID_PATTERN.test(value.jobId) ? { jobId: value.jobId } : {}),
      }
    }
    return restored
  }

  function get(key: string) {
    // Read at submission time as another mounted page may have written since mount.
    entries.value = read()
    return entries.value[key]
  }

  function persist(next: Record<string, ExportRequest>) {
    // Commit memory only after storage succeeds. In particular, a failed forget
    // must leave the original UUID available for retry.
    sessionStorage.setItem(storageKey, JSON.stringify(next))
    entries.value = next
  }

  function remember(key: string, request: ExportRequest) {
    const latest = read()
    const current = latest[key]
    // An old receipt cannot replace a newer identity (or erase its job receipt).
    if (!current || current.clientRequestId === request.clientRequestId) {
      latest[key] = { ...current, ...request, ...(current?.jobId ? { jobId: current.jobId } : {}) }
    }
    persist(latest)
  }

  function forget(key: string, clientRequestId: string) {
    const latest = read()
    if (latest[key]?.clientRequestId === clientRequestId) delete latest[key]
    persist(latest)
  }

  onMounted(() => {
    try { entries.value = read() }
    catch { /* Submission re-reads storage and fails closed if it is unavailable. */ }
  })

  return { entries, get, remember, forget }
}
