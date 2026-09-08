import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CAPABILITY_KEYS,
  createCapabilityMatrix,
  parseEngineVersion
} from '../../electron/main/es/capability-matrix.ts'
import { isCapabilityUnsupportedByProductVersion } from '../../src/shared/capability-support.ts'

describe('集群能力矩阵', () => {
  it('稳定输出全部逻辑能力键', () => {
    const matrix = createCapabilityMatrix({
      engine: 'Elasticsearch',
      version: '8.17.3',
      mode: 'direct'
    })

    assert.equal(CAPABILITY_KEYS.length, 16)
    assert.deepEqual(Object.keys(matrix.capabilities), [...CAPABILITY_KEYS])
  })

  it('按 Elasticsearch 7 的 minor 门槛区分高级能力', () => {
    const early = createCapabilityMatrix({
      engine: 'Elasticsearch',
      version: '7.3.1',
      mode: 'direct'
    })
    const current = createCapabilityMatrix({
      engine: 'elasticsearch',
      version: '7.17.24',
      mode: 'direct'
    })

    assert.equal(early.capabilities.health.supported, true)
    assert.equal(early.capabilities.componentTemplates.supported, false)
    assert.equal(early.capabilities.dataStreams.supported, false)
    assert.equal(early.capabilities.asyncSearch.supported, false)
    assert.equal(early.capabilities.asyncSearch.reasonKind, 'product-version-unsupported')
    assert.equal(current.capabilities.componentTemplates.supported, true)
    assert.equal(current.capabilities.dataStreams.supported, true)
    assert.equal(current.capabilities.asyncSearch.supported, true)
  })

  it('覆盖 Elasticsearch 8 和 9 的完整目标能力', () => {
    for (const version of ['8.19.0', '9.0.0-rc1']) {
      const matrix = createCapabilityMatrix({
        engine: 'Elasticsearch',
        version,
        mode: 'direct'
      })

      assert.equal(Object.values(matrix.capabilities).every((item) => item.supported), true)
      assert.equal(matrix.capabilities.reindex.writeSupported, true)
    }
  })

  it('覆盖 OpenSearch 1、2、3 及其专用异步搜索能力', () => {
    for (const version of ['1.3.19', '2.19.1', '3.0.0']) {
      const matrix = createCapabilityMatrix({
        engine: 'OpenSearch',
        version,
        mode: 'direct'
      })

      assert.equal(Object.values(matrix.capabilities).every((item) => item.supported), true)
      assert.equal(matrix.capabilities.asyncSearch.endpointVariants[0], '/_plugins/_asynchronous_search')
    }
  })

  it('Kibana proxy 保留读取候选但禁用所有写入', () => {
    const matrix = createCapabilityMatrix({
      engine: 'Elasticsearch',
      version: '8.17.3',
      mode: 'kibana'
    })

    assert.equal(matrix.capabilities.health.supported, true)
    assert.equal(matrix.capabilities.indexTemplates.supported, true)
    assert.equal(Object.values(matrix.capabilities).every((item) => !item.writeSupported), true)
    assert.equal(matrix.capabilities.reindex.supported, false)
    assert.equal(matrix.capabilities.reindex.reasonKind, 'proxy-unverified')
  })

  it('未知产品和未知未来版本仅保留公共只读最佳努力能力', () => {
    const unknownProduct = createCapabilityMatrix({
      engine: 'CustomSearch',
      version: '1.0.0',
      mode: 'direct'
    })
    const futureVersion = createCapabilityMatrix({
      engine: 'Elasticsearch',
      version: '10.0.0',
      mode: 'direct'
    })

    assert.equal(unknownProduct.capabilities.health.supported, true)
    assert.equal(unknownProduct.capabilities.health.reasonKind, 'unknown-product')
    assert.equal(unknownProduct.capabilities.reindex.supported, false)
    assert.equal(unknownProduct.capabilities.reindex.writeSupported, false)
    assert.equal(futureVersion.capabilities.nodes.supported, true)
    assert.equal(futureVersion.capabilities.nodes.reasonKind, 'unknown-version')
    assert.equal(futureVersion.capabilities.snapshots.supported, false)
    assert.equal(Object.values(futureVersion.capabilities).every((item) => !item.writeSupported), true)
  })

  it('权限不足与产品版本不支持使用不同原因', () => {
    const matrix = createCapabilityMatrix({
      engine: 'Elasticsearch',
      version: '7.3.1',
      mode: 'direct',
      permissions: {
        health: 'denied'
      }
    })

    assert.equal(matrix.capabilities.health.supported, false)
    assert.equal(matrix.capabilities.health.reasonKind, 'permission-denied')
    assert.equal(matrix.capabilities.stats.supported, true)
    assert.equal(matrix.capabilities.stats.reasonKind, 'permission-unknown')
    assert.equal(matrix.capabilities.componentTemplates.reasonKind, 'product-version-unsupported')
  })

  it('版本解析保留原始值并支持预发布和自定义后缀', () => {
    assert.deepEqual(parseEngineVersion('9.0.0-rc1'), {
      raw: '9.0.0-rc1',
      major: 9,
      minor: 0,
      patch: 0,
      prerelease: 'rc1'
    })
    assert.deepEqual(parseEngineVersion('2.19.1-custom+build'), {
      raw: '2.19.1-custom+build',
      major: 2,
      minor: 19,
      patch: 1,
      prerelease: 'custom+build'
    })
    assert.deepEqual(parseEngineVersion('unknown'), {
      raw: 'unknown',
      major: null,
      minor: null,
      patch: null,
      prerelease: null
    })
  })

  it('仅将已确认不支持的产品版本能力标记为隐藏候选', () => {
    assert.equal(
      isCapabilityUnsupportedByProductVersion('componentTemplates', 'Elasticsearch', '7.7.0'),
      true
    )
    assert.equal(
      isCapabilityUnsupportedByProductVersion('componentTemplates', 'Elasticsearch', '7.8.0'),
      false
    )
    assert.equal(
      isCapabilityUnsupportedByProductVersion('dataStreams', 'Elasticsearch', '7.8.0'),
      true
    )
    assert.equal(
      isCapabilityUnsupportedByProductVersion('dataStreams', 'Elasticsearch', '7.9.0'),
      false
    )
    assert.equal(
      isCapabilityUnsupportedByProductVersion('dataStreams', 'OpenSearch', '1.0.0'),
      false
    )
    assert.equal(
      isCapabilityUnsupportedByProductVersion('snapshots', 'Elasticsearch', '10.0.0'),
      false
    )
  })
})
