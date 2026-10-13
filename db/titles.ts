/** 称号字典种子。rank 越小等级越高。 */
export const TITLE_SEED = [
  { code: 'little_giant', nameZh: '专精特新“小巨人”', level: 'national', rank: 1 },
  { code: 'specialized_sme', nameZh: '专精特新中小企业', level: 'municipal', rank: 2 },
  { code: 'innovative_sme', nameZh: '创新型中小企业', level: 'municipal', rank: 3 },
] as const

export type TitleCode = (typeof TITLE_SEED)[number]['code']
