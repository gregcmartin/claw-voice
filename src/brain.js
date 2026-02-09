/**
 * Brain Module - Thin voice I/O layer to Clawdbot Gateway
 * 
 * Voice is just another input method. Same agent, same session,
 * same tools. We prepend a short [VOICE] tag so the agent knows
 * to format for speech (no markdown, concise). That's it.
 */

import 'dotenv/config';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;

// Use the main Discord text channel session — same brain as chat
const SESSION_USER = process.env.SESSION_USER || 'jarvis-voice-user';

// Voice tag prepended to messages so the agent formats for TTS
const VOICE_TAG = `[VOICE] Respond for spoken TTS output. No markdown, no formatting, no bullet points, no numbered lists. Natural conversational speech only. Keep responses concise — this will be spoken aloud.`;

/**
 * Trim response for voice - strip any markdown that slipped through
 */
function trimForVoice(text) {
  let clean = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // bold
    .replace(/\*([^*]+)\*/g, '$1')           // italic
    .replace(/#{1,6}\s+/g, '')               // headers
    .replace(/```[\s\S]*?```/g, '')          // code blocks
    .replace(/`([^`]+)`/g, '$1')             // inline code
    .replace(/^[-*+]\s+/gm, '')              // bullets
    .replace(/^\d+\.\s+/gm, '')              // numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/\n{2,}/g, '. ')               // double newlines to periods
    .replace(/\n/g, ' ')                     // single newlines to spaces
    .replace(/\s{2,}/g, ' ')                // collapse spaces
    .trim();
  
  return clean;
}

/**
 * Generate response via Clawdbot Gateway
 * 
 * Sends the voice transcript through the SAME agent that handles
 * all other channels. The agent has full tool access — web search,
 * email, calendar, Slack, MCP integrations, everything.
 */
export async function generateResponse(userMessage, history = []) {
  const voiceMessage = `${VOICE_TAG}\n\n${userMessage}`;
  
  const messages = [
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: voiceMessage },
  ];
  
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    };
    
    // Timeout: 60s max for brain calls
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'anthropic/claude-opus-4-6',  // Opus for voice
        messages,
        max_tokens: 8192,
        user: SESSION_USER,
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
    
    // Strip markdown for voice
    text = trimForVoice(text);
    
    return { text };
    
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('⏱️  Gateway timeout (60s)');
      return { text: "That's taking too long. Let me try a different approach." };
    }
    console.error('Gateway failed:', err.message);
    return { text: "I'm having trouble connecting right now. Try again?" };
  }
}
