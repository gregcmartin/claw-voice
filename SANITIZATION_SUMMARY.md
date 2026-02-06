# Sanitization Summary

This repository has been sanitized for public release. All personal information, internal project names, and sensitive data have been removed or genericized.

## What Was Changed

### Source Code
- **`src/brain.js`**: 
  - `SESSION_USER` now uses env var instead of hardcoded `jarvis-voice-lance`
  - Discord channel ID now loaded from `DISCORD_CHANNEL_ID` env var
  - All references to "Lance" changed to "the user"
  - Voice prefix now says "personalized to the user" instead of "personalized to Lance"

- **`src/index.js`**:
  - Comments changed from "Lance joined" to "User joined"
  - Voice state update handler genericized

- **`src/intent-classifier.js`**:
  - Example names changed: "Sarah Chen" → "Jane Doe", "Allison" → "Project Manager"
  - Internal project names removed from examples ("Gibson vendor agreement" → "vendor agreement")

- **`src/stt.js`**:
  - Removed company-specific vocabulary corrections (eWitness, Unit 221B)
  - Removed personal names from Deepgram keywords and Whisper prompts

### Documentation
- **Removed internal planning docs** (too much internal context):
  - `PLAN-CHANNEL-MOBILITY.md`
  - `IMPLEMENTATION-SUMMARY.md`
  - `IMPLEMENTATION_COMPLETE.md`
  - `COMPLETION_SUMMARY.md`

- **All markdown files**:
  - Replaced `/home/lj/dev/jarvis-voice` → `./jarvis-voice`
  - Replaced `/home/lj/` → `~/`
  - Replaced "Lance" → "the user"
  - Removed internal project names (ewitness, gibson, redline, block-equity, forensics)
  - Removed organization name (Unit 221B)
  - Replaced Discord channel IDs with `YOUR_CHANNEL_ID` placeholder

- **`.env.example`**:
  - Added `SESSION_USER` configuration
  - Added `DISCORD_CHANNEL_ID` configuration
  - Clarified that these are user-configurable

## Configuration Required

Users must now configure these environment variables:

```bash
# User-specific configuration
SESSION_USER=jarvis-voice-yourname  # Used for session identification
DISCORD_CHANNEL_ID=your_channel_id  # For Discord thread context fetching

# Discord IDs
DISCORD_GUILD_ID=your_guild_id
DISCORD_VOICE_CHANNEL_ID=your_voice_channel_id
ALLOWED_USERS=your_user_id_1,your_user_id_2
```

## Git History

**⚠️ IMPORTANT**: The git commit history still contains pre-sanitization data in commit diffs. Before publishing to a public repository, you should:

1. **Option A: Squash all history** (simplest):
   ```bash
   # Create a new orphan branch with clean history
   git checkout --orphan clean-main
   git add -A
   git commit -m "Initial public release"
   git branch -D main
   git branch -m main
   ```

2. **Option B: Rewrite history with BFG** (preserves commit structure but removes sensitive data):
   ```bash
   # Install BFG Repo Cleaner
   # Then run replacements for sensitive strings
   ```

## Remaining Steps Before Public Release

- [ ] Squash/rewrite git history to remove pre-sanitization commits
- [ ] Update LICENSE year if needed (currently 2025)
- [ ] Review all files one final time for any missed references
- [ ] Test with fresh .env to ensure all env vars are properly documented
- [ ] Consider adding a CODE_OF_CONDUCT.md and CONTRIBUTING.md

## Verification

Run these checks before publishing:

```bash
# Check for remaining personal references in source code
grep -r "Lance\|/home/lj\|Unit 221B" src/ || echo "Source clean!"

# Check for hardcoded Discord IDs
grep -r "1469077140862668" . --exclude-dir=node_modules --exclude-dir=.git || echo "IDs clean!"

# Check for internal project names
grep -r "ewitness\|gibson\|redline\|block-equity" . --exclude-dir=node_modules --exclude-dir=.git || echo "Projects clean!"
```
