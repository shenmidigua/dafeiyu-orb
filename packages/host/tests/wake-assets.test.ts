import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  discoverWakeAssets,
  readWakeDirectory,
  resolveWakeAsset,
  wakeAssetMime,
  wakeFiles,
} from '../src/wake-assets.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-wake-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const FILES = wakeFiles('hey_jarvis')

/** A directory holding every file the route is allowed to serve. */
function complete(name: string): string {
  const directory = join(root, name)
  for (const file of FILES) {
    const target = join(directory, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, 'x')
  }
  return directory
}

describe('wake assets', () => {
  it('accepts a directory that holds the whole model set', () => {
    const directory = complete('full')
    assert.equal(readWakeDirectory(directory), directory)
  })

  it('rejects a directory that is missing one model', () => {
    const directory = complete('partial')
    rmSync(join(directory, 'hey_jarvis_v0.1.onnx'))
    assert.equal(readWakeDirectory(directory), undefined)
  })

  it('rejects a missing directory and an empty configuration', () => {
    assert.equal(readWakeDirectory(join(root, 'absent')), undefined)
    assert.equal(readWakeDirectory(''), undefined)
  })

  it('resolves only shipped file names inside the root', () => {
    const directory = complete('resolve')
    assert.equal(resolveWakeAsset(directory, 'melspectrogram.onnx'), join(directory, 'melspectrogram.onnx'))
    assert.equal(resolveWakeAsset(directory, 'ort/ort-wasm-simd-threaded.wasm'), join(directory, 'ort', 'ort-wasm-simd-threaded.wasm'))
    assert.equal(resolveWakeAsset(directory, '../secret.onnx'), undefined)
    assert.equal(resolveWakeAsset(directory, '..\\secret.onnx'), undefined)
    assert.equal(resolveWakeAsset(directory, 'ort\\ort-wasm-simd-threaded.wasm'), join(directory, 'ort', 'ort-wasm-simd-threaded.wasm'))
    assert.equal(resolveWakeAsset(directory, 'unknown.onnx'), undefined)
    assert.equal(resolveWakeAsset(directory, ''), undefined)
  })

  it('marks wasm as the content type streaming instantiation requires', () => {
    assert.equal(wakeAssetMime('ort/ort-wasm-simd-threaded.wasm'), 'application/wasm')
    assert.equal(wakeAssetMime('ort/ort-wasm-simd-threaded.mjs'), 'text/javascript; charset=utf-8')
    assert.equal(wakeAssetMime('melspectrogram.onnx'), 'application/octet-stream')
  })

  it('discovers the checkout copy through the environment override', () => {
    const directory = complete('discover')
    const previous = process.env.DSH_ORB_WAKE_ASSETS
    process.env.DSH_ORB_WAKE_ASSETS = directory
    try {
      assert.equal(discoverWakeAssets(), directory)
      assert.equal(discoverWakeAssets('hey_jarvis'), directory)
    } finally {
      if (previous === undefined) delete process.env.DSH_ORB_WAKE_ASSETS
      else process.env.DSH_ORB_WAKE_ASSETS = previous
    }
  })

  it('requires the configured keyword file as well', () => {
    const directory = complete('keyword')
    assert.equal(readWakeDirectory(directory, 'hey_jarvis'), directory)
    assert.equal(readWakeDirectory(directory, 'computer'), undefined)
    assert.equal(resolveWakeAsset(directory, 'computer.onnx', 'computer'), join(directory, 'computer.onnx'))
    assert.equal(resolveWakeAsset(directory, 'computer.onnx', 'hey_jarvis'), undefined)
  })

  it('answers undefined when nothing usable is configured anywhere', () => {
    const previous = process.env.DSH_ORB_WAKE_ASSETS
    process.env.DSH_ORB_WAKE_ASSETS = join(root, 'absent')
    const cwd = process.cwd()
    process.chdir(root)
    try {
      assert.equal(discoverWakeAssets(), undefined)
    } finally {
      process.chdir(cwd)
      if (previous === undefined) delete process.env.DSH_ORB_WAKE_ASSETS
      else process.env.DSH_ORB_WAKE_ASSETS = previous
    }
  })
})
