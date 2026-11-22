/** @typedef {import('./types').WaveObject} WaveObject */
/** @typedef {import('./types').MultiChannelWaveObject} MultiChannelWaveObject */
/**
 * @typedef {import('./types').OnlineRecognizerResult} OnlineRecognizerResult
 */
/**
 * @typedef {import('./types').OfflineRecognizerResult} OfflineRecognizerResult
 */

const addon = require('./addon.cjs')
const streaming_asr = require('./streaming-asr.cjs');
const non_streaming_asr = require('./non-streaming-asr.cjs');
const non_streaming_tts = require('./non-streaming-tts.cjs');
const vad = require('./vad.cjs');
const slid = require('./spoken-language-identification.cjs');
const sid = require('./speaker-identification.cjs');
const at = require('./audio-tagg.cjs');
const punct = require('./punctuation.cjs');
const fa = require('./forced-alignment.cjs');
const kws = require('./keyword-spotter.cjs');
const sd = require('./non-streaming-speaker-diarization.cjs');
const speech_denoiser = require('./non-streaming-speech-denoiser.cjs');
const online_speech_denoiser = require('./online-speech-denoiser.cjs');
const resampler = require('./resampler.cjs');
const source_separation = require('./offline-source-separation.cjs');

module.exports = {
  OnlineRecognizer : streaming_asr.OnlineRecognizer,
  OfflineRecognizer : non_streaming_asr.OfflineRecognizer,
  OfflineTts : non_streaming_tts.OfflineTts,
  GenerationConfig : non_streaming_tts.GenerationConfig,
  readWave : addon.readWave,
  writeWave : addon.writeWave,
  readWaveMultiChannel : addon.readWaveMultiChannel,
  writeWaveMultiChannel : addon.writeWaveMultiChannel,
  Display : streaming_asr.Display,
  Vad : vad.Vad,
  CircularBuffer : vad.CircularBuffer,
  SpokenLanguageIdentification : slid.SpokenLanguageIdentification,
  SpeakerEmbeddingExtractor : sid.SpeakerEmbeddingExtractor,
  SpeakerEmbeddingManager : sid.SpeakerEmbeddingManager,
  AudioTagging : at.AudioTagging,
  OfflinePunctuation : punct.OfflinePunctuation,
  ForcedAligner : fa.ForcedAligner,
  OnlinePunctuation : punct.OnlinePunctuation,
  KeywordSpotter : kws.KeywordSpotter,
  OfflineSpeakerDiarization : sd.OfflineSpeakerDiarization,
  OfflineSpeechDenoiser : speech_denoiser.OfflineSpeechDenoiser,
  OnlineSpeechDenoiser : online_speech_denoiser.OnlineSpeechDenoiser,
  LinearResampler : resampler.LinearResampler,
  OfflineSourceSeparation : source_separation.OfflineSourceSeparation,
  version : addon.version,
  gitSha1 : addon.gitSha1,
  gitDate : addon.gitDate,
  onnxruntimeVersion : addon.onnxruntimeVersion,
}
