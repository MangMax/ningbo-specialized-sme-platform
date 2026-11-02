<script setup lang="ts">
defineProps<{
  loading: boolean
  kind: 'ledger' | 'comparison' | 'files' | 'platform'
  label: string
}>()
</script>

<template>
  <div
    :data-testid="`${kind}-loading-status`"
    class="absolute inset-x-0 top-0 z-40 h-0"
    aria-live="polite"
  >
    <template v-if="loading">
      <span class="bg-card text-muted-foreground absolute right-2 top-1 z-20 px-2 text-[13px] leading-5">{{ label }}</span>
      <span class="bg-muted absolute inset-x-0 top-0 block h-0.5 overflow-hidden">
        <span :class="`${kind}-progress`" class="table-progress bg-primary block h-0.5 w-1/3" />
      </span>
    </template>
  </div>
</template>

<style scoped>
.table-progress {
  animation: table-progress 1100ms var(--ease-snap) infinite alternate;
}
@keyframes table-progress {
  from { transform: translateX(0); }
  to { transform: translateX(200%); }
}
@media (prefers-reduced-motion: reduce) {
  .table-progress { animation: none; }
}
</style>
