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

  function persist() {
    // Fail closed: an identity that cannot be stored must not be sent, or a
    // lost 202 could create a second export on retry.
    sessionStorage.setItem(storageKey, JSON.stringify(entries.value))
  }

  function remember(key: string, request: ExportRequest) {
    entries.value = { ...entries.value, [key]: request }
    persist()
  }

  function forget(key: string) {
    const { [key]: _removed, ...rest } = entries.value
    entries.value = rest
    persist()
  }

  onMounted(() => {
    try {
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
      entries.value = restored
    } catch { /* An unreadable store simply starts a new session. */ }
  })

  return { entries, remember, forget }
}
