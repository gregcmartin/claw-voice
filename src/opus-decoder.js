/**
 * Opus Decoder Transform Stream
 *
 * Decodes Discord's Opus audio frames to raw PCM (48kHz, 16-bit, mono)
 * Uses opusscript (pure JS) to avoid native module segfaults
 */

import { Transform } from 'stream';
import OpusScript from 'opusscript';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960;

export class OpusDecoder extends Transform {
  constructor() {
    super();
    this.opus = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  }

  _transform(chunk, encoding, callback) {
    try {
      const decoded = this.opus.decode(chunk);
      this.push(Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength));
    } catch {
      // Swallow decode errors (corrupted frames happen)
    }
    callback();
  }

  _flush(callback) {
    callback();
  }

  _destroy(err, callback) {
    try { this.opus.delete(); } catch {}
    callback(err);
  }
}
