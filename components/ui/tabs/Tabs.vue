<script setup lang="ts">
import type { TabsRootEmits, TabsRootProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { useId } from "vue";
import { LayoutGroup } from "motion-v";
import { TabsRoot, useForwardPropsEmits } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<
  TabsRootProps & { class?: HTMLAttributes["class"] }
>();
defineOptions({ inheritAttrs: false });
const emits = defineEmits<TabsRootEmits>();

const delegatedProps = reactiveOmit(props, "class");
const forwarded = useForwardPropsEmits(delegatedProps, emits);
const motionGroupId = useId();
</script>

<template>
  <LayoutGroup :id="motionGroupId">
    <TabsRoot
      v-slot="slotProps"
      data-slot="tabs"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('flex flex-col gap-2', props.class)"
    >
      <slot v-bind="slotProps" />
    </TabsRoot>
  </LayoutGroup>
</template>
