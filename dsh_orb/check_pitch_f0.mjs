/**
 * What the shifter did to a real voice, in numbers.
 *
 * A sine says the arithmetic is right; it cannot say whether a sentence survives the grains. So
 * three clips that were written to the Desktop are read back and their voiced pitch compared:
 * the shifted ones should sit a fixed musical interval from the untouched one, and all three
 * should still be the same length and the same loudness. Run `make_pitch_sample.mjs` first.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function readWav(path) {
  const bytes = readFileSync(path)
  let offset = 12
  let format = null
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = { channels: bytes.readUInt16LE(body + 2), sampleRate: bytes.readUInt32LE(body + 4) }
    } else if (id === 'data') {
      const frames = Math.floor(size / (2 * format.channels))
      const data = new Float32Array(frames)
      for (let frame = 0; frame < frames; frame += 1) {
        data[frame] = bytes.readInt16LE(body + frame * 2 * format.channels) / 32768
      }
      return { ...format, data }
    }
    offset = body + size + (size % 2)
  }
  throw new Error(`no data in ${path}`)
}

/** The median voiced pitch: frame-level autocorrelation, gated on energy. */
function pitchOf({ data, sampleRate }) {
  const frame = Math.round(sampleRate * 0.04)
  const hop = Math.round(frame / 2)
  const low = Math.floor(sampleRate / 400)
  const high = Math.ceil(sampleRate / 70)
  const found = []
  for (let start = 0; start + frame + high < data.length; start += hop) {
    let energy = 0
    for (let i = 0; i < frame; i += 1) energy += data[start + i] * data[start + i]
    if (energy / frame < 0.002) continue
    let best = 0
    let bestLag = 0
    for (let lag = low; lag <= high; lag += 1) {
      let sum = 0
      for (let i = 0; i < frame; i += 1) sum += data[start + i] * data[start + i + lag]
      if (sum > best) {
        best = sum
        bestLag = lag
      }
    }
    if (bestLag > 0) found.push(sampleRate / bestLag)
  }
  if (found.length === 0) return null
  found.sort((a, b) => a - b)
  return found[Math.floor(found.length / 2)]
}

function peakOf({ data }) {
  let peak = 0
  for (const value of data) peak = Math.max(peak, Math.abs(value))
  return peak
}

const desktop = join(homedir(), 'Desktop')
const clips = {
  '原声': readWav(join(desktop, '音调-原声.wav')),
  '高 4 半音': readWav(join(desktop, '音调-高 4 半音.wav')),
  '低 4 半音': readWav(join(desktop, '音调-低 4 半音.wav')),
}

const base = clips['原声']
const basePitch = pitchOf(base)
console.log(`原声: ${(base.data.length / base.sampleRate).toFixed(2)} s, peak ${peakOf(base).toFixed(3)}, pitch ${basePitch.toFixed(1)} Hz`)

let failures = 0
for (const [label, clip] of Object.entries(clips)) {
  if (label === '原声') continue
  const pitch = pitchOf(clip)
  const seconds = clip.data.length / clip.sampleRate
  const expected = basePitch * Math.pow(2, (label.startsWith('高') ? 4 : -4) / 12)
  const error = Math.abs(pitch - expected) / expected
  const sameLength = Math.abs(seconds - base.data.length / base.sampleRate) < 0.01
  const sameLevel = Math.abs(peakOf(clip) - peakOf(base)) < 0.15
  const ok = error < 0.08 && sameLength && sameLevel
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${seconds.toFixed(2)} s, peak ${peakOf(clip).toFixed(3)}, pitch ${pitch.toFixed(1)} Hz (expected ~${expected.toFixed(1)}, off ${(error * 100).toFixed(1)}%)`)
}

process.exitCode = failures === 0 ? 0 : 1
