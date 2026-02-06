# Voice Email Summary Feature

Voice-optimized email inbox summary for Jarvis Voice.

## Concept

When user says "summarize my emails" or "what's in my inbox", Jarvis speaks a quick summary of each email in voice. User can then say "tell me more about [X]" to hear full details of a specific one.

This is DIFFERENT from delegation — this is immediate voice interaction, not background work.

## Intent Types

### SUMMARIZE
**Triggers:**
- "Summarize my emails"
- "Summarize my inbox"
- "What's in my inbox"
- "What's in my email"
- "Check my email"
- "Give me a summary of my emails"
- "Quick rundown of my inbox"

**Behavior:**
- NOT delegated (immediate voice response)
- Fetches recent unread emails via Clawdbot Gateway tools
- Max 5-7 emails spoken
- One sentence per email: "[Sender] about [subject/topic]"
- Ends with: "Want details on any of these?"

**Budget:**
- 8 sentences / 25 seconds max
- Brief, conversational format

### EMAIL_DETAIL
**Triggers (after SUMMARIZE response):**
- "Tell me more about the legal one"
- "Read the third email"
- "More about the first one"
- "What about the urgent one"
- "Details on that email"

**Behavior:**
- Follow-up intent after SUMMARIZE
- Brain uses conversation history to identify which email
- Fetches full email content
- Speaks: sender name, subject, key body points, attachments
- Up to 6 sentences, conversational but thorough

**Budget:**
- 6 sentences / 20 seconds max
- Detailed single-email format

## Implementation

### Files Modified

1. **src/intent-classifier.js**
   - Added SUMMARIZE intent detection
   - Added EMAIL_DETAIL follow-up detection
   - Moved SUMMARIZE checks before DEEP_DIVE to avoid conflicts
   - Added safety check in DEEP_DIVE to redirect email summaries

2. **src/agent-delegate.js**
   - Updated shouldDelegate() to NEVER delegate SUMMARIZE or EMAIL_DETAIL
   - These intents require immediate voice response, not background agents

3. **src/brain.js**
   - No changes needed - voice prefix instructions are injected by intent classifier
   - Brain receives budget instructions via classification.budgetInstruction

## Testing

Run the test suite:

```bash
node test-email-summary.js
```

All tests should pass:
- ✅ Basic summary request
- ✅ Inbox query variations
- ✅ Follow-up numbered reference ("read the third")
- ✅ Follow-up topic reference ("tell me more about the legal one")
- ✅ Follow-up ordinal reference ("more about the first")
- ✅ Generic follow-up (yes/no) still works

## Example Conversations

### Example 1: Basic Summary
```
User: "Jarvis, summarize my emails"
Jarvis: "You have 8 unread. Here's the top 5:
         First: John from sales about Q1 revenue numbers.
         Second: Marketing team about the new campaign launch.
         Third: Legal about contract review - marked urgent.
         Fourth: Newsletter from TechCrunch.
         Fifth: Project Manager about the project-beta project status.
         Want details on any of these?"
```

### Example 2: Follow-up Detail
```
User: "Tell me more about the legal one"
Jarvis: "Legal email from Jane Doe about the project-beta vendor agreement.
         She needs contract review by Friday. Three documents attached:
         master agreement, SOW, and amendment. Marked urgent because
         legal deadline is approaching. Want me to forward it to someone?"
```

### Example 3: Numbered Reference
```
User: "Read the third email"
Jarvis: [reads the legal email in detail]
```

## Error Handling

**No emails found:**
- "Your inbox is empty."

**Email fetch fails:**
- "Couldn't reach your inbox right now."

**Follow-up reference is ambiguous:**
- "Which email? The legal one or the third one?"

## Intent Priority Order

Intent classification happens in this order (first match wins):

1. CHAT (greetings, thanks)
2. EMAIL_DETAIL (if follow-up after SUMMARIZE)
3. FOLLOW_UP (generic continuations)
4. SUMMARIZE (email/inbox summary requests) ← **checked before DEEP_DIVE**
5. ACTION (task commands)
6. LIST_QUERY (listing requests)
7. DEEP_DIVE (detailed explanations)
8. QUERY (general questions)

This order prevents conflicts where broader patterns (like DEEP_DIVE's "summarize") would catch more specific intents.

## Key Design Decisions

### Why Not Delegate?

SUMMARIZE and EMAIL_DETAIL are NOT delegated because:
- Voice interaction expects immediate response
- Summary should be spoken aloud, not posted to text channel
- Conversational flow requires low latency
- Background agents would break the voice UX

### Budget Constraints

The SUMMARIZE intent injects specific budget instructions into the voice prefix:
- Max 5-7 emails spoken
- One sentence per email
- Total max 8 sentences / 25 seconds

This ensures the brain formats output correctly for TTS without excessive narration.

### Context Retention

Conversation history preserves the summary so follow-up requests work:
- "tell me more about X" → brain resolves from history
- "read the third email" → brain knows which was third
- Works because conv.depth and responseType are tracked

## Future Enhancements

Potential improvements:
- Multi-turn drill-down ("tell me more about the second attachment")
- Filter requests ("show me urgent emails only")
- Action requests ("archive the first three")
- Integration with calendar for meeting-related emails

## Debugging

Enable debug output in test script or live usage:

```javascript
console.log('🎯 Intent:', classification.type);
console.log('📊 Budget:', classification.maxSentences, 'sentences');
console.log('🔀 Delegate:', shouldDelegate(transcript, classification.type));
```

## Related Files

- `src/intent-classifier.js` - Intent detection and budget logic
- `src/agent-delegate.js` - Delegation decision logic
- `src/brain.js` - Voice prefix injection (no changes)
- `test-email-summary.js` - Test suite

## Author

Implemented by Clawdbot subagent for Jarvis Voice project.
Date: 2025
