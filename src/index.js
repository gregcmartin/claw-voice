/**
 * Mandy Voice Bot - Discord Real-Time Voice Assistant
 * 
 * Thin voice I/O layer: Discord mic → Whisper STT → Clawdbot Gateway → TTS → Discord speaker
 * Same agent, same session, same tools as text chat. Voice is just another input method.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { createWriteStream, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transcribeAudio } from './stt.js';
import { generateResponse, generateResponseStreaming, trimForVoice } from './brain.js';
import { synthesizeSpeech, splitIntoSentences } from './tts.js';
import { OpusDecoder } from './opus-decoder.js';
import { checkWakeWord, markBotResponse, WAKE_WORD_ENABLED } from './wakeword.js';
import { queueAlert, hasPendingAlerts, getPendingAlerts, clearAlerts } from './alert-queue.js';
// import { startAlertWebhook, initAlertWebhook, setCurrentVoiceChannelId } from './alert-webhook.js';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// Config
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const TEXT_CHANNEL_ID = process.env.DISCORD_TEXT_CHANNEL_ID;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim());

// Conversation history per user (local backup — gateway session is primary)
const conversations = new Map(); // userId -> { history: [], lastActive: timestamp }
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // Prune inactive conversations after 30 min

function pruneConversations() {
  const now = Date.now();
  for (const [userId, conv] of conversations) {
    if (now - (conv.lastActive || 0) > CONVERSATION_TTL_MS) {
      conversations.delete(userId);
    }
  }
}
// Run pruning every 5 minutes
setInterval(pruneConversations, 5 * 60 * 1000);

// Voice activity tracking
const userSpeaking = new Map();
const SILENCE_THRESHOLD_MS = 1000;
const MIN_AUDIO_DURATION_MS = 300;

// Audio player
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});
// Listener cleanup in playAudio/finish() prevents accumulation — modest limit is safe
player.setMaxListeners(20);

let isSpeaking = false;
let currentConnection = null;
let currentVoiceChannelId = null;
const bargeInEvents = new Set();
const bargeInTimers = new Map(); // Module-scope so reconnects can clear old timers
let pendingAlertBriefingForUser = null;

// Async task management — concurrent background brain calls
const activeTasks = new Map(); // taskId -> { controller, transcript, startTime }
let taskIdCounter = 0;

// Interrupt/stop command detection
const INTERRUPT_PATTERNS = [
  /^(mandy\s*[,.]?\s*)?(stop|cancel|abort|shut up|be quiet|enough|nevermind|never mind|hold on|wait)\.?$/i,
  /^(mandy\s*[,.]?\s*)?(stop|cancel)\s+(that|it|talking|speaking|please|now)\.?$/i,
  /^(mandy\s*[,.]?\s*)?that's\s+(enough|ok|okay|fine)\.?$/i,
];

function isInterruptCommand(transcript) {
  const clean = transcript.trim().replace(/[.,!?;:]+$/g, '');
  return INTERRUPT_PATTERNS.some(p => p.test(clean));
}

// Voice-to-text handoff tracking
let userDisconnected = false;
let lastInteractionTime = 0;
let lastUserMessage = '';
const ACTIVE_CONVERSATION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

// ── Audio Queue (for streaming TTS) ──────────────────────────────────

class AudioQueue {
  constructor() {
    this.queue = [];
    this.playing = false;
  }
  
  add(audioSource, metadata = {}) {
    this.queue.push({ audioSource, metadata });
    if (!this.playing) this.playNext();
  }
  
  clear() {
    this.queue = [];
    if (this.playing) {
      player.stop(true);
      this.playing = false;
    }
  }
  
  async playNext() {
    if (this.queue.length === 0) {
      this.playing = false;
      isSpeaking = false;
      return;
    }
    this.playing = true;
    isSpeaking = true;
    const { audioSource } = this.queue.shift();
    try { await playAudio(audioSource); } catch (err) { console.error('Queue playback error:', err.message); }
    // Clean up TTS temp file after playback
    try { unlinkSync(audioSource); } catch {}
    setImmediate(() => this.playNext());
  }
}

const audioQueue = new AudioQueue();

// ── Alert Briefing ───────────────────────────────────────────────────

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours > 1 ? 's' : ''} ago`;
}

async function briefPendingAlerts(userId) {
  const alerts = getPendingAlerts();
  if (alerts.length === 0) return;
  
  let briefing = 'Welcome back. ';
  if (alerts.length === 1) {
    const alert = alerts[0];
    briefing += `${alert.priority === 'urgent' ? 'Urgent alert' : 'Alert'} from ${getTimeAgo(alert.timestamp)}: ${alert.message}. Want the rundown?`;
  } else {
    briefing += `You have ${alerts.length} alerts. `;
    const urgentCount = alerts.filter(a => a.priority === 'urgent').length;
    if (urgentCount > 0) briefing += `${urgentCount} urgent. `;
    briefing += 'Want the briefing?';
  }
  
  const audio = await synthesizeSpeech(briefing);
  if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
  markBotResponse(userId);
  
  // Inject alert context into conversation history so gateway agent can handle follow-ups
  if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
  const conv = conversations.get(userId);
  conv.lastActive = Date.now();
  
  // Build detailed alert context for the agent
  let alertContext = `[SYSTEM] The following alerts were queued while user was away and just briefed via TTS:\n`;
  for (const alert of alerts) {
    alertContext += `- [${alert.priority}] ${getTimeAgo(alert.timestamp)}: ${alert.message}`;
    if (alert.fullDetails) alertContext += ` | Details: ${alert.fullDetails}`;
    if (alert.source) alertContext += ` (source: ${alert.source})`;
    alertContext += '\n';
  }
  alertContext += `User was told: "${briefing}"\nIf they ask for details, provide the full alert information above.`;
  
  conv.history.push({ role: 'assistant', content: alertContext });
  while (conv.history.length > 40) conv.history.shift();
  
  clearAlerts();
}

function scheduleBriefingOnPause(userId) {
  pendingAlertBriefingForUser = userId;
}

// ── Dynamic Greeting ─────────────────────────────────────────────────

async function generateDynamicGreeting() {
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  
  const prompt = `You are Mandy, a friendly AI voice assistant. Generate ONE short greeting (under 15 words) for ${timeOfDay}. Warm and concise. No quotes, just the text.`;
  
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0.9,
      }),
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content?.trim() || 'Welcome back, sir.').replace(/^["']|["']$/g, '');
  } catch {
    return 'Welcome back, sir.';
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log(`🤖 Mandy Voice Bot online as ${client.user.tag}`);
  console.log(`📡 Guild: ${GUILD_ID} | Voice: ${VOICE_CHANNEL_ID}`);
  
  // initAlertWebhook(client, GUILD_ID, ALLOWED_USERS, scheduleBriefingOnPause);
  // startAlertWebhook();
  
  try {
    await joinChannel(VOICE_CHANNEL_ID, { greeting: true });
    console.log('✅ Joined voice channel');
  } catch (err) {
    console.error('❌ Failed to join voice channel:', err.message);
    process.exit(1);
  }
});

// Detect user joining/leaving voice channel
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.id !== ALLOWED_USERS[0]) return;
  
  // User joined
  if (!oldState.channelId && newState.channelId === currentVoiceChannelId) {
    userDisconnected = false; // Reset disconnect flag on join
    console.log(`👋 User joined voice channel`);
    // Quick "Mandy online" on join — no waiting for AI-generated greeting
    setTimeout(async () => {
      try {
        const audio = await synthesizeSpeech('Mandy online.');
        if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
      } catch {}
      // Brief pending alerts after greeting
      if (hasPendingAlerts()) {
        await briefPendingAlerts(newState.id);
      }
    }, 500);
  }
  
  // User left
  if (oldState.channelId === currentVoiceChannelId && !newState.channelId) {
    console.log(`👋 User left voice channel`);
    userDisconnected = true;
    await handleVoiceDisconnect(newState.id);
  }
});

// ── Voice-to-Text Handoff ────────────────────────────────────────────

async function sendDM(userId, message) {
  try {
    const user = await client.users.fetch(userId);
    console.log(`📤 Sending DM to user ${userId}...`);
    await user.send(message);
    console.log(`✅ DM sent successfully`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send DM: ${err.message}`);
    return false;
  }
}

async function postToTextChannel(message) {
  if (!TEXT_CHANNEL_ID) {
    console.warn('⚠️  No text channel configured, skipping channel post');
    return false;
  }
  
  try {
    const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ Channel ${TEXT_CHANNEL_ID} not found in cache`);
      return false;
    }
    
    console.log(`📤 Posting to ${channel.name} (${TEXT_CHANNEL_ID})...`);
    await channel.send(message);
    console.log(`✅ Posted to ${channel.name} successfully`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to post to channel: ${err.message}`);
    return false;
  }
}

async function handleVoiceDisconnect(userId) {
  const timeSinceLastInteraction = Date.now() - lastInteractionTime;
  const wasRecentlyActive = timeSinceLastInteraction < ACTIVE_CONVERSATION_WINDOW_MS;
  
  // Handle in-flight tasks — they'll detect userDisconnected and post to text
  if (activeTasks.size > 0) {
    console.log(`📤 ${activeTasks.size} tasks in flight — will handoff to text channel when ready`);
    return;
  }
  
  // Handle recent conversation handoff
  if (wasRecentlyActive && lastUserMessage) {
    console.log(`📤 Active conversation detected — posting handoff note to text channel`);
    const handoffMsg = `🎙️ Voice session ended. Last topic: "${lastUserMessage}". Continuing in text.`;
    await postToTextChannel(handoffMsg);
    return;
  }
  
  // Idle disconnect — silent exit
  console.log(`🔇 Idle disconnect (${Math.round(timeSinceLastInteraction / 1000)}s since last interaction) — no handoff`);
}

async function joinChannel(voiceChannelId, options = {}) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error(`Guild ${GUILD_ID} not found`);
  const channel = guild.channels.cache.get(voiceChannelId);
  if (!channel) throw new Error(`Voice channel ${voiceChannelId} not found`);
  
  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  connection.subscribe(player);
  currentConnection = connection;
  currentVoiceChannelId = voiceChannelId;
  // setCurrentVoiceChannelId(voiceChannelId); // Disabled - webhook feature
  
  // Reconnect on disconnect — named handler + once() to prevent listener accumulation
  const handleDisconnect = async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Re-attach disconnect handler after successful reconnect
      connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
    } catch {
      connection.destroy();
      console.log('⚠️  Disconnected, rejoining...');
      setTimeout(() => joinChannel(voiceChannelId), 5000);
    }
  };
  connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
  
  // Listen to incoming audio
  const receiver = connection.receiver;
  // Clear any stale barge-in timers from previous connection
  for (const [uid, timer] of bargeInTimers) { clearTimeout(timer); }
  bargeInTimers.clear();
  const BARGE_IN_THRESHOLD_MS = 600;
  
  receiver.speaking.on('end', (userId) => {
    if (bargeInTimers.has(userId)) {
      clearTimeout(bargeInTimers.get(userId));
      bargeInTimers.delete(userId);
    }
  });
  
  receiver.speaking.on('start', (userId) => {
    if (!ALLOWED_USERS.includes(userId)) {
      console.log(`🔇 Ignored speech from non-allowed user: ${userId}`);
      return;
    }
    console.log(`🎤 Speaking start: ${userId} (isSpeaking=${isSpeaking}, userSpeaking=${userSpeaking.has(userId)})`);

    // Barge-in detection
    if (isSpeaking) {
      if (!bargeInTimers.has(userId)) {
        const timer = setTimeout(() => {
          if (isSpeaking) {
            console.log(`⚡ Barge-in — stopping playback`);
            bargeInEvents.add(userId);
            player.stop(true);
            audioQueue.clear();
            isSpeaking = false;
          }
          bargeInTimers.delete(userId);
        }, BARGE_IN_THRESHOLD_MS);
        bargeInTimers.set(userId, timer);
      }
    }
    
    // Collect audio
    if (!userSpeaking.has(userId)) {
      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_THRESHOLD_MS },
      });
      
      const chunks = [];
      const decoder = new OpusDecoder();
      audioStream.pipe(decoder);
      
      decoder.on('data', (chunk) => chunks.push(chunk));
      
      // Clean up userSpeaking on error so future audio isn't blocked
      audioStream.once('error', (err) => {
        console.error(`Audio stream error for ${userId}:`, err.message);
        userSpeaking.delete(userId);
        decoder.destroy();
      });
      
      decoder.once('error', () => {}); // Suppress unhandled error on destroy
      
      audioStream.once('end', async () => {
        userSpeaking.delete(userId);
        const totalBuffer = Buffer.concat(chunks);
        const durationMs = (totalBuffer.length / (48000 * 2)) * 1000;

        if (durationMs < MIN_AUDIO_DURATION_MS) {
          console.log(`🔇 Audio too short: ${Math.round(durationMs)}ms < ${MIN_AUDIO_DURATION_MS}ms`);
          return;
        }

        // Energy filter — reject background noise / silence before hitting STT APIs
        const rms = computeRMS(totalBuffer);
        if (rms < 500) {
          console.log(`🔇 Audio too quiet: RMS=${Math.round(rms)} < 500`);
          return;
        }
        console.log(`🎙️ Audio accepted: ${Math.round(durationMs)}ms, RMS=${Math.round(rms)}`);

        // Downsample 48kHz → 16kHz for faster STT processing
        const downsampled = downsample48to16(totalBuffer);

        // Fully async — every utterance goes straight to handleSpeech
        // No blocking, no queueing. Multiple brain calls run concurrently.
        await handleSpeech(userId, downsampled);
      });
      
      userSpeaking.set(userId, { startTime: Date.now() });
    }
  });
  
  if (options.greeting) await playGreeting();
  return connection;
}

async function playGreeting() {
  try {
    const audio = await synthesizeSpeech('Mandy online. Voice channel is live.');
    if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
  } catch (err) {
    console.error('Greeting failed:', err.message);
  }
}

// ── Speech Processing Pipeline (Async — non-blocking) ────────────────
//
// Flow: User speaks → transcribe → dispatch background task → immediately ready
//       Background task completes → queue response → TTS when speaker is free
//
// Quick commands (focus, wake word only, alerts) are handled synchronously.
// Brain calls are fully async — multiple can run concurrently.

async function handleSpeech(userId, audioBuffer, preTranscribed = null) {
  const startTime = Date.now();
  let wavPath = null;
  
  try {
    // 1. Transcribe (skip if already transcribed during queue)
    let rawTranscript;
    if (preTranscribed) {
      rawTranscript = preTranscribed;
      console.log(`📝 (pre-transcribed) "${rawTranscript}"`);
    } else {
      wavPath = join(TMP_DIR, `speech_${userId}_${Date.now()}.wav`);
      await savePcmAsWav(audioBuffer, wavPath);
      rawTranscript = await transcribeAudio(wavPath);
      try { unlinkSync(wavPath); } catch {}
      wavPath = null; // Cleaned up successfully
    }
    
    if (!rawTranscript || rawTranscript.trim().length === 0) return;
    console.log(`📝 "${rawTranscript}" (${Date.now() - startTime}ms)`);
    
    // 2. Wake word check
    const { detected, cleanedTranscript } = checkWakeWord(rawTranscript, userId);
    if (!detected) return;
    
    const transcript = cleanedTranscript;
    
    // Track interaction for handoff detection
    lastInteractionTime = Date.now();
    lastUserMessage = transcript.substring(0, 100);
    
    // ── Interrupt/stop detection (cancels all active tasks) ──
    // This MUST stay local — it needs to kill in-flight audio/tasks immediately
    if (isInterruptCommand(rawTranscript)) {
      console.log(`⛔ Interrupt command: "${rawTranscript}"`);
      cancelAllTasks();
      const stopAudio = await synthesizeSpeech('Stopped.');
      if (stopAudio) { await playAudio(stopAudio); try { unlinkSync(stopAudio); } catch {} }
      return;
    }
    
    // Wake word only (no actual question) — local chime, no gateway round-trip
    const trimmed = transcript.trim().replace(/[.,!?]/g, '');
    if (!trimmed || trimmed.length < 2) {
      markBotResponse(userId);
      const chime = await synthesizeSpeech('Yes?');
      if (chime) { playAudio(chime).then(() => { try { unlinkSync(chime); } catch {} }).catch(() => {}); }
      return;
    }
    
    // ── Background brain call (async — non-blocking) ──
    
    if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
    const conv = conversations.get(userId);
    conv.lastActive = Date.now();
    
    // Add user message to history immediately
    conv.history.push({ role: 'user', content: transcript });
    while (conv.history.length > 40) conv.history.shift();
    
    // Dispatch background task
    const taskId = ++taskIdCounter;
    const controller = new AbortController();
    activeTasks.set(taskId, { controller, transcript, startTime, userId });
    
    console.log(`🚀 Task #${taskId} dispatched: "${transcript.substring(0, 60)}..." (${activeTasks.size} active)`);
    
    // Acknowledge with a brief confirmation so user knows we heard them
    if (activeTasks.size > 1) {
      const ackAudio = await synthesizeSpeech('On it.');
      if (ackAudio) { audioQueue.add(ackAudio); }
    }
    
    // Fire and forget — brain call runs in background
    processBrainTask(taskId, userId, transcript, [...conv.history], controller.signal)
      .catch(err => console.error(`Task #${taskId} error:`, err.message));
    
  } catch (err) {
    console.error('❌ Speech dispatch error:', err);
  } finally {
    // Clean up WAV file if it wasn't already deleted
    if (wavPath) { try { unlinkSync(wavPath); } catch {} }
  }
}

/**
 * Background brain task — runs concurrently, queues result for TTS
 */
