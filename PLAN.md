# Jarvis Voice: Clawdbot Integration Plan

## Goal
Make the voice bot work **through Clawdbot** instead of being a standalone app. 
Use Haiku for fast acks, Sonnet for full responses.

---

## Architecture: Two Approaches

### Approach A: Clawdbot Plugin (Ideal - Same Token)
Build a proper Clawdbot extension plugin that adds voice capabilities to the existing Discord gateway connection. No separate bot token needed.

**How it works:**
- Clawdbot already has a `discord.js` Client running (the Discord channel plugin)
- We write a new plugin that hooks into this runtime to add `@discordjs/voice`
- The plugin uses `api.runtime` to get the existing Discord client
- Voice commands go through Clawdbot's session system natively
- All tools, memory, skills automatically available via voice

**Pros:** Single bot, fully integrated, no extra setup
**Cons:** Requires adding `@discordjs/voice` + native deps to Clawdbot's runtime, plugin SDK may not expose the raw Discord.js client object

### Approach B: Sidecar + OpenAI Chat Completions API (Fast Path)
The voice bot runs as a sidecar process, but routes ALL AI through Clawdbot's built-in OpenAI-compatible HTTP API instead of direct Claude calls.

**How it works:**
```
Discord Voice Channel
       ↓ (user speaks)
  Jarvis Voice Bot (sidecar process, own bot token)
       ↓ (Opus decode → WAV)
  OpenAI Whisper STT
       ↓ (transcript text)
  Clawdbot Gateway (http://127.0.0.1:22100/v1/chat/completions)
       ↓ (full Jarvis brain with all tools, memory, skills)
  OpenAI TTS
       ↓ (audio)
  Discord Voice Channel (speaks)
```

- Voice bot handles: Discord voice, audio capture, STT, TTS, playback
- Clawdbot handles: ALL thinking, tool use, memory, context
- Voice bot sends transcripts to `http://127.0.0.1:22100/v1/chat/completions`
- Clawdbot responds with Jarvis personality + full tool access
- Session-keyed for conversation continuity

**Pros:** Works TODAY, voice bot is a thin audio I/O layer, Clawdbot is the brain
**Cons:** Still needs a separate Discord bot token for the voice gateway

---

## Recommendation: Approach B First, Then A

**Phase 1 (Today): Approach B** — Get voice working NOW
- Modify `brain.js` to route through Clawdbot's OpenAI-compatible API
- Enable `gateway.http.endpoints.chatCompletions` in Clawdbot config
- Use Haiku for speed-critical acks, Sonnet for full responses
- Still needs a separate bot token (5 min Discord setup)

**Phase 2 (Later): Approach A** — Full integration
- Build a proper Clawdbot plugin with Discord voice
- Eliminate the separate bot requirement entirely
- Investigate if plugin SDK exposes Discord.js client

---

## Phase 1 Implementation Plan

### Step 1: Enable Clawdbot Chat Completions API
```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

### Step 2: Rewrite brain.js → Use Clawdbot API
```javascript
// Instead of: fetch('https://api.anthropic.com/v1/messages')
// Now:        fetch('http://127.0.0.1:22100/v1/chat/completions')

const CLAWDBOT_URL = 'http://127.0.0.1:22100/v1/chat/completions';
const CLAWDBOT_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;

// For quick acks:
model: "clawdbot:main"  // Uses whatever model the session is on
// + x-clawdbot-session-key for continuity

