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
/**
 * Generate streaming response via Clawdbot Gateway (SSE)
 * 
 * Streams tokens as they arrive, fires onSentence() callback
 * whenever a complete sentence is buffered. This lets TTS start
 * on the first sentence while the rest is still generating.
 * 
 * Returns the full accumulated response text when the stream ends.
 */
export async function generateResponseStreaming(userMessage, history = [], onSentence) {
  const voiceMessage = `${VOICE_TAG}\n\n${userMessage}`;
  
  const messages = [
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: voiceMessage },
  ];
  
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GATEWAY_TOKEN}`,
  };
  
  const controller = new AbortController();
  
  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: 'anthropic/claude-opus-4-6',
        messages,
        max_tokens: 8192,
        stream: true,
        user: SESSION_USER,
      }),
    });
    
    if (!res.ok) {
      const body = await res.text();
      console.error('Gateway streaming error:', res.status, body);
      throw new Error(`Gateway ${res.status}: ${body}`);
    }
    
    let fullText = '';
    let sentenceBuffer = '';
    
    // Sentence boundary: period/exclamation/question followed by space and uppercase,
    // or end-of-stream flush
    const SENTENCE_BOUNDARY = /([.!?])\s+(?=[A-Z])/;
    const MIN_SENTENCE_LENGTH = 20;
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let partial = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      partial += decoder.decode(value, { stream: true });
      
      // Process complete SSE lines
      const lines = partial.split('\n');
      partial = lines.pop() || ''; // Keep incomplete line
      
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content;
          if (!token) continue;
          
          fullText += token;
          sentenceBuffer += token;
          
          // Check for sentence boundaries in the buffer
          let match;
          while ((match = SENTENCE_BOUNDARY.exec(sentenceBuffer)) !== null) {
            const sentenceEnd = match.index + match[1].length;
            const sentence = sentenceBuffer.slice(0, sentenceEnd).trim();
            sentenceBuffer = sentenceBuffer.slice(sentenceEnd).trimStart();
            
            if (sentence.length >= MIN_SENTENCE_LENGTH) {
              const cleanSentence = trimForVoice(sentence);
              if (cleanSentence) {
                await onSentence(cleanSentence);
              }
            } else {
              // Too short — prepend back to buffer
              sentenceBuffer = sentence + ' ' + sentenceBuffer;
            }
          }
        } catch {
          // Skip malformed JSON chunks (tool-use, etc.)
        }
      }
    }
    
    // Flush remaining buffer
    if (sentenceBuffer.trim().length > 0) {
      const cleanRemaining = trimForVoice(sentenceBuffer.trim());
      if (cleanRemaining) {
        await onSentence(cleanRemaining);
      }
    }
    
    return { text: trimForVoice(fullText), fullText, controller };
    
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Stream aborted (barge-in or disconnect)');
      return { text: '', fullText: '', controller };
    }
    console.error('Gateway streaming failed:', err.message);
    throw err;
  }
}

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
    
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'anthropic/claude-opus-4-6',  // Opus for voice
        messages,
        max_tokens: 8192,
        user: SESSION_USER,
      }),
    });
    
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
    console.error('Gateway failed:', err.message);
    return { text: "I'm having trouble connecting right now. Try again?" };
  }
}
