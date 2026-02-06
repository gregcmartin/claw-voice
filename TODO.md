# Jarvis Voice — TODO

## ✅ Complete

- [x] Finish Discord voice bot with barge-in
- [x] Edge TTS (free, fast, high-quality)
- [x] Wake word detection (via Whisper, no new deps)
- [x] Conversation window (60s post-response, no wake word)
- [x] Streaming TTS (sentence-by-sentence synthesis)
- [x] ALLOWED_USERS whitelist for security
- [x] Systemd service for persistent operation
- [x] Gateway-routed brain (same agent as text channels)
- [x] Voice prefix for natural spoken responses
- [x] **Voice persona refinement** — authentic Jarvis dialogue from Iron Man films embedded as few-shot examples
- [x] **Film-accurate responses** — pulled dialogue from Iron Man (2008) script for signature phrases

## 🔄 Next Steps

- [ ] **Real-world testing** — use it, tune it, adjust based on actual conversations
- [ ] **Voice tuning** — adjust Edge TTS voice params if needed (pitch, rate, etc.)
- [ ] **Performance monitoring** — track response latency, TTS quality, wake word accuracy

## 🎯 Future Ideas

- [ ] **Multi-user voice profiles** — per-user conversation history and preferences
- [ ] **Voice command shortcuts** — "Jarvis, status" triggers specific reports
- [ ] **Proactive alerts** — bot joins voice channel to deliver urgent notifications
- [ ] **Voice-only channels** — channels where voice is the only interface
- [ ] **Alternative voices** — test different TTS engines (PlayHT, ElevenLabs) for comparison
- [ ] **Context awareness** — remember what was said earlier in the voice session
- [ ] **Ambient mode** — always-on listening with local wake word detection (Porcupine)

## 📝 Notes

**Voice Persona:**
- Uses authentic Iron Man film dialogue as few-shot examples
- British-inflected, understated competence, dry wit
- Signature phrases: "At your service, sir", "For you sir, always", "As you wish"
- Embedded directly in voice prefix for consistent tone

**Architecture:**
- Voice bot is just mic + speaker
- Same Clawdbot agent handles all intelligence
- Full tool access (web search, email, calendar, MCP integrations)
- Zero duplicate logic — voice is just another channel

**Performance:**
- ~2s first audio (streaming TTS)
- ~$0.0005 per interaction (Whisper only cost)
- Edge TTS = FREE (Microsoft Neural voices)