// For speed: Set voice session to Haiku by default
// Switch to Sonnet for complex requests
```

### Step 3: Smart Model Routing
- **Default (voice):** Haiku — fast, cheap, good for short conversational turns
- **Complex requests:** Sonnet — when user says "plan", "analyze", etc.
- **Keyword detection in transcript:**
  - "plan", "analyze", "explain", "summarize" → Sonnet
  - Everything else → Haiku
- Model sent per-request via the `model` field in the chat completions payload

### Step 4: Voice-Optimized System Prompt
The system prompt sent to Clawdbot includes voice-specific instructions:
- Keep responses SHORT (1-3 sentences)
- No markdown, lists, code blocks
- Conversational speech patterns
- Still Jarvis personality

### Step 5: Session Continuity
- Use `user: "jarvis-voice-lance"` in chat completions for stable session key
- This gives the voice bot its own persistent session in Clawdbot
- Conversation history maintained server-side by Clawdbot (not locally)
- Voice bot becomes stateless — just audio I/O

### Step 6: Tool Access (Free)
Because we're going through Clawdbot's full agent loop:
- "Hey Jarvis, what's on my calendar?" → Clawdbot uses google-workspace MCP
- "Check my email" → Clawdbot searches Gmail
- "What's the weather?" → Clawdbot uses weather skill
- "Remember that I need to..." → Clawdbot stores to haivemind
- All tools, all skills, automatically available via voice

### Step 7: Still Need a Bot Token
The voice bot STILL needs its own Discord bot application because:
- Discord allows only ONE gateway connection per bot token
- Clawdbot already uses the gateway for text
- Voice requires gateway access for WebSocket audio streaming

Quick setup (the user, 5 minutes):
1. https://discord.com/developers/applications → "New Application" → "Jarvis Voice"
2. Bot tab → Reset Token → copy
3. Enable Server Members Intent + Message Content Intent
4. OAuth2 → bot scope → Connect + Speak + Use Voice Activity
5. Invite to server
6. Paste token in `./jarvis-voice/.env`

---

## Model Defaults for Voice

| Scenario | Model | Why |
|----------|-------|-----|
| Normal conversation | Haiku | ~200ms response, cheap, good enough for chat |
| Complex requests | Sonnet | Better reasoning, still fast enough |
| Planning/analysis | Sonnet | Needs deeper thinking |
| Quick acks ("ok", "got it") | Haiku | Speed is everything |

**Response time targets:**
- Haiku path: ~1.5-2.5s total (silence detect + STT + Haiku + TTS)
- Sonnet path: ~2.5-4s total (silence detect + STT + Sonnet + TTS)

---

## Files to Change

1. **`src/brain.js`** — Replace direct Claude API with Clawdbot Chat Completions
2. **`.env.example`** — Update config (remove ANTHROPIC_API_KEY, add CLAWDBOT vars)
3. **Clawdbot config** — Enable chatCompletions endpoint
4. **`src/index.js`** — Minor: Remove local conversation history (Clawdbot handles it)

---

## Future: Phase 2 - Clawdbot Plugin

### Architecture
```
extensions/discord-voice/
├── clawdbot.plugin.json
├── package.json
├── index.ts
└── src/
    ├── voice-manager.ts    # Join/leave/audio handling
    ├── stt.ts              # Whisper integration  
    ├── tts.ts              # OpenAI TTS
    ├── opus-decoder.ts     # Opus → PCM
    └── config.ts           # Voice channel config
```

### Plugin registers:
- Gateway method: `discord-voice.join`, `discord-voice.leave`
- Agent tool: `discord_voice` (join/leave/status)
- Service: auto-join configured channels on startup
- CLI: `clawdbot discord-voice join|leave|status`

### Key question for Phase 2:
Does the Clawdbot plugin SDK expose the raw Discord.js Client instance?
- If yes → easy, just add @discordjs/voice to it
- If no → may need Clawdbot enhancement or a PR

---

## Status
- [ ] Phase 1 Step 1: Enable Chat Completions API
- [ ] Phase 1 Step 2: Rewrite brain.js
- [ ] Phase 1 Step 3: Model routing (Haiku/Sonnet)
- [ ] Phase 1 Step 4: Voice system prompt
- [ ] Phase 1 Step 5: Session continuity
- [ ] Phase 1 Step 6: Test tool access
- [ ] Phase 1 Step 7: Bot token from the user
- [ ] Phase 2: Clawdbot plugin investigation
