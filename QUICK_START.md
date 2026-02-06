# Quick Start: New Features

## 🎯 What's New

### ⚡ Streaming TTS (Priority 1)
**Reduces time-to-first-word from 5s → 2s**

The bot now starts speaking the first sentence immediately while synthesizing the rest, instead of waiting for the entire response.

**Status:** ✅ Enabled by default

### 🎤 Wake Word Detection (Priority 2)  
**Reduces false triggers and API costs**

The bot only processes speech that starts with "Jarvis" or other configured wake phrases.

**Status:** ⚠️ Disabled by default (opt-in)

---

## 🚀 Quick Enable/Disable

Edit `./jarvis-voice/.env`:

```bash
# Streaming TTS (already enabled)
STREAMING_TTS_ENABLED=true    # Change to false to disable

# Wake Word Detection (currently disabled)
WAKE_WORD_ENABLED=true        # Change to true to enable
WAKE_WORD_PHRASES=jarvis,hey jarvis,hey travis,yo jarvis
```

After changing `.env`, restart the bot:
```bash
cd ./jarvis-voice
npm start
```

---

## 📊 Expected Behavior

### Streaming TTS Enabled
- **Long response (>100 chars):**  
  First sentence plays within 1-2s, rest queues and plays seamlessly
  
- **Short response (<100 chars):**  
  Uses batch mode (no perceptible difference, already fast)

### Wake Word Enabled
- **"Jarvis, what's the weather?"**  
  → Bot responds: "Yes sir." → Processes command
  
- **"Random conversation"**  
  → Bot ignores (no response, no API call)

- **Wake word stripped from transcript**  
  Brain sees: "what's the weather?" not "Jarvis, what's the weather?"

---

## 🐛 Troubleshooting

### Streaming TTS Issues
**Problem:** Audio sounds choppy or cuts off early  
**Solution:** Set `STREAMING_TTS_ENABLED=false` to revert to batch mode

**Problem:** Long silence before first sentence  
**Solution:** Check TTS provider (Edge TTS should be fast, OpenAI fallback is slower)

### Wake Word Issues
**Problem:** Bot ignores all commands  
**Solution:** Either say "Jarvis" at the start, or set `WAKE_WORD_ENABLED=false`

**Problem:** Wake word not detected  
**Solution:** Check Whisper transcription logs for what it heard. Add misheard variants to `WAKE_WORD_PHRASES`

---

## 📝 Logs to Watch

When testing, look for these log lines:

### Streaming TTS
```
🔊 Streaming TTS (sentence-level chunking)...
📄 Split into 3 sentences
🔊 Playing queued segment 1/3
⏱️  Total pipeline to first audio: 1842ms
```

### Wake Word
```
📝 Raw transcript: "Jarvis what's the weather"
🎯 Wake word detected: "jarvis"
🎵 Playing wake confirmation
📝 Cleaned transcript: "what's the weather"
```

Or if no wake word:
```
📝 Raw transcript: "random conversation"
🚫 No wake word detected in: "random conversation"
⏭️  No wake word, skipping processing
```

---

## 🧪 Test Commands

### Test Streaming TTS
Say a long request to trigger sentence chunking:
> "Jarvis, explain the difference between microservices and monolithic architectures in detail, including the trade-offs and when each is appropriate."

You should hear the first sentence within 2 seconds.

### Test Wake Word
1. Enable: `WAKE_WORD_ENABLED=true`
2. Restart bot
3. Say: **"Jarvis, what time is it?"** → Should respond
4. Say: **"What time is it?"** (no wake word) → Should ignore

---

## 🔄 Rollback

If you need to revert to the old behavior:

```bash
# .env
STREAMING_TTS_ENABLED=false
WAKE_WORD_ENABLED=false
```

Or restore from git:
```bash
cd ./jarvis-voice
git checkout HEAD~1 -- src/
```

---

## 📚 Full Documentation

- **Implementation details:** See `IMPLEMENTATION_SUMMARY.md`
- **Roadmap:** See `TODO.md` (P1 and P2 are marked complete)
- **Configuration:** See `.env.example` or `.env`

---

**Ready to test!** Start the bot with `npm start` and try the new features.