async function processBrainTask(taskId, userId, transcript, history, signal) {
  const startTime = Date.now();
  let firstAudioLogged = false;
  let fullResponse = '';
  
  try {
    console.log(`🧠 Task #${taskId} thinking...`);
    
    // Stream response — TTS each sentence as it arrives
    const result = await generateResponseStreaming(transcript, history, signal, async (sentence) => {
      // Final safety strip — catch any tags that survived the stream buffer
      sentence = trimForVoice(sentence);
      if (!sentence || sentence.length < 2) return;
      
      fullResponse += sentence + ' ';
      
      if (!firstAudioLogged) {
        firstAudioLogged = true;
        console.log(`⏱️  Task #${taskId} first sentence: ${Date.now() - startTime}ms`);
      }
      
      // TTS and queue immediately — don't wait
      if (userDisconnected) {
        await postToTextChannel(`🎙️ ${sentence}`);
        return;
      }
      
      try {
        const audio = await synthesizeSpeech(sentence);
        if (audio) {
          audioQueue.add(audio);
        }
      } catch (err) {
        console.error(`TTS failed for sentence:`, err.message);
      }
    });
    
    // Task was cancelled
    if (result.aborted) {
      console.log(`🛑 Task #${taskId} aborted`);
      return;
    }
    
    console.log(`💬 Task #${taskId} done (${Date.now() - startTime}ms): "${(fullResponse || '').substring(0, 80)}..."`);
    
    // Update conversation history with full response
    const conv = conversations.get(userId);
    if (conv) {
      conv.history.push({ role: 'assistant', content: result.text || fullResponse || '' });
      while (conv.history.length > 40) conv.history.shift();
    }
    
    markBotResponse(userId);
    
    // Brief pending alerts on natural pause
    if (pendingAlertBriefingForUser && hasPendingAlerts() && activeTasks.size === 0) {
      const uid = pendingAlertBriefingForUser;
      pendingAlertBriefingForUser = null;
      setImmediate(() => briefPendingAlerts(uid));
    }
    
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(`❌ Task #${taskId} failed:`, err.message);
      try {
        const audio = await synthesizeSpeech("I had trouble with that one. Try again?");
        if (audio) audioQueue.add(audio);
      } catch {}
    }
  } finally {
    // Guarantee task cleanup regardless of success/failure/abort
    activeTasks.delete(taskId);
  }
}

