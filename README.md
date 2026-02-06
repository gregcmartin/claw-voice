# Building Jarvis: A Real-Time AI Voice Assistant

> 🚀 **DEPLOYED & OPERATIONAL** (Updated: Feb 6, 2026)
> 
> **Status:**
> - Voice bot online in Discord
> - Routes through Clawdbot Gateway — full tool access (email, calendar, team tools, web search, databases, etc.)
> - Intelligent model routing (balanced default, advanced on request)
> - Configurable wake word with 60-second conversation window
> - Smart barge-in: 1.5s threshold, prevents echo cutoff
> - Streaming TTS: Sentence-level chunking, 60% faster time-to-first-word
> - Running as systemd service — auto-restart, boot persistence

Most voice assistants are glorified search bars. You ask a question, you get an answer. But what if your voice assistant could check your email, post to team channels, search the web, manage your calendar, and query your databases — all through natural speech in a Discord voice channel?

That's what we built. And the secret isn't in the voice pipeline — it's that the brain behind it is **Clawdbot**, a full AI agent with extensive tool integrations via the Model Context Protocol (MCP).

## Architecture

The voice bot is a **thin voice I/O layer** — it's literally just a microphone and speaker wired to the Clawdbot gateway agent:

```
Discord Voice (user speaks)
  → Opus decode
  → Whisper STT
  → Clawdbot Gateway (same agent as Discord text/Slack/WhatsApp)
  → Edge TTS (free)
  → Discord Voice playback
```

**Key insight:** The voice bot doesn't run its own AI. It routes through Clawdbot's gateway, which has the full agent personality, tools, and MCP integrations. When you say "check my email", it actually checks your email using the same tools the text agent uses.

This means:
- Any new capability added to Clawdbot is **instantly available by voice**
- Shared memory and context across all communication channels
- Full MCP tool access (email, calendars, project management, databases, threat intelligence, etc.)
- No duplicate logic — voice is just a different input/output modality

## Features

✅ **Streaming TTS** — Sentence-level chunking. First sentence plays immediately (60% faster time-to-first-word)  
✅ **Wake Word** — "Jarvis" detection with 60s conversation window (no wake word needed during active conversation)  
✅ **Smart Barge-In** — 1.5s sustained speech threshold to interrupt, ignores echo/blips  
✅ **Context-Aware Acks** — Personality-appropriate acknowledgments or silence based on what you said  
✅ **Full Agent Access** — All Clawdbot capabilities available by voice (email, calendar, web search, project tools, team channels, etc.)  
✅ **Processing Lock** — Prevents audio pipeline collisions  
✅ **Model Routing** — Keywords trigger different models (advanced for deep reasoning, default for balanced work)  
✅ **Auto-Restart** — Systemd service keeps it running  
✅ **Alert System** — External alerts via webhook → text notification + voice briefing on join (see [ALERTS.md](ALERTS.md))  

## The Pipeline

Here's what happens end-to-end when you speak:

1. **Discord voice channel** captures your audio as Opus-encoded frames
2. **opus-decoder.js** converts Opus → raw PCM
3. **stt.js** sends PCM to Whisper API → text transcript
4. **wakeword.js** checks for wake word (if enabled), manages 60s conversation window
5. **brain.js** routes transcript to **Clawdbot Gateway**
   - Gateway runs the full agent with tools, MCP integrations, memory, etc.
   - Returns text response (and any side-effects like sending emails, posting to channels, etc.)
6. **tts.js** synthesizes response to audio (Edge TTS, free)
7. **index.js** plays audio back to Discord voice channel

### The Killer Feature: Clawdbot Gateway Integration

While the bot plays audio, it monitors for user speech. Short blips (<1.5s) are ignored — they're usually echo or background noise. Sustained speech (>1.5s) triggers immediate playback stop. This prevents the bot from talking over you while filtering out false positives.

No generic "processing your request" messages. The system analyzes the transcript and plays Jarvis-style acks: "Checking now, sir", "One moment", or silence for greetings and quick questions that don't need a processing indicator.

If the brain takes more than 15 seconds (complex tool calls, multi-step reasoning), the bot plays interim messages like "Still compiling, sir" so you know it hasn't crashed.

### Model Routing

Keywords in your speech trigger different models:
- Say "plan", "deep dive", or "think about" → routes to advanced model for deep reasoning
- Say "analyze" or "research" → uses balanced model for speed/quality
- Default: fast model for snappy, high-quality responses

### TTS: Free & Fast

Microsoft's Edge TTS provides excellent neural voices at zero cost. We use `en-GB-RyanNeural` for a crisp British voice, but you can pick from dozens of voices and languages. OpenAI TTS is available as a fallback.

### Pipeline Safety

A mutex-style lock prevents audio pipeline collisions. If the bot is currently processing one utterance, incoming audio is queued rather than creating race conditions in the STT → Brain → TTS pipeline.

## Setup

### Prerequisites

