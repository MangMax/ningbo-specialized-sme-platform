<script setup lang="ts">
import type { AccordionTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { ChevronDown } from "@lucide/vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "@/lib/utils"
import {
  AccordionHeader,
  AccordionTrigger,
} from "reka-ui"

const props = defineProps<AccordionTriggerProps & {
  class?: HTMLAttributes["class"]
  /**
   * The heading level of the **header container** that wraps the trigger.
   *
   * The level belongs to that container (Reka's `AccordionHeader`), not to the
   * button: a heading nested inside the button would read as a heading inside
   * a heading. Left unset, Reka's own default (h3) applies.
   */
  headerAs?: "h2" | "h3" | "h4"
}>()

// `headerAs` belongs to the header container, not to the button.
const delegatedProps = reactiveOmit(props, "class", "headerAs")
</script>

<template>
  <AccordionHeader class="flex" :as="headerAs">
    <AccordionTrigger
      data-slot="accordion-trigger"
      v-bind="delegatedProps"
      :class="
        cn(
          'focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180',
          props.class,
        )
      "
    >
      <slot />
      <slot name="icon">
        <ChevronDown
          class="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200 motion-reduce:transition-none!"
        />
      </slot>
    </AccordionTrigger>
  </AccordionHeader>
</template>
