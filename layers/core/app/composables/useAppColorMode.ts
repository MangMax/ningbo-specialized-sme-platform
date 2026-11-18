import { useColorMode as useVueUseColorMode } from '@vueuse/core'

/**
 * Start new sessions in the approved light direction while preserving a
 * user's existing stored choice, including `auto` and `dark`.
 */
export function useAppColorMode() {
  return useVueUseColorMode({ selector: 'html', initialValue: 'light' })
}