- Node.js 18+
- Discord bot token (separate from Clawdbot's bot)
- OpenAI API key (for Whisper STT)
- Clawdbot running with gateway
- `edge-tts` installed: `pip install edge-tts`

### Installation

```bash
git clone https://github.com/YOUR_ORG/jarvis-voice.git
cd jarvis-voice
npm install
cp .env.example .env
# Edit .env with your tokens
```

### Discord Bot Setup

Create a new Discord application at https://discord.com/developers/applications

1. Create new application (e.g., "Jarvis Voice")
2. Go to Bot → Reset Token → Copy it
3. Enable "Server Members Intent"
4. Invite to your server with voice permissions:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=36700160&scope=bot
```

Permissions: Connect + Speak + Use Voice Activity

### Environment Variables

`.env` file:

```bash
# Discord
DISCORD_TOKEN=your_voice_bot_token
DISCORD_GUILD_ID=your_guild_id
DISCORD_VOICE_CHANNEL_ID=your_voice_channel_id
ALLOWED_USERS=user_id_1,user_id_2

# OpenAI (Whisper STT)
OPENAI_API_KEY=your_openai_key

# TTS
TTS_PROVIDER=edge
EDGE_TTS_VOICE=en-GB-RyanNeural
EDGE_TTS_PATH=$HOME/.local/bin/edge-tts

# Clawdbot Gateway
CLAWDBOT_GATEWAY_URL=http://127.0.0.1:22100
CLAWDBOT_GATEWAY_TOKEN=your_gateway_token

# Wake Word (optional)
WAKE_WORD_ENABLED=true
WAKE_WORD_PHRASES=jarvis,hey jarvis
CONVERSATION_WINDOW_MS=60000

# Streaming TTS
STREAMING_TTS_ENABLED=true
```

## Running

### Systemd Service (Recommended)

The voice bot runs as a systemd service:

```bash
# Status
sudo systemctl status jarvis-voice

# Start/Stop/Restart
sudo systemctl start jarvis-voice
sudo systemctl stop jarvis-voice
sudo systemctl restart jarvis-voice

# Logs
sudo journalctl -u jarvis-voice.service -f
```

Service file: `/etc/systemd/system/jarvis-voice.service`

### Manual

```bash
cd jarvis-voice
node src/index.js
```

## Usage

### With Wake Word (Enabled)

- **First message**: Say wake word (e.g., "Jarvis") followed by your request: "Jarvis, what time is it?"
- **Within 60s**: Just talk normally — "what about Tokyo?" (no wake word needed)
- **After 60s silence**: Say wake word again to wake it up

Configure wake word phrases in `.env` via `WAKE_WORD_PHRASES`

### Without Wake Word (Disabled)

Join the voice channel and just talk. The bot processes everything.

### Barge-In

While the bot is speaking, talk for >1.5s continuously to interrupt. Short blips are ignored to prevent echo cutoff.

## Cost

- **STT**: OpenAI Whisper ~$0.006/minute
- **TTS**: Edge TTS = **FREE** (Microsoft Neural voices)
- **Brain**: Uses existing Clawdbot agent subscription
- **Total**: ~$0.00036 per interaction (essentially free)

## Voice Persona (Example)

The default configuration uses a Jarvis-style persona (AI butler from Iron Man) — British-inflected, understated competence, dry wit when appropriate. You can customize the persona via the voice prefix in `brain.js`.

Example voice responses using **authentic Iron Man dialogue** as few-shot examples:

**Signature acknowledgments:**
- "At your service, sir."
- "For you sir, always."
- "The render is complete, sir."
- "As you wish, sir."

**Status reports:**
- "Good morning. It's seven AM. The weather in Malibu is seventy two degrees with scattered clouds."
- "The compression in cylinder three appears to be low, sir. I'll note that."
- "We are now running on emergency backup power, sir."

**Gentle observations (dry wit):**
- "Little ostentatious, don't you think? Though I suppose that will help you keep a low profile."
- "A very astute observation, sir."
- "Working on a secret project, are we, sir?"

**Warnings:**
- "Though I feel compelled to note this is inadvisable."
- "Sir, there is a potentially fatal build up occurring."

These examples are embedded in the voice prefix so responses stay authentic to the character.

**To customize the persona:** Edit the `voicePrefix` in `src/brain.js` to match your desired personality and use case.

## Available Voices

Edge TTS British voices:

- `en-GB-RyanNeural` (default) — Male, crisp, warm
- `en-GB-SoniaNeural` — Female, warm
- `en-GB-ThomasNeural` — Male, authoritative
- `en-GB-LibbyNeural` — Female, professional

Change via `EDGE_TTS_VOICE` in `.env`

## Technical Details

### Module 1: stt.js — Speech-to-Text

The simplest module. Takes a WAV file path, sends it to OpenAI Whisper, returns text. The prompt parameter is crucial — it primes Whisper with domain-specific vocabulary to improve accuracy.

### Module 2: tts.js — Text-to-Speech

Uses Edge TTS (free Microsoft Neural voices) as the primary engine, with OpenAI TTS as a fallback. Edge TTS runs as a Python subprocess — it's a pip package that streams audio from Microsoft's edge services.

### Module 3: brain.js — Clawdbot Gateway Integration

This is where the magic happens. Instead of running a local LLM or making direct API calls, the voice bot routes everything through Clawdbot's gateway. This means the voice assistant inherits ALL of Clawdbot's capabilities — every MCP tool, every integration, full conversation history.

The brain module:
- Detects model routing keywords (plan/analyze/deep dive → advanced model)
- Routes to Clawdbot Gateway (configurable URL, default: `http://127.0.0.1:22100`)
- Handles cross-channel output detection (prevents duplicate responses)
- Manages voice-optimized system prompt with customizable persona

### Module 4: opus-decoder.js — Audio Decoding

Discord sends audio as Opus-encoded frames. This module transforms them into raw PCM that Whisper can consume. Simple but essential — get this wrong and you get garbage transcriptions.

### Module 5: index.js — The Main Orchestrator

This is the largest module — it wires everything together:
- Discord connection and voice channel management
- Audio recording and buffering
- Wake word detection
- Smart barge-in logic
- Streaming TTS playback
- Processing lock to prevent collisions
- Context-aware acknowledgments

### Streaming TTS Implementation

Long responses are split into sentences and synthesized in parallel:

1. Split response at `. ` `! ` `? ` boundaries
2. Synthesize first sentence immediately → play
3. Synthesize remaining sentences in parallel and queue
4. Play sentences back-to-back with no gaps

Result: First audio plays in ~2s instead of 5-10s for full synthesis. 60% improvement in perceived responsiveness.

### Wake Word Detection

Uses existing Whisper transcription — zero new dependencies:

1. Always transcribe with Whisper (already needed for STT)
2. Check transcript for "jarvis" / "hey jarvis" at the start
3. If found → strip wake word, process request
4. If not found → ignore
5. After bot responds → 60s conversation window (no wake word needed)

No separate wake word engine required. Clean and simple.

## Dependencies

Install with:

```bash
npm install discord.js
npm install @discordjs/voice
npm install @discordjs/opus
npm install sodium-native
npm install prism-media
npm install openai
npm install axios
npm install dotenv
```

Python requirement:
```bash
pip install edge-tts
```

## Troubleshooting

### Bot joins but doesn't respond

- Check wake word is disabled OR you're saying "Jarvis" at the start
- Check `ALLOWED_USERS` includes your Discord user ID
- Verify Clawdbot gateway is running: `curl http://127.0.0.1:22100/health`

### Audio cuts out or overlaps

- Restart the service: `sudo systemctl restart jarvis-voice`
- Check logs: `sudo journalctl -u jarvis-voice.service -n 50`

### Can't access web / tools

- Voice bot routes through Clawdbot — ensure Clawdbot gateway is running
- Check `CLAWDBOT_GATEWAY_URL` and `CLAWDBOT_GATEWAY_TOKEN` in `.env`
- Test gateway: `curl http://127.0.0.1:22100/health`

### Wake word not working

- Set `WAKE_WORD_ENABLED=true` in `.env`
- Verify `WAKE_WORD_PHRASES` includes your chosen wake word
- Restart: `sudo systemctl restart jarvis-voice`
- Say wake word clearly at the START of your message
- Check logs for wake word detection: `sudo journalctl -u jarvis-voice.service -f | grep -i "wake"`

## Development

```bash
# Watch mode (auto-restart on changes)
npm run dev

# Syntax check
node --check src/index.js

# Test STT
node src/stt.js test_audio.wav

# Test TTS
node src/tts.js "Hello, this is a test"
```

## Files

- `src/index.js` — Main orchestrator (Discord, audio queue, barge-in, pipeline)
- `src/brain.js` — Gateway integration (~100 lines, thin layer)
- `src/stt.js` — Whisper API wrapper
- `src/tts.js` — Edge TTS + OpenAI TTS
- `src/wakeword.js` — Wake word detection + conversation window
- `src/opus-decoder.js` — Discord audio decoding

## Recent Updates

- **Feb 6, 2026**: Implemented voice model switching (default/advanced routing)
- **Feb 6, 2026**: Optimized latency with trimmed voice prefix
- **Feb 6, 2026**: Fixed wake word behavior (improved response filtering)

## Credits

Built with Clawdbot, Discord.js, OpenAI Whisper, and Edge TTS.

The voice bot is literally just a microphone and speaker. The brain is the same Clawdbot agent you're already using. Same brain, different interface.

## Key Lesson

**DON'T rebuild agent capabilities in the voice bot.** Route through gateway. Voice is just I/O. One brain, many surfaces.

This architecture means:
- New tools? Available by voice immediately.
- Bug fixes in agent logic? Fixed everywhere at once.
- Memory and context? Shared across all channels.
- Cost? Minimal — you're already paying for the agent.

The entire voice layer is ~1000 lines of code. Everything else is handled by the existing agent infrastructure.
