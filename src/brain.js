/**
 * Brain Module - Thin voice I/O layer to Clawdbot Gateway
 * 
 * The voice bot is just a mic and speaker. The SAME Clawdbot agent
 * that handles Discord text, Slack, WhatsApp, etc. handles voice.
 * All tools, web search, MCP integrations, email, calendar — 
 * everything is handled by the gateway agent. We just add a voice
 * prefix so the agent formats its response for TTS.
 */

import 'dotenv/config';
import { getVoiceStateContext } from './voice-state.js';
import { classifyIntent } from './intent-classifier.js';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;

const SESSION_USER = process.env.SESSION_USER || 'jarvis-voice-user';

// Discord context cache
let discordContextCache = null;
let discordContextCachedAt = null;
const DISCORD_CONTEXT_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Fetch current Discord threads from #general for context injection
 */
async function getDiscordContext() {
  // Check cache
  if (discordContextCache && discordContextCachedAt) {
    const age = Date.now() - discordContextCachedAt;
    if (age < DISCORD_CONTEXT_TTL_MS) {
      console.log(`📋 Using cached Discord context (${Math.round(age / 1000)}s old)`);
      return discordContextCache;
    }
  }
  
  try {
    console.log('📋 Fetching Discord threads from #general...');
    const discordChannelId = process.env.DISCORD_CHANNEL_ID;
    if (!discordChannelId) {
      console.warn('⚠️  DISCORD_CHANNEL_ID not set, skipping context fetch');
      return '';
    }
    
    const res = await fetch(`${GATEWAY_URL}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        message: `List current threads in channel ${discordChannelId} (use message tool with action=thread-list)`,
        name: 'JarvisVoiceContextFetch',
        sessionKey: 'hook:jarvis-voice:discord-context',
        deliver: false, // Don't send to channels, just return result
        wakeMode: 'now',
      }),
    });
    
    if (!res.ok) {
      console.warn('⚠️  Discord context fetch failed:', res.status);
      return '';
    }
    
    const data = await res.json();
    const threadList = data.response || '';
    
    // Extract thread names/IDs for concise context
    // Response likely contains thread info - keep it brief for voice prefix
    const contextStr = threadList.substring(0, 500); // Cap at 500 chars
    
    // Cache it
    discordContextCache = contextStr;
    discordContextCachedAt = Date.now();
    
    console.log(`📋 Discord context cached: ${contextStr.substring(0, 100)}...`);
    return contextStr;
  } catch (err) {
    console.error('❌ Failed to fetch Discord context:', err.message);
    return '';
  }
}

/**
 * Build dynamic voice prefix with intent-based budget constraints
 */
function getVoicePrefix(budgetInstruction = null) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  
  let prefix = `VOICE MODE. Spoken aloud via TTS. No markdown/formatting. Natural speech only.
You are Jarvis. Conversational, direct, personalized to the user. Never say "sir". Use their name rarely.
Time: ${now} Eastern.

IMPORTANT: When the user asks you to monitor, check, or work on something that will take time:
- Acknowledge naturally ("I'm monitoring it", "On it", "Checking now")
- Keep it brief (2-5 words)
- Don't explain the process — just confirm you're doing it

VirusTotal: To download malware samples use the VT API directly with curl:
curl -s "https://www.virustotal.com/api/v3/files/{hash}/download" -H "x-apikey: $VIRUSTOTAL_API_KEY" -o sample.bin
The MCP tools (vt_file_report, vt_url_report, vt_domain_report, vt_ip_report) are for lookups only.`;

  // Add budget instruction if provided (this is the key constraint)
  if (budgetInstruction) {
    prefix += `\n\n${budgetInstruction}`;
  }
  
  return prefix;
}

/**
 * Trim response for voice - strip markdown and truncate
 */
function trimForVoice(text) {
  let clean = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // bold
    .replace(/\*([^*]+)\*/g, '$1')        // italic
    .replace(/#{1,6}\s+/g, '')            // headers
    .replace(/```[\s\S]*?```/g, '')       // code blocks
    .replace(/`([^`]+)`/g, '$1')          // inline code
    .replace(/^[-*+]\s+/gm, '')           // bullets
    .replace(/^\d+\.\s+/gm, '')           // numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/\n{2,}/g, '. ')             // double newlines to periods
    .replace(/\n/g, ' ')                  // single newlines to spaces
    .replace(/\s{2,}/g, ' ')             // collapse spaces
    .trim();
  
  return clean;
}

/**
 * Generate response via Clawdbot Gateway
 * 
 * This sends the voice transcript through the SAME agent that handles
 * all other channels. The agent has full tool access — web search,
 * email, calendar, Slack, MCP integrations, everything.
 */
// Track current model override
let currentModel = null; // null = default (sonnet)

function checkModelSwitch(msg) {
  const lower = msg.toLowerCase();
  if (lower.match(/\b(opus|advanced)\b/)) {
    currentModel = 'opus';
    return 'Switched to Opus.';
  }
  if (lower.match(/\b(sonnet|default|normal)\b/) && lower.match(/\b(mode|switch|use)\b/)) {
    currentModel = null;
    return 'Back to Sonnet.';
  }
  return null;
}

export async function generateResponse(userMessage, history = [], classificationSignals = {}, activeContext = null) {
  // Check for model switch commands
  const switchMsg = checkModelSwitch(userMessage);
  if (switchMsg) {
    console.log(`🧠 Model switch: ${currentModel || 'sonnet (default)'}`);
    return { text: switchMsg, tier: currentModel || 'sonnet', needsAck: false, ackText: null, responseType: 'CHAT' };
  }
  
  const model = currentModel === 'opus' ? 'anthropic/claude-opus-4-6' : 'clawdbot:main';
  const tier = currentModel === 'opus' ? 'opus' : 'sonnet';
  console.log(`🧠 Model: ${tier}`);
  
  // Classify intent and get response budget
  const classification = classifyIntent({
    transcript: userMessage,
    ...classificationSignals,
  });
  
  console.log(`🎯 Intent: ${classification.type}, Budget: ${classification.maxSentences} sentences / ${classification.maxSpokenSeconds}s, Style: ${classification.responseStyle}`);
  
  // Fetch Discord context and voice state context (run in parallel)
  const [discordContext, voiceStateContext] = await Promise.all([
    getDiscordContext(),
    Promise.resolve(getVoiceStateContext()),
  ]);
  
  // Build enriched voice prefix with budget instruction
  let voicePrefix = getVoicePrefix(classification.budgetInstruction);
  
  // Inject active context directive if present
  if (activeContext && activeContext.directive) {
    voicePrefix += `\n\nACTIVE CONTEXT: ${activeContext.channelName}`;
    voicePrefix += `\nChannel directive:\n${activeContext.directive}`;
    voicePrefix += `\n\nWork within this context. Use tools and knowledge relevant to this focus area.`;
  }
  
  if (discordContext) {
    voicePrefix += `\n\nCurrent Discord threads in #general:\n${discordContext}`;
    voicePrefix += `\nWhen user references "the thread" or "first thread", use these. You can also use the message tool with action=thread-list to fetch fresh data.`;
  }
  
  if (voiceStateContext) {
    voicePrefix += `\n\n${voiceStateContext}`;
    voicePrefix += `\nWhen user says "that thread", "that file", "the channel" — resolve from this state.`;
  }
  
  // Add spillover mechanism if enabled
  if (classification.spillover) {
    voicePrefix += `\n\nIf your full response exceeds the budget, compress for voice and end with "I've posted the full details in the text channel." Then actually post the full version using the message tool.`;
  }
  
  const voiceMessage = `${voicePrefix}\n\n${userMessage}`;
  
  const messages = [
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: voiceMessage },
  ];
  
  // Use context-specific session key when activeContext is set
  const sessionUser = activeContext 
    ? `jarvis-voice-${activeContext.channelName.replace(/\s+/g, '-')}`
    : SESSION_USER;
  
  console.log(`📍 Session: ${sessionUser}`);
  
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    };
    if (model === 'clawdbot:main') {
      headers['x-clawdbot-agent-id'] = 'main';
    }
    
    // Create timeout controller (60s max for brain calls)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 8192,
        user: sessionUser,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      const body = await res.text();
      console.error('Gateway Error:', res.status, body);
      throw new Error(`Gateway ${res.status}: ${body}`);
    }
    
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || "Trouble thinking. Try again?";
    
    // Force trim for voice
    text = trimForVoice(text);
    
    return { 
      text, 
      tier, 
      needsAck: false, 
      ackText: null,
      responseType: classification.type,
    };
    
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('⏱️  Gateway timeout (60s)');
      return {
        text: "That's taking too long. Let me try a different approach.",
        tier: 'error', 
        needsAck: false, 
        ackText: null,
        responseType: 'ERROR',
      };
    }
    console.error('Gateway failed:', err.message);
    return {
      text: "I'm having trouble connecting right now. Try again?",
      tier: 'error', 
      needsAck: false, 
      ackText: null,
      responseType: 'ERROR',
    };
  }
}

