import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  discoverWakeAssets,
  readWakeDirectory,
  resolveWakeAsset,
  resolveWakeAssets,
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

describe('choosing the asset directory', () => {
  /**
   * Point discovery at one known-good directory and away from everything else.
   *
   * `discoverWakeAssets` also searches the working directory and four levels up from this file,
   * which on a developer checkout is the project root — the very place the real models live. Any
   * assertion about *which* directory discovery picks would therefore depend on whether the
   * machine running the tests happens to have a checkout, and would pass or fail for reasons that
   * have nothing to do with the code. Pinning the environment override and running from an empty
   * directory makes the only reachable candidate the fixture.
   */
  function withDiscoveryPinnedTo(directory: string | undefined, body: () => void): void {
    const previous = process.env.DSH_ORB_WAKE_ASSETS
    const cwd = process.cwd()
    const empty = join(root, 'empty-cwd')
    mkdirSync(empty, { recursive: true })
    if (directory === undefined) delete process.env.DSH_ORB_WAKE_ASSETS
    else process.env.DSH_ORB_WAKE_ASSETS = directory
    process.chdir(empty)
    try {
      body()
    } finally {
      process.chdir(cwd)
      if (previous === undefined) delete process.env.DSH_ORB_WAKE_ASSETS
      else process.env.DSH_ORB_WAKE_ASSETS = previous
    }
  }

  it('uses the configured directory when it still holds the models', () => {
    const directory = complete('chosen')
    assert.equal(resolveWakeAssets({ assetDirectory: directory, keyword: 'hey_jarvis' }), directory)
  })

  it('does not take a configured directory on faith', () => {
    // The bug this guards: a configured path used to be resolved and handed straight to the
    // helper without being opened, so a checkout that had moved produced a helper pointing at
    // nothing. Every model request 404s, and the ball's only honest statement is "unavailable".
    withDiscoveryPinnedTo(complete('chosen-fallback'), () => {
      assert.equal(
        resolveWakeAssets({ assetDirectory: join(root, 'moved-away'), keyword: 'hey_jarvis' }),
        join(root, 'chosen-fallback'),
        'a directory that no longer holds the models was still used',
      )
    })
  })

  it('rejects a configured directory that is missing the configured keyword model', () => {
    // The keyword is part of the required set, so pointing a `dafeiyu` profile at a directory
    // that only has the shipped `hey_jarvis` is the same failure as a missing directory.
    const directory = complete('wrong-keyword')
    assert.equal(readWakeDirectory(directory, 'dafeiyu'), undefined)
    withDiscoveryPinnedTo(undefined, () => {
      assert.notEqual(resolveWakeAssets({ assetDirectory: directory, keyword: 'dafeiyu' }), directory)
    })
  })

  it('discovers when nothing is configured at all', () => {
    const fallback = complete('discover-only')
    withDiscoveryPinnedTo(fallback, () => {
      assert.equal(resolveWakeAssets({ assetDirectory: '', keyword: 'hey_jarvis' }), fallback)
    })
  })

  it('answers undefined rather than a path that cannot serve anything', () => {
    // The one answer that must never be a path: with nothing usable there is no directory to
    // hand over, and the caller reports the wake word as unavailable instead. Discovery is pinned
    // off and the search rooted in an empty directory, so the four-levels-up candidate cannot
    // quietly supply an answer on a machine that has a checkout.
    withDiscoveryPinnedTo(join(root, 'absent'), () => {
      assert.equal(resolveWakeAssets({ assetDirectory: '', keyword: 'hey_jarvis' }), undefined)
      assert.equal(resolveWakeAssets({ assetDirectory: join(root, 'absent'), keyword: 'hey_jarvis' }), undefined)
    })
  })
})
