import { expect, it } from 'vitest'
import { platformRowTitle } from '../../../lib/platform/row-title'
it('mixed scopes use only the current row title', () => {
 expect(['1','2','3'].map(rdjb => platformRowTitle('1,2,3', {rdjb}))).toEqual(['1','2','3'])
 expect(platformRowTitle('1,2,3', null)).toBe('')
 expect(platformRowTitle('1,2,3', {rdjb:'4'})).toBe('')
 expect(platformRowTitle('1,2', {rdjb:'3'})).toBe('')
})
it('single-title constraints remain visible to conflict detection', () => {
 expect(platformRowTitle('2', {rdjb:'3'})).toBe('2')
 expect(platformRowTitle('', {rdjb:'3'})).toBe('3')
 expect(platformRowTitle('', {rdjb:2})).toBe('2')
 expect(platformRowTitle('', {})).toBe('')
})
