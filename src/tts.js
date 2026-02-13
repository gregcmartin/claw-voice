/**
 * Text-to-Speech Module
 * 
 * Supports Edge TTS (free, Australian William voice) and OpenAI TTS
 * Returns path to generated audio file (MP3) or a Readable stream for streaming mode
 */

import OpenAI from 'openai';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const provider = process.env.TTS_PROVIDER || 'edge';
const STREAMING_TTS_ENABLED = process.env.STREAMING_TTS_ENABLED !== 'false'; // Default true

// Find edge-tts binary
const EDGE_TTS_BIN = process.env.EDGE_TTS_PATH || `${process.env.HOME}/.local/bin/edge-tts`;

let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/**
 * Sanitize text input for TTS to avoid crashes
 * @param {string} text - Raw text input
 * @returns {string|null} Sanitized text, or null if text is invalid/empty
 */
function sanitizeTextForTTS(text) {
  if (!text || typeof text !== 'string') return null;
  
  // Strip control characters, zero-width chars, and other problematic Unicode
  let cleaned = text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Control chars
    .replace(/[\u200B-\u200D\uFEFF]/g, '')         // Zero-width chars
    .replace(/[\u00AD]/g, '')                       // Soft hyphens
    .trim();
  
  // If text is ONLY punctuation marks (e.g., just "?", "!", "..."), return null
  const textWithoutPunctuation = cleaned.replace(/[.,!?;:\-—…'"]/g, '').trim();
  if (textWithoutPunctuation.length === 0) {
    console.log('⏭️  Text is only punctuation, skipping TTS synthesis');
    return null;
  }
  
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  return cleaned;
}

/**
 * Synthesize text to speech and save to a file
 * @param {string} text - Text to speak
 * @returns {Promise<string>} Path to audio file
 */
export async function synthesizeSpeech(text) {
  // Sanitize input
  const sanitized = sanitizeTextForTTS(text);
  if (!sanitized) {
    console.log('⏭️  Empty/invalid text after sanitization, skipping synthesis');
    return null;
  }
  switch (provider) {
    case 'edge':
      return synthesizeEdge(sanitized);
    case 'openai':
      return synthesizeOpenAI(sanitized);
    default:
      return synthesizeEdge(sanitized);
  }
}

/**
 * Synthesize text to speech as a streaming Readable
 * @param {string} text - Text to speak
 * @returns {Promise<Readable>} Readable stream of MP3 audio
 */
export async function synthesizeSpeechStream(text) {
  // Sanitize input
  const sanitized = sanitizeTextForTTS(text);
  if (!sanitized) {
    console.log('⏭️  Empty/invalid text after sanitization, skipping synthesis');
    return null;
  }
  switch (provider) {
    case 'edge':
      return synthesizeEdgeStream(sanitized);
    case 'openai':
      return synthesizeOpenAIStream(sanitized);
    default:
      return synthesizeEdgeStream(sanitized);
  }
}

async function synthesizeEdge(text) {
  const outputPath = join(TMP_DIR, `tts_${Date.now()}.mp3`);
  const voice = process.env.EDGE_TTS_VOICE || 'en-AU-WilliamNeural';
  
  try {
    await execFileAsync(EDGE_TTS_BIN, [
      '--voice', voice,
      '--text', text,
      '--write-media', outputPath,
    ], { timeout: 15000 });
    
    return outputPath;
  } catch (err) {
    console.error('Edge TTS failed, falling back to OpenAI:', err.message);
    try {
      return await synthesizeOpenAI(text);
    } catch (fallbackErr) {
      console.error('OpenAI TTS fallback also failed:', fallbackErr.message);
      return null;
    }
  }
}

function synthesizeEdgeStream(text) {
  return new Promise((resolve, reject) => {
    const voice = process.env.EDGE_TTS_VOICE || 'en-AU-WilliamNeural';
    
    // Spawn edge-tts with stdout output
    const proc = spawn(EDGE_TTS_BIN, [
      '--voice', voice,
      '--text', text,
      '--write-media', '-', // Write to stdout
    ]);
    
    // Edge TTS may write some text to stderr before audio starts
    proc.stderr.on('data', (chunk) => {
      // Ignore stderr noise
    });
    
    let started = false;
    const stream = new Readable({
      read() {}
    });
    
    // Timeout fallback — stored so we can clear on success
    const timeoutId = setTimeout(() => {
      if (!started) {
        proc.kill('SIGKILL');
        reject(new Error('Edge TTS stream timeout'));
      }
    }, 5000);
    
    proc.stdout.on('data', (chunk) => {
      if (!started) {
        started = true;
        clearTimeout(timeoutId);
        resolve(stream);
      }
      stream.push(chunk);
    });
    
    proc.stdout.on('end', () => {
      stream.push(null);
    });
    
    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      if (!started) {
        reject(new Error(`Edge TTS stream failed: ${err.message}`));
      }
    });
    
    proc.on('exit', (code) => {
      clearTimeout(timeoutId);
      if (!started && code !== 0) {
        reject(new Error(`Edge TTS exited with code ${code}`));
      }
    });
  });
}

async function synthesizeOpenAI(text) {
  const outputPath = join(TMP_DIR, `tts_${Date.now()}.mp3`);
  
  const model = process.env.OPENAI_TTS_MODEL || 'tts-1';
  const voice = process.env.OPENAI_TTS_VOICE || 'onyx';
  
  const response = await getOpenAI().audio.speech.create({
    model,
    voice,
    input: text,
    speed: 1.0,
    response_format: 'mp3',
  });
  
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, buffer);
  
  return outputPath;
}

async function synthesizeOpenAIStream(text) {
  const model = process.env.OPENAI_TTS_MODEL || 'tts-1';
  const voice = process.env.OPENAI_TTS_VOICE || 'onyx';
  
  const response = await getOpenAI().audio.speech.create({
    model,
    voice,
    input: text,
    speed: 1.0,
    response_format: 'mp3',
  });
  
  // Convert web ReadableStream to Node Readable
  const webStream = response.body;
  const reader = webStream.getReader();
  
  const nodeStream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
        } else {
          this.push(Buffer.from(value));
        }
      } catch (err) {
        this.destroy(err);
      }
    }
  });
  
  return nodeStream;
}

/**
 * Split text into sentences for chunked streaming
 * @param {string} text - Text to split
 * @returns {string[]} Array of sentences
 */
export function splitIntoSentences(text) {
  // Split on . ! ? followed by space or end of string
  // Keep the punctuation with the sentence
  const sentences = text
    .split(/([.!?]+\s+|[.!?]+$)/g)
    .filter(s => s.trim().length > 0);
  
  // Recombine sentence with its punctuation
  const result = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const sentence = sentences[i].trim();
    const punct = sentences[i + 1] || '';
    if (sentence) {
      result.push(sentence + punct);
    }
  }
  
  return result.filter(s => s.length > 0);
}

export { STREAMING_TTS_ENABLED };
