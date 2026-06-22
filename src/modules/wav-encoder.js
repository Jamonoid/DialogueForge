/**
 * wav-encoder.js — Pure JS WAV encoder (no dependencies).
 * Encodes an AudioBuffer (or a slice of it) into a WAV ArrayBuffer.
 */

/**
 * Encode an AudioBuffer (or a range of samples) to WAV format.
 * @param {AudioBuffer} audioBuffer - The decoded audio buffer.
 * @param {number} [startSample=0] - Start sample index (inclusive).
 * @param {number} [endSample] - End sample index (exclusive). Defaults to buffer length.
 * @returns {ArrayBuffer} WAV file as an ArrayBuffer.
 */
export function encodeWAV(audioBuffer, startSample = 0, endSample) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bitsPerSample = 16;
  const end = endSample ?? audioBuffer.length;
  const numSamples = end - startSample;

  // Interleave channels
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const bufferSize = 44 + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // ─── RIFF header ───
  writeString(view, 0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, 'WAVE');

  // ─── fmt sub-chunk ───
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);            // Sub-chunk size (16 for PCM)
  view.setUint16(20, 1, true);             // Audio format (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // ─── data sub-chunk ───
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // ─── PCM samples ───
  // Get channel data
  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = startSample; i < end; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = channels[ch][i];
      // Clamp to [-1, 1] and convert to Int16
      const clamped = Math.max(-1, Math.min(1, sample));
      const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
