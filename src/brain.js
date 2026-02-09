/**
 * Brain Module - Thin voice I/O layer to Clawdbot Gateway
 * 
 * Voice is just another input method. Same agent, same session,
 * same tools. We prepend a short [VOICE] tag so the agent knows
 * to format for speech (no markdown, concise). That's it.
 * 
 * Supports concurrent requests — each call gets its own AbortController
 * chained to an external signal for cancellation.
 * 
 * Streaming: generateResponseStreaming() emits sentences as they arrive
 * so TTS can start playing before the full response is generated.
 */

import 'dotenv/config';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;

// Use the main Discord text channel session — same brain as chat
const SESSION_USER = process.env.SESSION_USER || 'jarvis-voice-user';

// Voice tag prepended to messages so the agent formats for TTS
// Key: use tools exactly as you would in text chat. The ONLY difference is output format.
const VOICE_TAG = `[VOICE] This is a voice request. Use tools and take actions exactly as you would for a text message — check live data, run commands, use MCP services. The ONLY difference: format your final response for spoken TTS output. No markdown, no formatting, no bullet points, no numbered lists. Natural conversational speech only.`;

// Sentence boundary pattern — split on . ! ? followed by space or end
const SENTENCE_END = /[.!?]+(?:\s|$)/;

/**
 * Trim response for voice - strip any markdown that slipped through
 */
export function trimForVoice(text) {
  let clean = text
    .replace(/\[\[tts:([^\]]*)\]\]/g, '$1')  // [[tts:text]] → text
    .replace(/\[\[\/tts:text\]\]/g, '')      // [[/tts:text]] closing tag
    .replace(/\[\[tts:text\]\]/g, '')        // [[tts:text]] opening tag
    .replace(/\[\[reply_to[^\]]*\]\]/g, '')  // [[reply_to:...]] tags
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // bold
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
 * Generate response via streaming SSE — calls onSentence() as each
 * complete sentence arrives, so TTS can start immediately.
 * 
 * @param {string} userMessage - The transcribed voice input
 * @param {Array} history - Conversation history
 * @param {AbortSignal} signal - For cancellation
 * @param {Function} onSentence - Called with each complete sentence
 * @returns {{ text: string, aborted?: boolean }} Full response text
 */
export async function generateResponseStreaming(userMessage, history = [], signal, onSentence) {
  const voiceMessage = `${VOICE_TAG}\n\n${userMessage}`;
  
  const messages = [
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: voiceMessage },
  ];
  
  const controller = new AbortController();
  
  if (signal) {
    if (signal.aborted) {
      return { text: '', aborted: true };
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  
  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'anthropic/claude-opus-4-6',
        messages,
        max_tokens: 8192,
        user: SESSION_USER,
        stream: true,
      }),
    });
    
    if (!res.ok) {
      const body = await res.text();
      console.error('Gateway Error:', res.status, body);
      throw new Error(`Gateway ${res.status}: ${body}`);
    }
    
    // Parse SSE stream, accumulate text, emit sentences
    let fullText = '';
    let buffer = '';
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      sseBuffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE lines
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // Keep incomplete line
      
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (!content) continue;
          
          buffer += content;
          fullText += content;
          
          // Strip [[tts:...]] tags from the streaming buffer before sentence detection
          // These tags span across sentences so strip them from the raw buffer
          buffer = buffer.replace(/\[\[tts:[^\]]*\]\]/g, '');
          buffer = buffer.replace(/\[\[\/tts:text\]\]/g, '');
          buffer = buffer.replace(/\[\[tts:text\]\]/g, '');
          buffer = buffer.replace(/\[\[reply_to[^\]]*\]\]/g, '');
          
          // Check for complete sentences and emit them
          let match;
          while ((match = buffer.match(SENTENCE_END))) {
            const sentenceEnd = match.index + match[0].length;
            let sentence = buffer.substring(0, sentenceEnd).trim();
            buffer = buffer.substring(sentenceEnd);
            
            // Clean for voice
            sentence = trimForVoice(sentence);
            if (sentence && sentence.length > 1) {
              onSentence(sentence);
            }
          }
        } catch {}
      }
    }
    
    // Flush remaining buffer as final sentence
    if (buffer.trim()) {
      const final = trimForVoice(buffer.trim());
      if (final && final.length > 1) {
        onSentence(final);
      }
    }
    
    return { text: trimForVoice(fullText) };
    
  } catch (err) {
    if (err.name === 'AbortError') {
      return { text: '', aborted: true };
    }
    console.error('Gateway failed:', err.message);
    
    // Flush whatever we have
    if (buffer && buffer.trim()) {
      const partial = trimForVoice(buffer.trim());
      if (partial) onSentence(partial);
    }
    
    return { text: "I'm having trouble connecting right now. Try again?" };
  }
}

/**
 * Generate response (non-streaming fallback)
 */
export async function generateResponse(userMessage, history = [], signal) {
  const voiceMessage = `${VOICE_TAG}\n\n${userMessage}`;
  
  const messages = [
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: voiceMessage },
  ];
  
  const controller = new AbortController();
  
  if (signal) {
    if (signal.aborted) {
      return { text: '', aborted: true };
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  
  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'anthropic/claude-opus-4-6',
        messages,
        max_tokens: 8192,
        user: SESSION_USER,
      }),
    });
    
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gateway ${res.status}: ${body}`);
    }
    
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || "Trouble thinking. Try again?";
    text = trimForVoice(text);
    return { text };
    
  } catch (err) {
    if (err.name === 'AbortError') {
      return { text: '', aborted: true };
    }
    console.error('Gateway failed:', err.message);
    return { text: "I'm having trouble connecting right now. Try again?" };
  }
}