export async function sendCrossChannelOutput(instruction, context) {
  try {
    const res = await fetch(`${GATEWAY_URL}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        message: `Voice command from user: ${instruction}\n\nContext:\n${context}`,
        name: 'JarvisVoice',
        sessionKey: 'hook:jarvis-voice:output',
        deliver: true, channel: 'last', wakeMode: 'now',
      }),
    });
    if (res.ok) console.log('📤 Cross-channel output sent');
  } catch (err) {
    console.error('Cross-channel error:', err.message);
  }
}

export function detectOutputCommand(text) {
  const patterns = [
    { regex: /(?:post|send|put|output|write)\s+(?:that|this|it)?\s*(?:to|in|on)\s+slack/i, dest: 'slack' },
    { regex: /(?:post|send|put|output|write)\s+(?:that|this|it)?\s*(?:to|in|on)\s+discord/i, dest: 'discord' },
    { regex: /(?:post|send|put|output|write)\s+(?:that|this|it)?\s*(?:to|in|on)\s+(?:the\s+)?(?:security|security.intel)/i, dest: 'security' },
    { regex: /(?:post|send|put|output|write)\s+(?:that|this|it)?\s*(?:to|in|on)\s+(?:the\s+)?(?:lance.workspace|workspace)/i, dest: 'slack-workspace' },
    { regex: /(?:post|send|put|output|write)\s+(?:that|this|it)?\s*(?:to|in|on)\s+(?:the\s+)?channel/i, dest: 'discord-current' },
    { regex: /(?:post|send|put|output|write)\s+(?:that|this|it)?\s*(?:to|in|on)\s+whatsapp/i, dest: 'whatsapp' },
  ];
  for (const { regex, dest } of patterns) {
    if (regex.test(text)) return { wantsOutput: true, destination: dest };
  }
  return { wantsOutput: false, destination: null };
}

// Keep these exports for backward compat but they're no longer used
export function detectModelTier() { return { model: 'clawdbot:main', tier: 'agent', needsAck: false }; }
export function getAckMessage() { return 'One moment.'; }
