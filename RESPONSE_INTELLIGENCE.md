# Response Intelligence System

## Overview

The Jarvis Voice Bot now has a **dynamic response intelligence system** that adapts response length and style based on user intent, speech duration, and conversation context. This solves the critical UX problem where the bot was too verbose for simple commands.

## The Problem

Before this system:
- "Clean my inbox" → 25 TTS segments over 3 minutes of narration
- No adaptation to context (brief command vs detailed question)
- User frustration from excessive verbosity on simple tasks

After this system:
- "Clean my inbox" → "Done. Archived 34 emails, 5 need attention. Want the rundown?" (15 seconds)
- Automatic adaptation based on intent classification
- Maintains detail for requests that need it ("explain", "analyze", etc.)

## Architecture

### 1. Intent Classifier (`src/intent-classifier.js`)

A pure, synchronous classifier that analyzes speech BEFORE the brain call and determines:
- **Intent type** (ACTION, QUERY, DEEP_DIVE, CHAT, FOLLOW_UP, LIST_QUERY)
- **Response budget** (max sentences, max spoken seconds)
- **Response style** (brief-confirm, concise-answer, detailed, conversational, etc.)
- **Spillover behavior** (whether to offer text channel fallback for long responses)
- **Budget instruction** (the key constraint injected into the voice prefix)

**Input signals:**
- `transcript` — user's words
- `speechDurationMs` — how long they spoke
- `conversationDepth` — number of turns in current conversation
- `isFollowUp` — whether inside conversation window
- `previousResponseType` — what kind of response we gave last

### 2. Intent Types & Examples

| Intent | Trigger Words | Budget | Example Response |
|--------|--------------|--------|------------------|
| **ACTION** | clean, send, post, archive, delete, schedule | 3 sentences, 15s | "Done. Archived 34 emails, 5 need attention. Want the rundown?" |
| **QUERY** | what, when, where, how many, is there | 4 sentences, 12s | "Yes, 2 meetings today. 2pm standup and 4pm review. Both in conference room A." |
| **LIST_QUERY** | show me, list, what's on | 4 sentences, 15s | "You have 12 unread. Top 3: [item], [item], [item]. Plus 9 more. Want the full list in text?" |
| **DEEP_DIVE** | explain, analyze, walk me through | 8 sentences, 30s | Full explanation with option to post detailed analysis to text |
| **CHAT** | hello, thanks, hey | 2 sentences, 5s | "Hey! Ready when you are." |
| **FOLLOW_UP** | yes, no, the first one, more | Matches previous | Continues context from last response |

### 3. Duration-Based Adjustments

The classifier also considers speech duration:
- **< 3s** → Tighten budget (probably quick command)
- **3-8s** → Moderate budget
- **8-15s** → User is explaining, allow more detail
- **> 15s** → User is thorough, match with thorough response

### 4. Integration Points

**In `brain.js`:**
- Imports classifier
- Calls `classifyIntent()` with signals
- Injects budget instruction into voice prefix
- Returns response type for conversation tracking

**In `index.js`:**
- Tracks conversation depth per user
- Calculates speech duration from audio buffer
- Passes classification signals to brain
- Increments depth each turn
- Resets depth when conversation window expires

**Conversation tracking:**
```javascript
conversations.set(userId, { 
  history: [],           // Message history
  depth: 0,              // Number of turns
  lastResponseType: null // For follow-up context
});
```

## Key Principle

**The voice prefix is the ONLY lever we have to control response length.**

The brain is a full Clawdbot agent with tools. We can't control what it does internally — but we CAN control how it formats the spoken output by making the budget instruction clear, authoritative, and positioned as a hard constraint in the prefix.

Example budget instruction for ACTION:
```
RESPONSE BUDGET: Action task. Do the work silently. Confirm in ≤3 sentences. 
Never narrate your process. Just: what you did, the key result, and one 
follow-up offer if relevant.
```

## Spillover Mechanism

For complex responses that exceed the voice budget, the system adds spillover instructions:

```
If your full response exceeds the budget, compress for voice and end with 
"I've posted the full details in the text channel." Then actually post 
the full version using the message tool.
```

This gives users:
- Quick voice confirmation (15s)
- Full details in text if needed
- Best of both worlds

## Testing

Run the classifier tests:
```bash
node test-classifier.js
```

Tests cover all intent types, edge cases, and duration-based adjustments.

## Usage

The system works automatically — no configuration needed. Just speak naturally:

- "Clean my inbox" → Brief confirmation
- "What emails do I have" → Concise summary
- "Show me my calendar" → Top items + offer full list
- "Explain how kubernetes works" → Detailed explanation
- "Yes" (follow-up) → Continues previous context

## Future Enhancements

Possible improvements:
- Machine learning classification (vs rule-based)
- User-specific budget preferences
- Time-of-day adjustments (more verbose in morning standup, brief during focus time)
- Sentiment analysis for urgency detection
- Multi-turn conversation flow optimization

## Metrics to Track

- Average response length by intent type
- User barge-in rate (indicator of too-long responses)
- Spillover usage rate (how often users request full details)
- Conversation depth distribution
- Speech duration vs response length correlation
