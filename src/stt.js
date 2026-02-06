/**
 * Speech-to-Text Module
 * 
 * Supports multiple STT providers:
 * - Deepgram (streaming, real-time, faster)
 * - OpenAI Whisper (batch, high accuracy)
 */

import OpenAI from 'openai';
import { createClient } from '@deepgram/sdk';
import { createReadStream } from 'fs';
import 'dotenv/config';

const STT_PROVIDER = process.env.STT_PROVIDER || 'deepgram'; // 'deepgram' or 'whisper'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

/**
 * Post-process transcript to correct domain-specific vocabulary
 * @param {string} text - Raw transcript text
 * @returns {string} Corrected transcript
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
  // Company-specific terms can be configured via env vars if needed
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
  processed = processed.replace(/\btravis\b/gi, 'Jarvis');

  return processed;
}

/**
 * Transcribe audio file using configured provider with automatic fallback
 * @param {string} wavPath - Path to WAV file
 * @returns {Promise<string>} Transcript text
 */
export async function transcribeAudio(wavPath) {
  let transcript;
  
  if (STT_PROVIDER === 'deepgram') {
    try {
      transcript = await transcribeWithDeepgram(wavPath);
    } catch (err) {
      console.warn('⚠️  Deepgram failed, falling back to Whisper:', err.message);
      transcript = await transcribeWithWhisper(wavPath);
    }
  } else {
    transcript = await transcribeWithWhisper(wavPath);
  }

  // Apply post-processing corrections
  return postProcessTranscript(transcript);
}

/**
 * Transcribe with Deepgram (faster, streaming-capable)
 */
async function transcribeWithDeepgram(wavPath) {
  try {
    const audioStream = createReadStream(wavPath);
    
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioStream,
      {
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        punctuate: true,
        diarize: false,
        keywords: ['Jarvis'],
      }
    );

    if (error) {
      throw error;
    }

    const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    
    if (!transcript) {
      throw new Error('No transcript returned from Deepgram');
    }

    return transcript.trim();
  } catch (err) {
    console.error('Deepgram STT Error:', err.message);
    throw err;
  }
}

/**
 * Transcribe with OpenAI Whisper (fallback)
 */
async function transcribeWithWhisper(wavPath) {
  try {
    const response = await openai.audio.transcriptions.create({
      file: createReadStream(wavPath),
      model: 'whisper-1',
      language: 'en',
      response_format: 'text',
      prompt: 'Jarvis, voice assistant',
    });
    
    return response.trim();
  } catch (err) {
    console.error('Whisper STT Error:', err.message);
    throw err;
  }
}