/**
 * Cancel all active background tasks
 */
function cancelAllTasks() {
  const count = activeTasks.size;
  for (const [taskId, task] of activeTasks) {
    task.controller.abort();
    console.log(`🛑 Cancelled task #${taskId}`);
  }
  activeTasks.clear();
  audioQueue.clear();
  isSpeaking = false;
  console.log(`🛑 Cancelled ${count} active tasks, cleared all queues`);
}

// ── Audio Playback ───────────────────────────────────────────────────

async function playAudio(audioPath) {
  isSpeaking = true;
  const playStart = Date.now();
  
  const { createReadStream: crs, statSync: fstatSync } = await import('fs');
  // Use statSync for file size instead of reading entire file into memory
  const fileStat = fstatSync(audioPath);
  const estimatedDurationMs = Math.max(2000, (fileStat.size / 1024 / 5) * 1000);
  
  const resource = createAudioResource(crs(audioPath), { inlineVolume: true });
  resource.volume.setVolume(1.0);
  player.play(resource);
  
  return new Promise((resolve) => {
    let resolved = false;
    let onIdle, onError, timeoutId, checkInterval;
    
    const finish = (reason) => {
      if (resolved) return;
      resolved = true;
      // Remove ALL listeners we attached — prevents accumulation
      player.removeListener(AudioPlayerStatus.Idle, onIdle);
      player.removeListener('error', onError);
      if (timeoutId) clearTimeout(timeoutId);
      if (checkInterval) clearInterval(checkInterval);
      isSpeaking = false;
      resolve();
    };
    
    onIdle = () => {
      const elapsed = Date.now() - playStart;
      const minExpected = Math.min(estimatedDurationMs * 0.5, 3000);
      if (elapsed < minExpected) {
        if (bargeInEvents.size > 0) {
          bargeInEvents.clear();
        } else {
          player.once(AudioPlayerStatus.Idle, onIdle);
          return;
        }
      } else {
        bargeInEvents.clear();
      }
      finish('idle');
    };
    
    player.once(AudioPlayerStatus.Idle, onIdle);
    onError = () => finish('error');
    player.once('error', onError);
    
    // Cap timeout at 60s instead of 600s to prevent long-lived intervals
    timeoutId = setTimeout(() => finish('timeout'), Math.min(estimatedDurationMs * 2, 60000));
    checkInterval = setInterval(() => {
      if (Date.now() - playStart >= estimatedDurationMs && player.state.status === AudioPlayerStatus.Idle) {
        finish('idle-polled');
      }
    }, 500);
  });
}

// ── WAV Helper ───────────────────────────────────────────────────────

/**
 * Compute RMS energy of 16-bit PCM audio
 */
function computeRMS(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Downsample 48kHz 16-bit mono PCM to 16kHz by averaging every 3 samples
 */
function downsample48to16(pcmBuffer) {
  const ratio = 3;
  const inputSamples = pcmBuffer.length / 2;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    let sum = 0;
    for (let j = 0; j < ratio; j++) {
      sum += pcmBuffer.readInt16LE((i * ratio + j) * 2);
    }
    output.writeInt16LE(Math.round(sum / ratio), i * 2);
  }
  return output;
}

function savePcmAsWav(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const sampleRate = 16000, numChannels = 1, bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    
    const ws = createWriteStream(outputPath);
    ws.write(header);
    ws.end(pcmBuffer);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

// ── Graceful Shutdown ────────────────────────────────────────────────

process.on('SIGINT', () => {
  cancelAllTasks();
  if (currentConnection) currentConnection.destroy();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cancelAllTasks();
  if (currentConnection) currentConnection.destroy();
  client.destroy();
  process.exit(0);
});

// ── Start ────────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN required. See .env.example');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
