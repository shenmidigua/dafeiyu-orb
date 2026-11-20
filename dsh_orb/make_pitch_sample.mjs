/**
 * The shifter on real speech, so the change can be heard before it is trusted.
 *
 * The unit test proves a sine comes out at the pitch it asked for; it cannot say whether a voice
 * still sounds like a voice. This takes one sentence from the service the reader actually uses,
 * shifts it both ways with the shipped function, and writes the three clips side by side.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

// The installed bundle is a symlink to this file, so importing the source here exercises exactly
// the shifter the page runs rather than a copy that can drift from it.
const { shiftPitch } = await import(pathToFileURL(
  join(homedir(), '.dsh', 'dsh_orb', 'dsh-speak-button', 'src', 'speech.js'),
).href)

/** Just enough WAV to read 16-bit PCM and write it back unchanged otherwise. */
function readWav(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let offset = 12
  let format = null
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (format === null) throw new Error('data before fmt')
      if (format.bits !== 16) throw new Error(`expected 16-bit PCM, got ${format.bits}`)
      const frames = Math.floor(size / (2 * format.channels))
      const channels = Array.from({ length: format.channels }, () => new Float32Array(frames))
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < format.channels; channel += 1) {
          const at = body + (frame * format.channels + channel) * 2
          channels[channel][frame] = bytes.readInt16LE(at) / 32768
        }
      }
      return { ...format, frames, channels }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('no data chunk')
}

function writeWav(path, { channels, sampleRate, frames }) {
  const count = channels.length
  const dataBytes = frames * count * 2
  const bytes = Buffer.alloc(44 + dataBytes)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + dataBytes, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(count, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * count * 2, 28)
  bytes.writeUInt16LE(count * 2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(dataBytes, 40)
  let at = 44
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame]))
      bytes.writeInt16LE(Math.round(value * 32767), at)
      at += 2
    }
  }
  writeFileSync(path, bytes)
  return bytes.length
}

const raw = readWav(readFileSync(process.argv[2]))
console.log(`${raw.sampleRate} Hz, ${raw.channels.length} ch, ${(raw.frames / raw.sampleRate).toFixed(2)} s`)

const buffer = {
  numberOfChannels: raw.channels.length,
  length: raw.frames,
  sampleRate: raw.sampleRate,
  getChannelData: (index) => raw.channels[index],
}
const context = {
  createBuffer: (count, length, sampleRate) => {
    const channels = Array.from({ length: count }, () => new Float32Array(length))
    return { numberOfChannels: count, length, sampleRate, getChannelData: (index) => channels[index] }
  },
}

const out = join(homedir(), 'Desktop')
const name = (label) => join(out, `音调-${label}.wav`)
const targets = [[0, '原声'], [4, '高 4 半音'], [-4, '低 4 半音']]
for (const [semitones, label] of targets) {
  const started = Date.now()
  const shifted = semitones === 0 ? buffer : shiftPitch(context, buffer, semitones)
  const channels = Array.from({ length: shifted.numberOfChannels }, (_, index) => shifted.getChannelData(index))
  const size = writeWav(name(label), { channels, sampleRate: raw.sampleRate, frames: shifted.length })
  const ms = Date.now() - started
  console.log(`${label}: ${size} bytes, ${ms} ms${semitones === 0 ? ' (untouched)' : ''}`)
}
