/**
 * Wake Word Detection Module
 * 
 * Simple transcript-based wake word detection using Whisper.
 * No additional ML dependencies - just checks the transcript for configured phrases.
 */

import 'dotenv/config';

const WAKE_WORD_ENABLED = process.env.WAKE_WORD_ENABLED === 'true';
const WAKE_WORD_PHRASES = (process.env.WAKE_WORD_PHRASES || 'jarvis,hey jarvis,hey travis,yo jarvis')
  .split(',')
  .map(p => p.trim().toLowerCase());
const CONVERSATION_WINDOW_MS = parseInt(process.env.CONVERSATION_WINDOW_MS || '60000'); // 60 seconds

// Track when the bot last spoke to each user for conversation window
const lastBotResponseTime = new Map();

/**
 * Check if transcript contains a wake word
 * @param {string} transcript - The transcribed text
 * @param {string} userId - Discord user ID (for conversation window tracking)
 * @returns {{ detected: boolean, cleanedTranscript: string }}
 */
export function checkWakeWord(transcript, userId = null) {
  if (!WAKE_WORD_ENABLED) {
    return { detected: true, cleanedTranscript: transcript };
  }
  
  // Check if we're within the conversation window (bot spoke to this user recently)
  if (userId && lastBotResponseTime.has(userId)) {
    const timeSinceLastResponse = Date.now() - lastBotResponseTime.get(userId);
    if (timeSinceLastResponse < CONVERSATION_WINDOW_MS) {
      console.log(`💬 Within conversation window (${Math.round(timeSinceLastResponse / 1000)}s ago) — wake word not required`);
      return { detected: true, cleanedTranscript: transcript };
    }
  }
  
  const lower = transcript.toLowerCase().trim();
  
  // Check if any wake phrase is at the start of the transcript
  for (const phrase of WAKE_WORD_PHRASES) {
    if (lower.startsWith(phrase)) {
      // Strip the wake word from the transcript
      const cleaned = transcript.substring(phrase.length).trim();
      console.log(`🎯 Wake word detected: "${phrase}"`);
      return { detected: true, cleanedTranscript: cleaned };
    }
    
    // Also check for wake word anywhere in the first few words (flexible matching)
    const words = lower.split(' ');
    const firstFiveWords = words.slice(0, 5).join(' ');
    if (firstFiveWords.includes(phrase)) {
      // Find and remove the wake phrase
      const phraseIndex = lower.indexOf(phrase);
      const cleaned = transcript.substring(phraseIndex + phrase.length).trim();
      console.log(`🎯 Wake word detected (flexible): "${phrase}"`);
      return { detected: true, cleanedTranscript: cleaned };
    }
  }
  
  console.log(`🚫 No wake word detected in: "${transcript.substring(0, 50)}..."`);
  return { detected: false, cleanedTranscript: transcript };
}

/**
 * Mark that the bot just responded to a user (starts the conversation window)
 * @param {string} userId - Discord user ID
 */
export function markBotResponse(userId) {
  if (userId) {
    lastBotResponseTime.set(userId, Date.now());
  }
}

export { WAKE_WORD_ENABLED, WAKE_WORD_PHRASES };
