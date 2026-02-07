/**
 * Jarvis Voice Bot - Discord Real-Time Voice Assistant
 * 
 * Joins a Discord voice channel and has real-time conversations
 * using Whisper (STT) → Claude (Brain) → OpenAI TTS (Voice)
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
import { pipeline } from 'stream/promises';
import { createWriteStream, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transcribeAudio } from './stt.js';
import { generateResponse, detectOutputCommand, sendCrossChannelOutput } from './brain.js';
import { synthesizeSpeech, synthesizeSpeechStream, splitIntoSentences, STREAMING_TTS_ENABLED } from './tts.js';
import { OpusDecoder } from './opus-decoder.js';
import { checkWakeWord, markBotResponse, WAKE_WORD_ENABLED } from './wakeword.js';
import { extractAndUpdateState } from './voice-state.js';
// Channel routing disabled - brain handles focus commands naturally
// import { detectChannelCommand, resolveChannel, loadDirective, moveToVoiceChannel } from './channel-router.js';
import { shouldDelegate, spawnBackgroundAgent, pollAgentCompletion, extractTLDR } from './agent-delegate.js';
import { classifyIntent } from './intent-classifier.js';
import { queueAlert, hasPendingAlerts, getPendingAlerts, clearAlerts } from './alert-queue.js';
import { startAlertWebhook, initAlertWebhook, setCurrentVoiceChannelId } from './alert-webhook.js';

const HEARTBEAT_ENABLED = process.env.HEARTBEAT_ENABLED === 'true';
const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// Channel registry and active context state
let channelRegistry = null;
let activeContext = null; // { channelId, channelName, directive, directivePath, voiceChannelId }
let currentVoiceChannelId = null; // Track which voice channel we're in

// Config
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim());

// Conversation history per user with depth tracking
const conversations = new Map(); // userId -> { history: [], depth: 0, lastResponseType: null }

// Voice activity tracking
const userSpeaking = new Map(); // userId -> { chunks: Buffer[], lastActivity: number }
const SILENCE_THRESHOLD_MS = 1000; // 1s of silence = end of speech
const MIN_AUDIO_DURATION_MS = 300; // Minimum audio to process (ignore short blips)

// Audio player
const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});

// Increase max listeners to handle streaming queue (10+ segments)
player.setMaxListeners(50);

let isSpeaking = false; // Is the bot currently speaking?
let isProcessing = false; // Is a speech pipeline currently running?
let speechQueue = []; // Queue for speech received during processing
let currentConnection = null;
const bargeInEvents = new Set(); // Track which userIds triggered barge-in (module scope)
let pendingAlertBriefingForUser = null; // Set by webhook when alert arrives while user is in voice

// Audio queue for streaming TTS
class AudioQueue {
  constructor() {
    this.queue = [];
    this.playing = false;
  }
  
  add(audioSource, metadata = {}) {
    this.queue.push({ audioSource, metadata });
    if (!this.playing) {
      this.playNext();
    }
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
    
    const { audioSource, metadata } = this.queue.shift();
    console.log(`🔊 Playing queued segment ${metadata.index || 0}/${metadata.total || '?'}`);
    
    try {
      await playAudio(audioSource);
    } catch (err) {
      console.error('Queue playback error:', err.message);
    }
    
    // Play next segment
    setImmediate(() => this.playNext());
  }
}

const audioQueue = new AudioQueue();

// Jarvis-style acks — contextual, with estimated time
// Returns { ack: string, estimatedTimeSeconds: number }
function getQuickAck(transcript) {
  const lower = transcript.toLowerCase();
  
  // Greetings — no ack, fast response expected
  if (lower.match(/^(hello|hey|hi|good morning|good evening|yo|sup)/))
    return { ack: '', estimatedTimeSeconds: 2 };
  
  // Thanks — no ack, fast
  if (lower.match(/^(thanks|thank you|cheers|appreciated)/))
    return { ack: '', estimatedTimeSeconds: 2 };
  
  // Short/simple questions — no ack needed, response will be fast
  if (lower.split(' ').length <= 5 && !lower.includes('check') && !lower.includes('search') && !lower.includes('email'))
    return { ack: '', estimatedTimeSeconds: 3 };
  
  // Tasks that will take time — brief contextual ack with time estimate
  if (lower.includes('email') || lower.includes('inbox'))
    return { ack: 'Checking now, sir.', estimatedTimeSeconds: 15 };
  
  if (lower.includes('calendar') || lower.includes('schedule'))
    return { ack: 'One moment, sir.', estimatedTimeSeconds: 10 };
  
  if (lower.includes('search') || lower.includes('find') || lower.includes('look up'))
    return { ack: 'Searching.', estimatedTimeSeconds: 8 };
  
  if (lower.includes('analyze') || lower.includes('review') || lower.includes('check'))
    return { ack: 'On it.', estimatedTimeSeconds: 12 };
  
  if (lower.includes('send') || lower.includes('post') || lower.includes('message'))
    return { ack: 'Right away.', estimatedTimeSeconds: 10 };
  
  if (lower.includes('remind') || lower.includes('reminder'))
    return { ack: 'Noted, sir.', estimatedTimeSeconds: 5 };
  
  if (lower.includes('plan') || lower.includes('break down') || lower.includes('deep dive') || lower.includes('explain'))
    return { ack: 'This will take a moment, sir.', estimatedTimeSeconds: 20 };
  
  // For longer requests — give an ack, assume longer wait
  if (lower.split(' ').length > 10)
    return { ack: 'Working on that now.', estimatedTimeSeconds: 15 };
  
  // Default: no ack, moderate wait expected
  return { ack: '', estimatedTimeSeconds: 8 };
}

// ── Alert Briefing ────────────────────────────────────────────────────

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
  
  // Build briefing message
  let briefing = 'Welcome back. ';
  
  if (alerts.length === 1) {
    const alert = alerts[0];
    const timeAgo = getTimeAgo(alert.timestamp);
    briefing += `${alert.priority === 'urgent' ? 'Urgent alert' : 'Alert'} from ${timeAgo}: ${alert.message}. `;
    briefing += 'Want the rundown?';
  } else {
    briefing += `You have ${alerts.length} alerts. `;
    const urgentCount = alerts.filter(a => a.priority === 'urgent').length;
    if (urgentCount > 0) {
      briefing += `${urgentCount} urgent. `;
    }
    briefing += 'Want the briefing?';
  }
  
  console.log(`📢 Speaking briefing: "${briefing}"`);
  
  // Synthesize and play
  const audio = await synthesizeSpeech(briefing);
  await playAudio(audio);
  try { unlinkSync(audio); } catch {}
  
  // Mark conversation so follow-ups work
  markBotResponse(userId);
  
  // Store alerts in conversation context for follow-up
  if (!conversations.has(userId)) {
    conversations.set(userId, { history: [], depth: 0, lastResponseType: null });
  }
  const conv = conversations.get(userId);
  conv.pendingAlertBriefing = alerts; // Store for follow-up
}

// Callback for when alert arrives while user is already in voice
function scheduleBriefingOnPause(userId) {
  pendingAlertBriefingForUser = userId;
  console.log(`📢 Alert briefing scheduled for ${userId} on next pause`);
}

// Monitor Discord channel for agent completion message
async function monitorAgentCompletion(sessionKey, channelId, timeoutMs = 600000) {
  // 10 minute timeout — real work takes time (code refactors, research, etc.)
  const startTime = Date.now();
  const pollInterval = 15000; // Check every 15 seconds
  const ALLOWED_USER_ID = process.env.ALLOWED_USERS?.split(',')[0];
  
  console.log(`👁️  Monitoring agent ${sessionKey} (timeout: ${timeoutMs / 1000}s)`);
  
  // Strategy 1: Poll the gateway hook session for completion
  // Strategy 2: Watch Discord channel for new bot messages (fallback)
  let lastMessageId = null;
  
  try {
    const channel = client.channels.cache.get(channelId);
    if (channel) {
      const messages = await channel.messages.fetch({ limit: 1 });
      lastMessageId = messages.first()?.id;
    }
  } catch (err) {
    console.error(`⚠️  Failed to get last message ID: ${err.message}`);
  }
  
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    
    try {
      // Strategy 1: Check if hook session completed via gateway API
      const hookRes = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          model: 'clawdbot:main',
          messages: [{ role: 'user', content: 'HEARTBEAT_OK' }],
          max_tokens: 1,
          user: sessionKey.replace('hook:', 'poll:'),
        }),
      }).catch(() => null);
      // We don't actually need the response — just checking if gateway is alive
      
      // Strategy 2: Watch Discord channel for new messages from the bot (Clawdbot)
      const channel = client.channels.cache.get(channelId);
      if (!channel) continue;
      
      const messages = await channel.messages.fetch({ 
        limit: 10,
        after: lastMessageId,
      });
      
      if (messages.size > 0) {
        // Look for any bot message that looks like task output
        // The hook agent posts under Clawdbot's identity, not voice bot's
        const completionMsg = messages.find(m => 
          m.author.bot && 
          (m.content.includes('What was done') || 
           m.content.includes('completed') ||
           m.content.includes('Done.') ||
           m.content.includes('refactor') ||
           m.content.includes('✅') ||
           m.content.includes('Key results') ||
           m.content.length > 200) // Long bot messages are likely task output
        );
        
        if (completionMsg) {
          console.log(`✅ Agent completed after ${elapsed}s`);
          const summary = completionMsg.content.substring(0, 300).split(/[.!?]\s/)[0];
          return summary || 'Task complete';
        }
        
        lastMessageId = messages.first().id;
      }
      
      if (elapsed % 60 === 0) {
        console.log(`👁️  Still monitoring agent... (${elapsed}s elapsed)`);
      }
      
    } catch (err) {
      console.error(`⚠️  Agent monitoring error: ${err.message}`);
    }
  }
  
  // Timeout — notify user anyway
  console.log(`⏱️  Agent monitoring timeout after ${timeoutMs / 1000}s`);
  
  // DM user that we lost track but work may still be in progress
  try {
    const user = await client.users.fetch(ALLOWED_USER_ID);
    await user.send(`⏱️ **Voice Task Update:** Background task timed out on monitoring (${timeoutMs / 1000}s). The work may still be in progress — check the text channel for results.`);
    console.log('📱 Timeout DM sent to user');
  } catch (err) {
    console.error(`⚠️  Timeout DM failed: ${err.message}`);
  }
  
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once('ready', async () => {
  console.log(`🤖 Jarvis Voice Bot online as ${client.user.tag}`);
  console.log(`📡 Guild: ${GUILD_ID}`);
  console.log(`🎙️  Voice Channel: ${VOICE_CHANNEL_ID}`);
  
  // Initialize alert webhook with pause briefing callback
  initAlertWebhook(client, GUILD_ID, ALLOWED_USERS, scheduleBriefingOnPause);
  startAlertWebhook();
  
  // Load channel registry
  try {
    const registryPath = join(__dirname, '..', '..', 'contexts', 'channel-registry.json');
    channelRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
    console.log('📋 Channel registry loaded');
  } catch (err) {
    console.warn('⚠️  Failed to load channel registry:', err.message);
    channelRegistry = { discord: {}, voiceChannels: {} };
  }
  
  // Auto-join the voice channel
  try {
    await joinChannel(VOICE_CHANNEL_ID, { greeting: true });
    console.log('✅ Joined voice channel successfully');
    
    // Check if starting voice channel has a default context
    if (channelRegistry.voiceChannels && channelRegistry.voiceChannels[VOICE_CHANNEL_ID]) {
      const vcData = channelRegistry.voiceChannels[VOICE_CHANNEL_ID];
      if (vcData.defaultContext) {
        console.log(`📍 Voice channel has default context: ${vcData.defaultContext}`);
        // Resolve and load the context
        const resolved = resolveChannel(vcData.defaultContext, channelRegistry);
        if (resolved && resolved.directivePath) {
          const directive = loadDirective(resolved.directivePath);
          if (directive) {
            activeContext = {
              channelId: resolved.channelId,
              channelName: resolved.channelName,
              directive,
              directivePath: resolved.directivePath,
              voiceChannelId: VOICE_CHANNEL_ID,
            };
            console.log(`✅ Auto-loaded context: ${activeContext.channelName}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Failed to join voice channel:', err.message);
    process.exit(1);
  }
});

// Voice State Update - Detect when user joins voice channel
client.on('voiceStateUpdate', async (oldState, newState) => {
  // Check if it's an allowed user joining a voice channel
  if (newState.id !== ALLOWED_USERS[0]) return; // Not allowed user
  
  // Joining the voice channel we're monitoring
  if (!oldState.channelId && newState.channelId === currentVoiceChannelId) {
    console.log(`👋 User joined voice channel`);
    
    // Check for pending alerts
    if (hasPendingAlerts()) {
      console.log(`📢 Briefing user on pending alerts`);
      // Give a brief delay for connection to stabilize
      setTimeout(async () => {
        await briefPendingAlerts(newState.id);
      }, 2000);
    }
  }
});

async function joinChannel(voiceChannelId, options = {}) {
  const { greeting = false } = options;
  
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error(`Guild ${GUILD_ID} not found`);
  
  const channel = guild.channels.cache.get(voiceChannelId);
  if (!channel) throw new Error(`Voice channel ${voiceChannelId} not found`);
  
  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // We need to hear users
    selfMute: false,
  });
  
  // Wait for connection to be ready
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  
  // Subscribe the audio player
  connection.subscribe(player);
  currentConnection = connection;
  currentVoiceChannelId = voiceChannelId;
  
  // Update alert webhook with current voice channel
  setCurrentVoiceChannelId(voiceChannelId);
  
  // Handle connection state changes
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Try to reconnect
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      // Destroy and rejoin
      connection.destroy();
      console.log('⚠️  Disconnected, attempting to rejoin...');
      setTimeout(joinChannel, 5000);
    }
  });
  
  // Listen to incoming audio
  const receiver = connection.receiver;
  
  // Smart barge-in: track speaking start time to require sustained speech
  const bargeInTimers = new Map();
  // bargeInEvents is now in module scope
  const BARGE_IN_THRESHOLD_MS = 600; // Must speak 0.6s continuously to interrupt
  
  // Cancel barge-in timer if user stops speaking quickly (echo/blip)
  receiver.speaking.on('end', (userId) => {
    if (bargeInTimers.has(userId)) {
      clearTimeout(bargeInTimers.get(userId));
      bargeInTimers.delete(userId);
      console.log(`🔇 ${userId} stopped — barge-in cancelled`);
    }
  });
  
  receiver.speaking.on('start', (userId) => {
    if (!ALLOWED_USERS.includes(userId)) return;
    
    // Smart barge-in: if bot is speaking, start a timer
    // Only interrupt if user speaks continuously for 1.5s+
    if (isSpeaking) {
      if (!bargeInTimers.has(userId)) {
        console.log(`🎤 ${userId} speaking while bot plays — monitoring for barge-in...`);
        const timer = setTimeout(() => {
          if (isSpeaking) {
            console.log(`⚡ Barge-in confirmed (${BARGE_IN_THRESHOLD_MS}ms sustained speech) — stopping playback`);
            bargeInEvents.add(userId); // Mark that this user triggered barge-in
            player.stop(true);
            audioQueue.clear(); // Clear remaining queued segments
            isSpeaking = false;
          }
          bargeInTimers.delete(userId);
        }, BARGE_IN_THRESHOLD_MS);
        bargeInTimers.set(userId, timer);
      }
      // DON'T return early - fall through to subscribe to audio
    } else {
      console.log(`🎤 ${userId} started speaking`);
    }
    
    // Start collecting audio
    if (!userSpeaking.has(userId)) {
      const audioStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: SILENCE_THRESHOLD_MS,
        },
      });
      
      const chunks = [];
      const decoder = new OpusDecoder();
      
      audioStream.pipe(decoder);
      
      decoder.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      audioStream.once('end', async () => {
        userSpeaking.delete(userId);
        
        const totalBuffer = Buffer.concat(chunks);
        const durationMs = (totalBuffer.length / (48000 * 2)) * 1000; // 48kHz, 16-bit mono
        
        console.log(`🔇 ${userId} stopped speaking (${Math.round(durationMs)}ms of audio)`);
        
        if (durationMs < MIN_AUDIO_DURATION_MS) {
          console.log('⏭️  Too short, skipping');
          return;
        }
        
        // Process the speech — queue if already processing
        if (isProcessing) {
          console.log('⏳ Already processing, queuing speech for later');
          speechQueue.push({ userId, totalBuffer });
          return;
        }
        await handleSpeech(userId, totalBuffer);
      });
      
      userSpeaking.set(userId, { startTime: Date.now() });
    }
  });
  
  // Play greeting only if requested
  if (greeting) {
    await playGreeting();
  }
  
  return connection;
}

async function playGreeting() {
  try {
    const greetingAudio = await synthesizeSpeech('Jarvis online. Voice channel is live.');
    await playAudio(greetingAudio);
  } catch (err) {
    console.error('Failed to play greeting:', err.message);
  }
}

// ── Speech Processing Pipeline ────────────────────────────────────────

async function handleSpeech(userId, audioBuffer) {
  isProcessing = true;
  const startTime = Date.now();
  
  try {
    // 1. Save PCM to WAV for Whisper
    const wavPath = join(TMP_DIR, `speech_${userId}_${Date.now()}.wav`);
    await savePcmAsWav(audioBuffer, wavPath);
    
    // 2. Transcribe with Whisper
    console.log('🔤 Transcribing...');
    const rawTranscript = await transcribeAudio(wavPath);
    
    // Cleanup temp file
    try { unlinkSync(wavPath); } catch {}
    
    if (!rawTranscript || rawTranscript.trim().length === 0) {
      console.log('⏭️  Empty transcript, skipping');
      return;
    }
    
    console.log(`📝 Raw transcript: "${rawTranscript}" (${Date.now() - startTime}ms)`);
    
    // 2.5. Check for wake word (with conversation window)
    const { detected, cleanedTranscript } = checkWakeWord(rawTranscript, userId);
    if (!detected) {
      console.log('⏭️  No wake word, skipping processing');
      // Reset conversation depth when wake word is not detected (conversation window expired)
      const conv = conversations.get(userId);
      if (conv && conv.depth > 0) {
        console.log(`🔄 Conversation window expired, resetting depth (was ${conv.depth})`);
        conv.depth = 0;
      }
      return;
    }
    
    const transcript = cleanedTranscript;
    
    console.log(`📝 Cleaned transcript: "${transcript}"`);
    
    // Check for empty/meaningless transcript after wake word removal
    const trimmed = transcript.trim().replace(/[.,!?]/g, '');
    if (!trimmed || trimmed.length < 2) {
      // Just said "Jarvis" with no question — play wake confirmation and wait
      console.log('⏭️  Wake word only — confirming and waiting for follow-up');
      markBotResponse(userId); // Open conversation window IMMEDIATELY
      isProcessing = false;    // Unlock IMMEDIATELY so follow-up can be processed
      const chime = await synthesizeSpeech('Yes?');
      playAudio(chime).then(() => { try { unlinkSync(chime); } catch {} }).catch(() => {});
      return;
    }
    
    // Check for alert briefing follow-up (check before initializing conv)
    let conv = conversations.get(userId);
    if (conv && conv.pendingAlertBriefing && transcript.match(/(yes|yeah|yep|sure|okay|ok|tell me|give me|run down|rundown|briefing|details|full story)/i)) {
      console.log('📢 Alert briefing follow-up detected');
      markBotResponse(userId);
      isProcessing = false; // Release lock immediately
      
      // Speak full alert details
      const alerts = conv.pendingAlertBriefing;
      let details = '';
      
      for (let i = 0; i < alerts.length; i++) {
        const alert = alerts[i];
        if (alerts.length > 1) {
          details += `Alert ${i + 1}. `;
        }
        details += alert.fullDetails || alert.message;
        details += '. ';
      }
      
      const detailsAudio = await synthesizeSpeech(details);
      await playAudio(detailsAudio);
      try { unlinkSync(detailsAudio); } catch {}
      
      // Clear alerts after briefing
      clearAlerts();
      delete conv.pendingAlertBriefing;
      
      return; // Don't proceed to brain
    }
    
    // Channel focus commands now handled by brain (like a skill)
    // The brain can naturally understand "focus on X" and respond accordingly
    
    // 3. Optional immediate ack (feature-flagged)
    const IMMEDIATE_ACKS_ENABLED = process.env.IMMEDIATE_ACKS_ENABLED === 'true';
    let ackPromise = Promise.resolve();
    
    if (IMMEDIATE_ACKS_ENABLED) {
      const immediateAcks = [
        "Yep.",
        "Got it.",
        "Checking.",
        "One sec.",
        "Sure.",
        "On it.",
        "Right.",
        "Okay.",
      ];
      const immediateAck = immediateAcks[Math.floor(Math.random() * immediateAcks.length)];
      console.log(`⚡ Immediate ack: "${immediateAck}"`);
      const ackPath = await synthesizeSpeech(immediateAck);
      ackPromise = playAudio(ackPath).then(() => { try { unlinkSync(ackPath); } catch {} });
    } else {
      console.log(`⚡ Processing (no ack)`);
    }
    
    // 4. Get conversation context (reuse conv if already fetched, otherwise initialize)
    if (!conversations.has(userId)) {
      conversations.set(userId, { history: [], depth: 0, lastResponseType: null });
    }
    if (!conv) {
      conv = conversations.get(userId);
    }
    const history = conv.history;
    const isFollowUp = conv.depth > 0;
    
    // Calculate speech duration from buffer (48kHz, 16-bit mono PCM)
    const speechDurationMs = (audioBuffer.length / (48000 * 2)) * 1000;
    
    // Prepare classification signals
    const classificationSignals = {
      speechDurationMs,
      conversationDepth: conv.depth,
      isFollowUp,
      previousResponseType: conv.lastResponseType,
    };
    
    // Classify intent for hybrid routing
    const classification = classifyIntent({ transcript, ...classificationSignals });
    const intentType = classification.type;
    
    // ── HYBRID ROUTING ──────────────────────────────────────────────
    // Quick queries → direct brain response in voice
    // Work commands → delegate to background agent + voice ack + notify when done
    //
    // Work commands are ACTION intents that contain "work" verbs, delegation structures,
    // or forceDelegation flag from notify/monitor patterns
    const WORK_VERBS = /\b(build|deploy|create|set up|configure|install|investigate|research|analyze|work on|design|implement|migrate|refactor|fix|debug|clean up|archive|organize|schema|write|draft|review|generate|compile|prepare|test|run|execute|apply|push|pull|sync|update|document|validate|verify|monitor|track|follow up|get started|take care|handle|start|begin|continue|proceed)\b/i;
    const WORK_STRUCTURES = /\b(go ahead and|let's (work on|build|create|implement|fix)|I need you to|can you please|would you mind|when you get a chance)\b/i;
    const NOTIFY_PATTERNS = /\b(let me know|notify me|dm me|message me|alert me|ping me|tell me when|text me).*(when|done|ready|finished|complete|available)\b/i;
    const forceDelegation = classification.meta?.forceDelegation === true;
    const isWorkCommand = forceDelegation || (intentType === 'ACTION' && (WORK_VERBS.test(transcript) || WORK_STRUCTURES.test(transcript) || NOTIFY_PATTERNS.test(transcript)));
    
    if (isWorkCommand) {
      // Determine output channel: active context > voice channel > fallback
      const outputChannel = activeContext?.channelId || 
                           process.env.DISCORD_TEXT_CHANNEL_ID || 
                           process.env.DISCORD_VOICE_CHANNEL_ID;
      
      console.log(`🤖 Work command detected, delegating: "${transcript}"`);
      console.log(`📤 Output channel: ${outputChannel}`);
      
      // Voice ack FIRST - tell user we're working on it
      const workAcks = [
        "On it. I'll message you when it's done.",
        "Working on it. I'll post the results when ready.",
        "Got it. I'll let you know when that's complete.",
        "Handling it now. I'll update you shortly.",
      ];
      const ack = workAcks[Math.floor(Math.random() * workAcks.length)];
      const ackAudio = await synthesizeSpeech(ack);
      await playAudio(ackAudio);
      try { unlinkSync(ackAudio); } catch {}
      
      // Spawn background agent
      const agent = await spawnBackgroundAgent(transcript, activeContext, outputChannel);
      
      if (agent) {
        // Track active task
        if (!conversations.has('_activeTasks')) {
          conversations.set('_activeTasks', []);
        }
        conversations.get('_activeTasks').push({
          sessionKey: agent.sessionKey,
          task: transcript,
          startedAt: Date.now(),
          outputChannel,
        });
        
        // Mark bot response to keep conversation window open
        markBotResponse(userId);
        
        // Monitor for completion and notify via voice + DM
        monitorAgentCompletion(agent.sessionKey, outputChannel).then(async (summary) => {
          if (summary) {
            console.log(`📢 Agent completed, announcing: "${summary}"`);
            
            // Voice announcement if user is still in channel
            try {
              const announcementAudio = await synthesizeSpeech(`Task complete. ${summary}`);
              await playAudio(announcementAudio);
              try { unlinkSync(announcementAudio); } catch {}
            } catch (err) {
              console.error(`⚠️  Voice announcement failed: ${err.message}`);
            }
            
            // Also DM the user
            try {
              const user = await client.users.fetch(userId);
              await user.send(`✅ **Voice Task Complete:**\n${summary}`);
              console.log(`📱 Completion DM sent to user ${userId}`);
            } catch (err) {
              console.error(`⚠️  Completion DM failed: ${err.message}`);
            }
          }
        }).catch(err => {
          console.error(`⚠️  Agent monitoring error: ${err.message}`);
        });
        
        isProcessing = false;
        return;
      } else {
        // Fallback if spawn fails - continue to normal brain call
        console.log('⚠️  Agent spawn failed, falling back to direct response');
        const errorAudio = await synthesizeSpeech("Delegation failed. Handling it directly.");
        await playAudio(errorAudio);
        try { unlinkSync(errorAudio); } catch {}
        // Fall through to brain call
      }
    }
    
    // 5. Generate response via Clawdbot Gateway (runs while ack plays)
    console.log('🧠 Thinking...');
    const brainPromise = generateResponse(transcript, history, classificationSignals, activeContext);
    
    // Dynamic heartbeat (optional, feature-flagged)
    let heartbeatTimer = null;
    let heartbeatPlayed = false;
    
    if (HEARTBEAT_ENABLED) {
      const heartbeatDelay = parseInt(process.env.HEARTBEAT_DELAY_MS) || 15000; // Default 15s
      
      heartbeatTimer = setTimeout(async () => {
        if (!heartbeatPlayed && isProcessing) {
          console.log(`💓 Heartbeat: brain taking longer than expected, playing update`);
          heartbeatPlayed = true;
          const updates = [
            "Still thinking.",
            "One moment.",
            "Working on it.",
            "Almost there.",
            "Just a sec.",
          ];
          const update = updates[Math.floor(Math.random() * updates.length)];
          const heartbeatAudio = await synthesizeSpeech(update);
          await playAudio(heartbeatAudio);
        }
      }, heartbeatDelay);
    }
    
    const [_, brainResult] = await Promise.all([
      ackPromise,
      brainPromise,
    ]);
    
    // Clear heartbeat if brain finished quickly
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    const { text: response, tier, needsAck, ackText, responseType } = brainResult;
    
    console.log(`💬 [${tier}] Response: "${response}" (${Date.now() - startTime}ms total so far)`);
    
    // Extract entities from response and update voice state
    extractAndUpdateState(response);
    
    // Update conversation history and tracking
    history.push({ role: 'user', content: transcript });
    history.push({ role: 'assistant', content: response });
    
    // Keep last 20 exchanges
    while (history.length > 40) history.shift();
    
    // Increment conversation depth and store response type
    conv.depth += 1;
    conv.lastResponseType = responseType || null;
    console.log(`📊 Conversation depth: ${conv.depth}, Last response type: ${conv.lastResponseType}`);
    
    // Post long responses to Discord text channel (like text chat does)
    const TEXT_SPILLOVER_CHARS = parseInt(process.env.TEXT_SPILLOVER_CHARS) || 300;
    if (response.length > TEXT_SPILLOVER_CHARS) {
      // Post to active context channel if set
      if (activeContext?.channelId) {
        try {
          const channel = client.channels.cache.get(activeContext.channelId);
          if (channel) {
            await channel.send(`🎙️ **Voice Response (${activeContext.channelName}):**\n${response}`);
            console.log(`📝 Long response posted to context channel ${activeContext.channelId} (${activeContext.channelName})`);
          }
        } catch (err) {
          console.error(`⚠️  Failed to post to context channel: ${err.message}`);
        }
      }
      
      // Also send DM to user for record-keeping
      try {
        const user = await client.users.fetch(userId);
        const contextLabel = activeContext ? ` [${activeContext.channelName}]` : '';
        await user.send(`🎙️ **Voice${contextLabel}:**\n${response}`);
        console.log(`📱 Long response sent as DM to user ${userId}`);
      } catch (err) {
        console.error(`⚠️  Failed to send DM: ${err.message}`);
      }
    }
    
    // 5. Synthesize and play speech (streaming or batch)
    if (STREAMING_TTS_ENABLED && response.length > 100) {
      // Streaming mode: split into sentences and stream
      console.log('🔊 Streaming TTS (sentence-level chunking)...');
      const sentences = splitIntoSentences(response);
      console.log(`📄 Split into ${sentences.length} sentences`);
      
      // Clear any existing queue
      audioQueue.clear();
      
      // Synthesize first sentence immediately, start playing, then synth rest in parallel
      const firstSentence = sentences[0];
      const firstAudioPath = await synthesizeSpeech(firstSentence);
      
      const totalTime = Date.now() - startTime;
      console.log(`⏱️  Total pipeline to first audio: ${totalTime}ms`);
      
      // Start playing first sentence immediately
      audioQueue.add(firstAudioPath, { index: 1, total: sentences.length, sentence: firstSentence });
      
      // Synthesize remaining sentences and queue them as they complete
      for (let i = 1; i < sentences.length; i++) {
        const sentence = sentences[i];
        try {
          const audioPath = await synthesizeSpeech(sentence);
          audioQueue.add(audioPath, { index: i + 1, total: sentences.length, sentence });
        } catch (err) {
          console.error(`Failed to synthesize sentence ${i + 1}:`, err.message);
        }
      }
      
      // Wait for queue to finish
      while (audioQueue.playing || audioQueue.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else {
      // Batch mode: synthesize entire response at once
      console.log('🔊 Synthesizing speech (batch mode)...');
      const audioPath = await synthesizeSpeech(response);
      
      const totalTime = Date.now() - startTime;
      console.log(`⏱️  Total pipeline: ${totalTime}ms`);
      
      // Play audio
      await playAudio(audioPath);
      
      // Cleanup
      try { unlinkSync(audioPath); } catch {}
    }
    
    // Mark that the bot just responded (starts conversation window)
    markBotResponse(userId);
    
    // 7. Check for cross-channel output commands
    const outputCmd = detectOutputCommand(transcript);
    if (outputCmd.wantsOutput) {
      console.log(`📤 Output requested: ${outputCmd.destination}`);
      // Fire webhook as backup (Clawdbot may have already handled via tools)
      await sendCrossChannelOutput(
        `Send the following to ${outputCmd.destination}: ${response}`,
        `User said: "${transcript}"\nJarvis responded: "${response}"`
      );
    }
    
  } catch (err) {
    console.error('❌ Error processing speech:', err);
  } finally {
    isProcessing = false;
    
    // Check if alert briefing is pending (alert arrived while in conversation)
    if (pendingAlertBriefingForUser && hasPendingAlerts()) {
      const userId = pendingAlertBriefingForUser;
      pendingAlertBriefingForUser = null; // Clear flag
      console.log('📢 Natural pause detected - briefing on pending alert');
      // Brief on next tick to ensure cleanup completes
      setImmediate(() => briefPendingAlerts(userId));
      return; // Don't process queued speech yet - let briefing happen first
    }
    
    // Process queued speech if any
    if (speechQueue.length > 0) {
      console.log(`📥 Processing queued speech (${speechQueue.length} in queue)`);
      const next = speechQueue.shift();
      setImmediate(() => handleSpeech(next.userId, next.totalBuffer));
    }
  }
}

async function playAudio(audioSourceOrPath) {
  isSpeaking = true;
  const playStart = Date.now();
  
  let resource;
  let estimatedDurationMs = 2000; // Default for streams
  
  // Check if it's a file path (string) or a stream (Readable)
  if (typeof audioSourceOrPath === 'string') {
    // File path
    const filePath = audioSourceOrPath;
    const fileBuffer = readFileSync(filePath);
    const fileSizeKB = fileBuffer.length / 1024;
    estimatedDurationMs = Math.max(2000, (fileSizeKB / 5) * 1000);
    console.log(`🔊 Playing audio from file (${fileBuffer.length} bytes, est ${Math.round(estimatedDurationMs / 1000)}s)`);
    
    const { createReadStream: crs } = await import('fs');
    resource = createAudioResource(crs(filePath), {
      inlineVolume: true,
    });
  } else {
    // Stream (Readable)
    console.log(`🔊 Playing audio from stream`);
    resource = createAudioResource(audioSourceOrPath, {
      inlineVolume: true,
    });
    estimatedDurationMs = 30000; // Generous timeout for streams — let Idle event handle normal finish
  }
  
  resource.volume.setVolume(1.0);
  player.play(resource);
  
  return new Promise((resolve) => {
    let resolved = false;
    let onIdle, onError, timeoutId, checkInterval;
    
    const finish = (reason) => {
      if (resolved) return;
      resolved = true;
      
      // Clean up all listeners and timers
      if (onIdle) player.off(AudioPlayerStatus.Idle, onIdle);
      if (onError) player.off('error', onError);
      if (timeoutId) clearTimeout(timeoutId);
      if (checkInterval) clearInterval(checkInterval);
      
      const elapsed = Date.now() - playStart;
      console.log(`🔊 Playback finished (${elapsed}ms, ${reason})`);
      isSpeaking = false;
      resolve();
    };
    
    // Listen for Idle
    onIdle = () => {
      const elapsed = Date.now() - playStart;
      // For streams, don't enforce minimum duration check (we don't know expected length)
      if (typeof audioSourceOrPath === 'string') {
        const minExpected = Math.min(estimatedDurationMs * 0.5, 3000);
        if (elapsed < minExpected) {
          // Check if this was caused by barge-in (expected behavior)
          const wasBargeIn = Array.from(bargeInEvents).length > 0;
          if (wasBargeIn) {
            // Clear barge-in events and don't warn (expected behavior)
            bargeInEvents.clear();
            console.log(`🔇 Idle after barge-in (${elapsed}ms) — expected behavior`);
          } else {
            // Actual premature idle (not from barge-in) — warn
            console.log(`⚠️  Premature Idle after ${elapsed}ms (expected ~${Math.round(estimatedDurationMs)}ms), re-listening...`);
            player.once(AudioPlayerStatus.Idle, onIdle);
            return;
          }
        } else {
          // Normal completion — clear barge-in tracking if present
          bargeInEvents.clear();
        }
      }
      finish('idle');
    };
    
    player.once(AudioPlayerStatus.Idle, onIdle);
    
    onError = (err) => {
      console.error('🔊 Player error:', err.message);
      finish('error');
    };
    player.once('error', onError);
    
    // Timeout: 2x estimated duration or 10 minutes, whichever is less
    const timeout = Math.min(estimatedDurationMs * 2, 600000);
    timeoutId = setTimeout(() => finish('timeout'), timeout);
    
    // Periodic check: if we're past expected duration and player is Idle, finish cleanly
    // This handles cases where the Idle event doesn't fire reliably
    checkInterval = setInterval(() => {
      const elapsed = Date.now() - playStart;
      if (elapsed >= estimatedDurationMs && player.state.status === AudioPlayerStatus.Idle) {
        finish('idle-polled');
      }
    }, 500);
  });
}

// ── WAV Helper ────────────────────────────────────────────────────────

function savePcmAsWav(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const sampleRate = 48000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const headerSize = 44;
    
    const header = Buffer.alloc(headerSize);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + headerSize - 8, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20);  // PCM format
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

// ── Graceful Shutdown ─────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  if (currentConnection) currentConnection.destroy();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (currentConnection) currentConnection.destroy();
  client.destroy();
  process.exit(0);
});

// ── Start ─────────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is required. See .env.example');
  console.error('');
  console.error('⚠️  IMPORTANT: This bot needs its own Discord application!');
  console.error('   It CANNOT share the same token as Clawdbot.');
  console.error('');
  console.error('   1. Go to https://discord.com/developers/applications');
  console.error('   2. Create a new application (e.g., "Jarvis Voice")');
  console.error('   3. Go to Bot → Reset Token → Copy it');
  console.error('   4. Enable "Server Members Intent" and "Message Content Intent"');
  console.error('   5. Invite to your server with voice permissions');
  console.error('   6. Paste the token in .env as DISCORD_TOKEN');
  console.error('');
  console.error('   Invite URL template:');
  console.error('   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=36700160&scope=bot');
  console.error('   (permissions: Connect + Speak + Use Voice Activity)');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
