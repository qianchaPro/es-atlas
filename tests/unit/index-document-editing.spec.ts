import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isProxy, reactive } from 'vue'
import {
  formatCellEditorValue,
  toIpcDocumentSource
} from '../../src/renderer/src/components/index-document-editing.ts'

describe('索引文档单元格编辑', () => {
  it('null 进入编辑器时显示为空', () => {
    assert.equal(formatCellEditorValue(null), '')
    assert.equal(formatCellEditorValue('value'), 'value')
    assert.equal(formatCellEditorValue({ nested: true }), '{"nested":true}')
  })

  it('IPC 文档源不包含 Vue Proxy，并保留 null 与嵌套 JSON 值', () => {
    const reactiveSource = reactive({
      nullable: null,
      nested: { value: 1 },
      list: [{ enabled: true }]
    })

    assert.throws(() => structuredClone(reactiveSource), /could not be cloned/u)

    const ipcSource = toIpcDocumentSource(reactiveSource)

    assert.equal(isProxy(ipcSource), false)
    assert.equal(isProxy(ipcSource.nested), false)
    assert.doesNotThrow(() => structuredClone({ source: ipcSource }))
    assert.deepEqual(ipcSource, {
      nullable: null,
      nested: { value: 1 },
      list: [{ enabled: true }]
    })
  })
})
