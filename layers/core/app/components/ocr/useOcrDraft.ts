import { computed, nextTick, ref, watch, type Ref } from 'vue'
import type { useOcrWorkbench } from '#core/app/composables/useOcrWorkbench'

type DraftSource = Pick<ReturnType<typeof useOcrWorkbench>,
  | 'selectedPath' | 'currentPage' | 'currentRow' | 'rows' | 'dirty'
  | 'view' | 'setView' | 'detailLoading' | 'detailError' | 'justSaved' | 'pendingPage'
  | 'rowFailure' | 'savePage' | 'removePage' | 'loadDetail' | 'confirmPageSaved'
>

interface DraftFocus {
  editor: (reset?: boolean) => void
  editButton: () => void
  pager: () => void
}

export function useOcrDraft(source: DraftSource, isNarrow: Ref<boolean>, focus: DraftFocus) {
  const {
    selectedPath, currentPage, currentRow, rows, dirty, view, setView, detailLoading,
    detailError, justSaved, pendingPage, rowFailure, savePage, removePage, loadDetail, confirmPageSaved,
  } = source

  const editing = ref(false)
  const draft = ref('')
  /**
   * Discard confirmation. A long proofreading session must not lose its page to a
   * stray Esc or a mis-clicked 取消; the dialog is the only path that clears a dirty
   * draft. Esc inside this dialog closes the dialog (reka) and must not then also
   * exit editing — the root Esc handler bails while it is open.
   */
  const discardOpen = ref(false)

  /**
   * 草稿脏状态直接写回 navigation 的 `dirty`：它同时负责阻断换文件/换页/筛选、
   * 路由离开与 beforeunload。只在这里维护，避免组件内外两份真值。
   */
  watch(
    [editing, draft, currentPage, rows],
    () => {
      // Read the unfiltered row directly. Depending on `currentRow` here would
      // create a sync loop: `currentRow` itself switches its source based on
      // `dirty`, so writing `dirty` would invalidate `currentRow` again.
      const row = rows.value.find((item) => item.page === currentPage.value)
      dirty.value =
        editing.value && draft.value !== (row?.result?.markdown ?? '')
    },
    { immediate: true, flush: 'sync' },
  )

  watch([currentPage, selectedPath], () => {
    editing.value = false
    draft.value = ''
  })

  watch(currentRow, (row) => {
    if (!row) {
      editing.value = false
      draft.value = ''
    }
  })

  watch(
    [justSaved, pendingPage],
    ([saved, pending]) => {
      if (editing.value && pending === null && saved === currentPage.value) {
        editing.value = false
        draft.value = ''
        if (currentRow.value) focus.editButton()
        else focus.pager()
      }
    },
  )

  const canEdit = computed(
    () => !!currentRow.value && !detailLoading.value && !detailError.value,
  )
  const editLabel = computed(() =>
    currentRow.value
      ? currentRow.value.result
        ? '编辑'
        : '手工录入'
      : '编辑',
  )

  function startEdit() {
    if (!currentRow.value || !canEdit.value) return
    if (isNarrow.value && view.value === 'image') setView('text')
    draft.value = currentRow.value.result?.markdown ?? ''
    editing.value = true
    void nextTick(() => focus.editor())
  }

  function cancelEdit() {
    // Unchanged draft: leaving costs nothing, so don't interrupt.
    if (!dirty.value) {
      leaveEdit()
      return
    }
    discardOpen.value = true
  }

  /** The confirmed (or no-op) exit from editing. */
  function leaveEdit() {
    discardOpen.value = false
    editing.value = false
    draft.value = ''
    focus.editButton()
  }

  /** Keep the draft and put the caret back where the user was working. */
  function keepEditing() {
    discardOpen.value = false
    void nextTick(() => focus.editor(false))
  }

  /**
   * Esc inside the discard dialog closes only the dialog. When the user is still
   * editing afterwards, focus goes back to the editor (not to the body).
   */
  function onDiscardOpen(value: boolean) {
    discardOpen.value = value
    if (!value && editing.value) {
      // Esc closes only the confirmation: keep the draft *and* the caret place.
      void nextTick(() => focus.editor(false))
    }
  }

  function saveDraft() {
    if (!currentRow.value) return
    void savePage(currentRow.value.page, draft.value)
  }

  /**
   * Inline retry is dispatched by the **failure origin**, not by whether the editor
   * happens to be open. A committed write whose readback was missing must only GET;
   * re-POSTing here would silently turn "readback missing" into a second write.
   */
  async function retry() {
    const failure = rowFailure.value
    if (failure?.action === 'conflict') {
      // 读取最新正文/版本,草稿仍由本工作流持有,不当成保存成功也不自动提交。
      if (selectedPath.value) await loadDetail(selectedPath.value)
      return
    }
    if (failure?.action === 'read') {
      if (!selectedPath.value) return
      await loadDetail(selectedPath.value)
      if (detailError.value || failure.page !== currentPage.value) return
      // The retried read succeeded: verify the original draft against what the
      // server actually returns before leaving edit mode.
      if (
        editing.value &&
        currentRow.value &&
        confirmPageSaved(currentRow.value.page, draft.value)
      ) {
        discardOpen.value = false
        editing.value = false
        draft.value = ''
        if (currentRow.value) focus.editButton()
        else focus.pager()
      }
      return
    }
    if (editing.value && currentRow.value) saveDraft()
    else if (selectedPath.value) void loadDetail(selectedPath.value)
  }

  async function removeCurrent() {
    const page = currentPage.value
    if (page === null) return
    await removePage(page)
    await nextTick()
    focus.pager()
  }

  return {
    editing, draft, discardOpen, canEdit, editLabel,
    startEdit, cancelEdit, leaveEdit, keepEditing, onDiscardOpen,
    saveDraft, retry, removeCurrent,
  }
}
