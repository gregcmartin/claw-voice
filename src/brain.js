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
import { readFileSync, existsSync } from 'fs';

/**
 * Build workspace/memory context for the voice agent
 * This gives the voice bot the same awareness as text Jarvis
 */
function getWorkspaceContext() {
  const sections = [];
  
  // Load today's memory file
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  
  for (const date of [today, yesterday]) {
    const memPath = `/home/lj/dev/memory/${date}.md`;
    try {
      if (existsSync(memPath)) {
        const content = readFileSync(memPath, 'utf-8');
        // Take first 1000 chars to keep voice context lean
        sections.push(`MEMORY (${date}):\n${content.substring(0, 1000)}`);
      }
    } catch (e) { /* ignore */ }
  }
  
  // Load key channel directives for known workspaces
  const workspaces = {
    'Gibson': '/home/lj/dev/contexts/C0ACEAKC0NA.md',
    'Security': '/home/lj/dev/contexts/1469100602805063701.md',
    'Forensics': '/home/lj/dev/contexts/1469100616898056265.md',
  };
  
  const workspaceNames = [];
  for (const [name, path] of Object.entries(workspaces)) {
    try {
      if (existsSync(path)) {
        workspaceNames.push(name);
      }
    } catch (e) { /* ignore */ }
  }
  
  if (workspaceNames.length > 0) {
    sections.push(`AVAILABLE WORKSPACES: ${workspaceNames.join(', ')}
When user mentions a project name, load its directive from contexts/ for full context.
Use haivemind (mcporter call haivemind.search_memories) to recall project-specific details.`);
  }
  
  return sections.join('\n\n');
}

function getVoicePrefix(budgetInstruction = null) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  
  let prefix = `VOICE MODE. Spoken aloud via TTS. No markdown/formatting. Natural speech only.
You are Jarvis, Lance's AI assistant. Conversational, direct, British-inflected wit. Never say "sir" every message.
Time: ${now} Eastern. Owner: Lance James, CEO Unit221B. Location: New York.

WORKSPACE: /home/lj/dev
You have full access to Lance's workspace, tools, and integrations — same as text Jarvis.

KEY TOOLS AVAILABLE (ALL configured and working — use them automatically, don't ask permission):
- Email: mcporter call google-workspace.search_emails / get_email
- Calendar: mcporter call google-workspace.list_events / create_event
- Memory: mcporter call haivemind.search_memories / store_memory
- Notion: mcporter call notion.API-post-search / API-retrieve-a-page
- Linear: mcporter call linear.list_issues
- Web search: web_search tool (Brave API key IS configured — NEVER say it's not set up)
- Files: read/write/exec in /home/lj/dev

CRITICAL: ALL API keys and integrations are already configured. NEVER tell the user that a tool "needs to be set up" or "needs an API key." If a tool fails, try it first, then report the actual error. Do NOT preemptively claim tools are unavailable.

FALLBACK: If you're ever unsure about a tool or credential, search haivemind first:
  mcporter call haivemind.search_memories query="API key [service name]"
  mcporter call haivemind.search_memories query="credentials [service name]"
haivemind has stored credentials and setup instructions for everything. Check it before saying "I can't."

CHANNEL DIRECTIVES: Check contexts/[channel-id].md for project-specific context.
When user says a project name (Gibson, eWitness, Redline, etc.), search haivemind for that project's context.

MEMORY: Use haivemind automatically:
- Before answering project questions: search haivemind first
- When user says "remember": store to haivemind silently
- When user says "recall": search haivemind and answer

IMPORTANT: When the user asks you to monitor, check, or work on something that will take time:
- Acknowledge naturally ("I'm monitoring it", "On it", "Checking now")
- Keep it brief (2-5 words)
- Don't explain the process — just confirm you're doing it`;

  // Add workspace context (today's memory, available workspaces)
  const wsContext = getWorkspaceContext();
  if (wsContext) {
    prefix += `\n\n${wsContext}`;
  }

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
let currentModel = 'opus'; // default to opus

function checkModelSwitch(msg) {
  const lower = msg.toLowerCase();
  if (lower.match(/\b(sonnet|basic)\b/) && lower.match(/\b(mode|switch|use)\b/)) {
    currentModel = 'sonnet';
    return 'Switched to Sonnet.';
  }
  if (lower.match(/\b(opus|advanced)\b/) && lower.match(/\b(mode|switch|use)\b/)) {
    currentModel = 'opus';
    return 'Already on Opus.';
  }
  return null;
}

export async function generateResponse(userMessage, history = [], classificationSignals = {}, activeContext = null) {
  // Check for model switch commands
  const switchMsg = checkModelSwitch(userMessage);
  if (switchMsg) {
    console.log(`🧠 Model switch: ${currentModel}`);
    return { text: switchMsg, tier: currentModel, needsAck: false, ackText: null, responseType: 'CHAT' };
  }
  
  const model = currentModel === 'sonnet' ? 'clawdbot:main' : 'anthropic/claude-opus-4-6';
  const tier = currentModel === 'sonnet' ? 'sonnet' : 'opus';
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
