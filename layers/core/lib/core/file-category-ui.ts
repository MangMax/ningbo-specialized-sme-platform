import type { Component } from 'vue'
import type { FileRow } from '../../server/utils/file-store'
import type { FileCategory } from './file-categories'

export interface FileCategoryUi extends Pick<FileCategory, 'filters' | 'columns'> {
  readonly id: string
  readonly name: string
  readonly cells?: Component
  readonly expandedPanel?: Component
  readonly detailPanel?: Component
  readonly uploadDialog?: Component
  readonly appliesTo?: (file: FileRow) => boolean
}
