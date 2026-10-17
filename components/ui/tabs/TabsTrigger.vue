<script setup lang="ts">
import type { TabsTriggerProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { computed } from "vue";
import { motion, useReducedMotion } from "motion-v";
import { injectTabsRootContext, TabsTrigger, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<
  TabsTriggerProps & { class?: HTMLAttributes["class"] }
>();

const delegatedProps = reactiveOmit(props, "class");

const forwardedProps = useForwardProps(delegatedProps);
const tabs = injectTabsRootContext();
const isSelected = computed(() => tabs.modelValue.value === props.value);
const reducedMotion = useReducedMotion();
</script>

<template>
  <TabsTrigger
    data-slot="tabs-trigger"
    :class="
      cn(
        `relative isolate data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-muted-foreground hover:text-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-snap motion-reduce:transition-none focus-visible:ring-3 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
        props.class,
      )
    "
    v-bind="forwardedProps"
  >
    <motion.span
      v-if="isSelected"
      aria-hidden="true"
      data-slot="tabs-indicator"
      :layout-id="reducedMotion ? undefined : 'tabs-indicator'"
      :initial="false"
      :transition="reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 38 }"
      class="bg-background dark:bg-input pointer-events-none absolute inset-0 rounded-md shadow-sm"
    />
    <span class="relative inline-flex items-center gap-1.5"><slot /></span>
  </TabsTrigger>
</template>
