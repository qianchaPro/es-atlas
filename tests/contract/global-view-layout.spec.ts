import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

test('全局页面内容占用可见的工作区行', async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../..')
  const stylesheet = await readFile(
    path.join(repositoryRoot, 'src/renderer/src/styles.css'),
    'utf8'
  )
  const globalViewRule = /\.workspace\.global-view-active\s*\{(?<body>[^}]*)\}/u.exec(stylesheet)

  assert.ok(globalViewRule?.groups?.body, '缺少全局页面工作区布局规则')
  assert.match(
    globalViewRule.groups.body,
    /grid-template-rows:\s*var\(--topbar-height\)\s+minmax\(0,\s*1fr\);/u
  )
})

test('设置页只展示通过秘籍解锁的彩蛋主题', async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../..')
  const settingsDialog = await readFile(
    path.join(repositoryRoot, 'src/renderer/src/components/SettingsDialog.vue'),
    'utf8'
  )
  const app = await readFile(path.join(repositoryRoot, 'src/renderer/src/App.vue'), 'utf8')

  assert.match(
    settingsDialog,
    /v-if="draft\.global\.unlockedEasterEggThemes\.includes\('starlight'\)"/u
  )
  assert.match(
    settingsDialog,
    /v-if="draft\.global\.unlockedEasterEggThemes\.includes\('pixel'\)"/u
  )
  assert.match(app, /unlockedEasterEggThemes:\s*\[\.\.\./u)
})
