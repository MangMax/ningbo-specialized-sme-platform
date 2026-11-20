import type { CurrentQualificationAssessment } from './current-qualification'
import type { CurrentTitle } from './current-titles'

export interface EffectiveQualification {
  titleCode: CurrentTitle
  basis: string
  supportingTitle?: CurrentTitle
}

export function projectEffectiveQualifications(titles: readonly Pick<CurrentQualificationAssessment, 'titleCode' | 'effectiveQualification'>[]): EffectiveQualification[] {
  return titles.flatMap(({ titleCode, effectiveQualification }) => {
    if (effectiveQualification?.status !== 'effective') return []
    const { basis, supportingTitle } = effectiveQualification
    return [{ titleCode, basis, ...(supportingTitle ? { supportingTitle } : {}) }]
  })
}
