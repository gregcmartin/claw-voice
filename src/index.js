/**
 * Jarvis Voice Bot - Discord Real-Time Voice Assistant
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
import { createWriteStream, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transcribeAudio } from './stt.js';
import { generateResponse } from './brain.js';
import { synthesizeSpeech, splitIntoSentences } from './tts.js';
import { OpusDecoder } from './opus-decoder.js';
import { checkWakeWord, markBotResponse, WAKE_WORD_ENABLED } from './wakeword.js';
import { queueAlert, hasPendingAlerts, getPendingAlerts, clearAlerts } from './alert-queue.js';
import { startAlertWebhook, initAlertWebhook, setCurrentVoiceChannelId } from './alert-webhook.js';

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
const conversations = new Map(); // userId -> { history: [] }

// Voice activity tracking
const userSpeaking = new Map();
const SILENCE_THRESHOLD_MS = 1000;
const MIN_AUDIO_DURATION_MS = 300;

// Audio player
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});
player.setMaxListeners(50);

let isSpeaking = false;
let currentConnection = null;
let currentVoiceChannelId = null;
const bargeInEvents = new Set();
let pendingAlertBriefingForUser = null;

// Async task management — concurrent background brain calls
const activeTasks = new Map(); // taskId -> { controller, transcript, startTime }
let taskIdCounter = 0;

// Interrupt/stop command detection
const INTERRUPT_PATTERNS = [
  /^(jarvis\s*[,.]?\s*)?(stop|cancel|abort|shut up|be quiet|enough|nevermind|never mind|hold on|wait)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?(stop|cancel)\s+(that|it|talking|speaking|please|now)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?that's\s+(enough|ok|okay|fine)\.?$/i,
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

// Dynamic handoff channel — set via "focus #channel-name" voice command
let activeHandoffChannelId = null;

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
  
  if (!conversations.has(userId)) conversations.set(userId, { history: [] });
  conversations.get(userId).pendingAlertBriefing = alerts;
}

function scheduleBriefingOnPause(userId) {
  pendingAlertBriefingForUser = userId;
}

// ── Dynamic Greeting ─────────────────────────────────────────────────

async function generateDynamicGreeting() {
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  
  const prompt = `You are Jarvis, a British AI butler. Generate ONE short greeting (under 15 words) for ${timeOfDay}. Dry wit welcome. No quotes, just the text.`;
  
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

// ── Dynamic Focus Channel ────────────────────────────────────────────

function findChannelByName(guild, name) {
  const cleanName = name.replace(/^#/, '').toLowerCase().trim();
  const channel = guild.channels.cache.find(ch =>
    ch.name.toLowerCase() === cleanName && ch.isTextBased() && !ch.isVoiceBased()
  );
  return channel || null;
}

// Focus command patterns — tolerant of Whisper punctuation (commas, periods, etc.)
const FOCUS_PATTERN = /(?:focus\s+(?:on|in)|focus|work\s+(?:in|on|from)|switch\s+to|post\s+(?:in|to))[,.:;!?\s]+#?([a-z0-9_-]+(?:[\s-]+[a-z0-9_-]+)*)/i;
const CLEAR_FOCUS_PATTERN = /(?:clear\s+focus|default\s+channel|reset\s+channel|unfocus)/i;

function parseFocusCommand(transcript) {
  // Strip trailing punctuation for cleaner matching
  const clean = transcript.replace(/[.,!?;:]+$/g, '').trim();
  if (CLEAR_FOCUS_PATTERN.test(clean)) return { action: 'clear' };
  const match = clean.match(FOCUS_PATTERN);
  if (match) return { action: 'focus', channelName: match[1].replace(/[.,!?;:]/g, '').replace(/\s+/g, '-').trim() };
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log(`🤖 Jarvis Voice Bot online as ${client.user.tag}`);
  console.log(`📡 Guild: ${GUILD_ID} | Voice: ${VOICE_CHANNEL_ID}`);
  
  initAlertWebhook(client, GUILD_ID, ALLOWED_USERS, scheduleBriefingOnPause);
  startAlertWebhook();
  
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
    activeHandoffChannelId = null; // Reset focus on new session
    console.log(`👋 User joined voice channel`);
    setTimeout(async () => {
      if (hasPendingAlerts()) {
        await briefPendingAlerts(newState.id);
      } else {
        try {
          const greeting = await generateDynamicGreeting();
          const audio = await synthesizeSpeech(greeting);
          if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
        } catch {}
      }
    }, 2000);
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
  const targetChannelId = activeHandoffChannelId || TEXT_CHANNEL_ID;
  
  if (!targetChannelId) {
    console.warn('⚠️  No handoff channel configured, skipping channel post');
    return false;
  }
  
  try {
    const channel = client.channels.cache.get(targetChannelId);
    if (!channel) {
      console.error(`❌ Channel ${targetChannelId} not found in cache`);
      // Fall back to default if dynamic channel fails
      if (activeHandoffChannelId && TEXT_CHANNEL_ID) {
        console.log(`↩️  Falling back to default channel ${TEXT_CHANNEL_ID}`);
        const fallback = client.channels.cache.get(TEXT_CHANNEL_ID);
        if (fallback) { await fallback.send(message); return true; }
      }
      return false;
    }
    
    console.log(`📤 Posting to ${channel.name} (${targetChannelId})${activeHandoffChannelId ? ' [focused]' : ''}...`);
    await channel.send(message);
    console.log(`✅ Posted to ${channel.name} successfully`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to post to channel: ${err.message}`);
    console.error(`   Error code: ${err.code}, HTTP status: ${err.httpStatus}`);
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
  setCurrentVoiceChannelId(voiceChannelId);
  
  // Reconnect on disconnect
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      console.log('⚠️  Disconnected, rejoining...');
      setTimeout(() => joinChannel(voiceChannelId), 5000);
    }
  });
  
  // Listen to incoming audio
  const receiver = connection.receiver;
  const bargeInTimers = new Map();
  const BARGE_IN_THRESHOLD_MS = 600;
  
  receiver.speaking.on('end', (userId) => {
    if (bargeInTimers.has(userId)) {
      clearTimeout(bargeInTimers.get(userId));
      bargeInTimers.delete(userId);
    }
  });
  
  receiver.speaking.on('start', (userId) => {
    if (!ALLOWED_USERS.includes(userId)) return;
    
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
      
      audioStream.once('end', async () => {
        userSpeaking.delete(userId);
        const totalBuffer = Buffer.concat(chunks);
        const durationMs = (totalBuffer.length / (48000 * 2)) * 1000;
        
        if (durationMs < MIN_AUDIO_DURATION_MS) return;
        
        // Fully async — every utterance goes straight to handleSpeech
        // No blocking, no queueing. Multiple brain calls run concurrently.
        await handleSpeech(userId, totalBuffer);
      });
      
      userSpeaking.set(userId, { startTime: Date.now() });
    }
  });
  
  if (options.greeting) await playGreeting();
  return connection;
}

async function playGreeting() {
  try {
    const audio = await synthesizeSpeech('Jarvis online. Voice channel is live.');
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
  
  try {
    // 1. Transcribe (skip if already transcribed during queue)
    let rawTranscript;
    if (preTranscribed) {
      rawTranscript = preTranscribed;
      console.log(`📝 (pre-transcribed) "${rawTranscript}"`);
    } else {
      const wavPath = join(TMP_DIR, `speech_${userId}_${Date.now()}.wav`);
      await savePcmAsWav(audioBuffer, wavPath);
      rawTranscript = await transcribeAudio(wavPath);
      try { unlinkSync(wavPath); } catch {}
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
    if (isInterruptCommand(rawTranscript)) {
      console.log(`⛔ Interrupt command: "${rawTranscript}"`);
      cancelAllTasks();
      const stopAudio = await synthesizeSpeech('Stopped.');
      if (stopAudio) { await playAudio(stopAudio); try { unlinkSync(stopAudio); } catch {} }
      return;
    }
    
    // ── Quick commands (synchronous — no brain call needed) ──
    
    // Focus command
    const focusCmd = parseFocusCommand(transcript);
    if (focusCmd) {
      markBotResponse(userId);
      if (focusCmd.action === 'clear') {
        activeHandoffChannelId = null;
        console.log('🎯 Focus cleared — back to default channel');
        const audio = await synthesizeSpeech('Back to default channel.');
        if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
      } else {
        const guild = client.guilds.cache.get(GUILD_ID);
        const channel = guild ? findChannelByName(guild, focusCmd.channelName) : null;
        if (channel) {
          activeHandoffChannelId = channel.id;
          console.log(`🎯 Focus set to #${channel.name} (${channel.id})`);
          const audio = await synthesizeSpeech(`Focused on ${channel.name}. If you disconnect, I'll post there.`);
          if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
        } else {
          const audio = await synthesizeSpeech(`I couldn't find a channel named ${focusCmd.channelName}.`);
          if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
        }
      }
      return;
    }
    
    // Wake word only (no actual question)
    const trimmed = transcript.trim().replace(/[.,!?]/g, '');
    if (!trimmed || trimmed.length < 2) {
      markBotResponse(userId);
      const chime = await synthesizeSpeech('Yes?');
      if (chime) { playAudio(chime).then(() => { try { unlinkSync(chime); } catch {} }).catch(() => {}); }
      return;
    }
    
    // Alert briefing follow-up
    let conv = conversations.get(userId);
    if (conv?.pendingAlertBriefing && transcript.match(/(yes|yeah|yep|sure|okay|ok|tell me|give me|run down|rundown|briefing|details)/i)) {
      markBotResponse(userId);
      const alerts = conv.pendingAlertBriefing;
      let details = '';
      for (let i = 0; i < alerts.length; i++) {
        if (alerts.length > 1) details += `Alert ${i + 1}. `;
        details += (alerts[i].fullDetails || alerts[i].message) + '. ';
      }
      const audio = await synthesizeSpeech(details);
      if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
      clearAlerts();
      delete conv.pendingAlertBriefing;
      return;
    }
    
    // ── Background brain call (async — non-blocking) ──
    
    if (!conversations.has(userId)) conversations.set(userId, { history: [] });
    conv = conversations.get(userId);
    
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
  }
}

/**
 * Background brain task — runs concurrently, queues result for TTS
 */
