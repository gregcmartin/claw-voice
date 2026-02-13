/**
 * Speech-to-Text Module
 *
 * Primary: Local Lightning Whisper MLX server (~200ms on Apple Silicon)
 * Fallback: Deepgram API, then OpenAI Whisper API
 */

import OpenAI from 'openai';
import { createClient } from '@deepgram/sdk';
import { createReadStream, readFileSync } from 'fs';
import 'dotenv/config';

const STT_PROVIDER = process.env.STT_PROVIDER || 'mlx'; // 'mlx', 'deepgram', or 'whisper'
const MLX_WHISPER_URL = process.env.MLX_WHISPER_URL || 'http://127.0.0.1:8787';

let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// Only create Deepgram client if configured
let deepgram;
if (process.env.DEEPGRAM_API_KEY) {
  deepgram = createClient(process.env.DEEPGRAM_API_KEY);
}

/**
 * Post-process transcript to correct domain-specific vocabulary
 */
function postProcessTranscript(text) {
  let processed = text;

  // Technical terms
  processed = processed.replace(/\bsole file\b/gi, 'SOUL file');
  processed = processed.replace(/\bsole\.md\b/gi, 'SOUL.md');
  processed = processed.replace(/\bsole dot md\b/gi, 'SOUL.md');
  processed = processed.replace(/\bpound general\b/gi, '#general');
  processed = processed.replace(/\bhashtag general\b/gi, '#general');
  processed = processed.replace(/\bpound (\w+)/gi, '#$1');
  processed = processed.replace(/\bhai ?ve ?mind\b/gi, 'haivemind');
  processed = processed.replace(/\bhive mind\b/gi, 'haivemind');
  processed = processed.replace(/\bclawd ?bot\b/gi, 'Clawdbot');
  processed = processed.replace(/\bcloud bot\b/gi, 'Clawdbot');
  processed = processed.replace(/\bm c p\b/gi, 'MCP');
  processed = processed.replace(/\bdeep ?gram\b/gi, 'Deepgram');
  processed = processed.replace(/\brad ?air\b/gi, 'Radare2');
  processed = processed.replace(/\bradar (two|2)\b/gi, 'Radare2');
  processed = processed.replace(/\bvirus ?total\b/gi, 'VirusTotal');
  processed = processed.replace(/\bgit ?hub\b/gi, 'GitHub');

  // Name corrections
  processed = processed.replace(/\btravis\b/gi, 'Mandy');

  return processed;
}

/**
 * Transcribe audio file using configured provider with automatic fallback
 * @param {string} wavPath - Path to WAV file
 * @returns {Promise<string>} Transcript text
 */
export async function transcribeAudio(wavPath) {
  let transcript;

  // Try primary provider, then cascade through fallbacks
  const providers = STT_PROVIDER === 'mlx'
    ? [transcribeWithMLX, transcribeWithDeepgram, transcribeWithWhisper]
    : STT_PROVIDER === 'deepgram'
      ? [transcribeWithDeepgram, transcribeWithMLX, transcribeWithWhisper]
      : [transcribeWithWhisper];

  for (const provider of providers) {
    try {
      transcript = await provider(wavPath);
      break; // Success
    } catch (err) {
      console.warn(`⚠️  ${provider.name} failed: ${err.message}`);
    }
  }

  if (!transcript) return '';
  return postProcessTranscript(transcript);
}

/**
 * Transcribe with local Lightning Whisper MLX server (~200ms)
 */
async function transcribeWithMLX(wavPath) {
  const audioBuffer = readFileSync(wavPath);

  const res = await fetch(`${MLX_WHISPER_URL}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: audioBuffer,
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`MLX server ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

/**
 * Transcribe with Deepgram API
 */
async function transcribeWithDeepgram(wavPath) {
  if (!deepgram) throw new Error('Deepgram not configured');

  const audioBuffer = readFileSync(wavPath);
  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: 'nova-2',
      language: 'en',
      smart_format: true,
      punctuate: true,
      diarize: false,
      keywords: ['Mandy'],
      mimetype: 'audio/wav',
    }
  );

  if (error) throw error;

  const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  return transcript.trim();
}

/**
 * Transcribe with OpenAI Whisper API
 */
async function transcribeWithWhisper(wavPath) {
  const response = await getOpenAI().audio.transcriptions.create({
    file: createReadStream(wavPath),
    model: 'whisper-1',
    language: 'en',
    response_format: 'text',
    prompt: 'Mandy, voice assistant',
  });

  return response.trim();
}
