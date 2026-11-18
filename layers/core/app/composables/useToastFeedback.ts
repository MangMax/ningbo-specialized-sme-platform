import { toast } from 'vue-sonner'

/**
 * 写路径的统一操作反馈(票 #866):成功短提示、失败提示带「重试」动作。
 *
 * 文案口径固定为「动词 + 对象 + 结果」:
 *  - 成功:`已{verb}{object}`(如「已保存文件信息」)
 *  - 失败:`{verb}{object}失败` + 说明 + 「重试」按钮,点击重跑同一次操作
 *
 * 用法:
 * ```ts
 * const feedback = useToastFeedback()
 * async function save() {
 *   try { await $fetch(...); editOpen = false; await refresh()
 *     feedback.succeed('保存', '文件信息') }
 *   catch (error) { editFailure = describeFetchError(error)
 *     feedback.fail('保存', '文件信息', editFailure, () => saveMetadata(lastForm)) }
 * }
 * ```
 *
 * 失败重试是**显式动作**而不是自动重发:与 AGENTS.md「失败保留上次成功结果并给显式
 * 重试」一致 —— 弹层里的原输入/草稿保持不动,用户点「重试」才重跑同一回调。
 */
export function useToastFeedback() {
  /** 成功:`已{verb}{object}`,可加一句补充说明(如「新任务将使用当前配置」)。 */
  function succeed(verb: string, object: string, detail = '') {
    toast.success(`已${verb}${object}${detail ? `,${detail}` : '。'}`)
  }

  /**
   * 失败:`{verb}{object}失败`,带「重试」动作。
   * @param detail 失败说明(服务端消息或排查指引);为空时给默认指引。
   * @param retry  点「重试」时重跑的回调 —— 通常是带原参数重调同一个函数。
   */
  function fail(verb: string, object: string, detail = '', retry?: () => void) {
    const description = detail || '请检查网络后重试。'
    toast.error(`${verb}${object}失败`, {
      description,
      ...(retry ? { action: { label: '重试', onClick: retry } } : {}),
    })
  }

  return { succeed, fail }
}