async function processBrainTask(taskId, userId, transcript, history, signal) {
  const startTime = Date.now();
  
  try {
    console.log(`🧠 Task #${taskId} thinking...`);
    const result = await generateResponse(transcript, history, signal);
    
    // Task was cancelled
    if (result.aborted) {
      console.log(`🛑 Task #${taskId} aborted`);
      activeTasks.delete(taskId);
      return;
    }
    
    const response = result.text;
    console.log(`💬 Task #${taskId} done (${Date.now() - startTime}ms): "${(response || '').substring(0, 80)}..."`);
    
    // Update conversation history with response
    const conv = conversations.get(userId);
    if (conv) {
      conv.history.push({ role: 'assistant', content: response || '' });
      while (conv.history.length > 40) conv.history.shift();
    }
    
    // Remove from active tasks
    activeTasks.delete(taskId);
    
    // Handle disconnect — post to text instead
    if (userDisconnected) {
      console.log(`📤 Task #${taskId} — user disconnected, posting to text`);
      if (response) {
        await postToTextChannel(`🎙️ **Voice handoff:**\n${response}`);
      }
      markBotResponse(userId);
      return;
    }
    
    // Speak response immediately — feed sentences directly into audio queue
    // No waiting for other tasks. First to finish, first to speak.
    if (response) {
      await speakResponse(taskId, userId, response, startTime);
    }
    
    markBotResponse(userId);
    
  } catch (err) {
    activeTasks.delete(taskId);
    if (err.name !== 'AbortError') {
      console.error(`❌ Task #${taskId} failed:`, err.message);
      await speakResponse(taskId, userId, "I had trouble with that one. Try again?", Date.now());
    }
  }
}

/**
 * Speak a response immediately — feeds sentences into the shared audio queue.
 * Multiple tasks can call this concurrently; the audio queue handles ordering.
 * Each response gets a brief pause before it to separate from prior audio.
 */
async function speakResponse(taskId, userId, response, startTime) {
  if (userDisconnected) {
    await postToTextChannel(`🎙️ **Voice handoff:**\n${response}`);
    return;
  }
  
  const sentences = splitIntoSentences(response);
  
  for (let i = 0; i < sentences.length; i++) {
    if (userDisconnected) {
      const remaining = sentences.slice(i).join(' ');
      await postToTextChannel(`🎙️ **Voice handoff:**\n${remaining}`);
      break;
    }
    try {
      const audio = await synthesizeSpeech(sentences[i]);
      if (audio) {
        if (i === 0) console.log(`⏱️  Task #${taskId} first audio: ${Date.now() - startTime}ms`);
        audioQueue.add(audio);
      }
    } catch (err) {
      console.error(`TTS sentence ${i + 1} failed:`, err.message);
    }
  }
  
  // Brief pending alerts on natural pause
  if (pendingAlertBriefingForUser && hasPendingAlerts() && activeTasks.size === 0) {
    const uid = pendingAlertBriefingForUser;
    pendingAlertBriefingForUser = null;
    setImmediate(() => briefPendingAlerts(uid));
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
  
  const { createReadStream: crs } = await import('fs');
  const fileBuffer = readFileSync(audioPath);
  const estimatedDurationMs = Math.max(2000, (fileBuffer.length / 1024 / 5) * 1000);
  
  const resource = createAudioResource(crs(audioPath), { inlineVolume: true });
  resource.volume.setVolume(1.0);
  player.play(resource);
  
  return new Promise((resolve) => {
    let resolved = false;
    let onIdle, onError, timeoutId, checkInterval;
    
    const finish = (reason) => {
      if (resolved) return;
      resolved = true;
      if (onIdle) player.off(AudioPlayerStatus.Idle, onIdle);
      if (onError) player.off('error', onError);
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
    
    timeoutId = setTimeout(() => finish('timeout'), Math.min(estimatedDurationMs * 2, 600000));
    checkInterval = setInterval(() => {
      if (Date.now() - playStart >= estimatedDurationMs && player.state.status === AudioPlayerStatus.Idle) {
        finish('idle-polled');
      }
    }, 500);
  });
}

// ── WAV Helper ───────────────────────────────────────────────────────

function savePcmAsWav(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const sampleRate = 48000, numChannels = 1, bitsPerSample = 16;
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
