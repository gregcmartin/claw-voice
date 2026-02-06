/**
 * Intent Classifier - Dynamic Response Intelligence
 * 
 * Analyzes user speech to determine intent type and response budget.
 * Runs BEFORE the brain call to inject adaptive constraints into the voice prefix.
 * 
 * The core insight: we can't control what the brain does internally,
 * but we CAN control how it formats the spoken output by making the
 * budget instruction clear, authoritative, and positioned as a hard constraint.
 */

/**
 * Classify user intent and determine response budget
 * 
 * @param {Object} signals - Input signals for classification
 * @param {string} signals.transcript - The user's words
 * @param {number} signals.speechDurationMs - How long they spoke
 * @param {number} signals.conversationDepth - Number of turns in current conversation
 * @param {boolean} signals.isFollowUp - Whether inside conversation window
 * @param {string|null} signals.previousResponseType - What kind of response we gave last
 * 
 * @returns {Object} Classification result with budget instructions
 */
export function classifyIntent(signals) {
  const {
    transcript,
    speechDurationMs = 0,
    conversationDepth = 0,
    isFollowUp = false,
    previousResponseType = null,
  } = signals;
  
  const lower = transcript.toLowerCase();
  const wordCount = transcript.split(/\s+/).length;
  
  // ── Intent Detection ────────────────────────────────────────────────
  
  // CHAT - Greetings, small talk, short responses (only if brief/standalone)
  if (lower.match(/^(hello|hey|hi|good morning|good evening|yo|sup|what's up|how are you|thanks|thank you|cheers|appreciated|nice|cool|great|awesome)(\s|$)/) ||
      (lower.match(/^(ok|okay|sure|alright)(\s|$)/) && wordCount <= 3)) {
    return buildBudget('CHAT', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'conversational',
      spillover: false,
      budgetInstruction: 'RESPONSE BUDGET: Casual exchange. Match their energy. 1-2 sentences max. Be warm but brief.',
    });
  }
  
  // EMAIL_DETAIL - Follow-up detail request after SUMMARIZE
  // Check this BEFORE general FOLLOW_UP to avoid conflicts
  if (isFollowUp && previousResponseType === 'SUMMARIZE') {
    // Detect references to specific emails from the summary
    // Patterns: "read the third", "tell me more about the legal one", "more about first one", "what about urgent"
    if ((lower.match(/\b(tell me|read|details|detail|what about|open)\b/) || lower.includes('more')) &&
        (lower.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|one|email)\b/) ||
         lower.match(/\b(legal|urgent|marketing|sales|newsletter|contract|review|project|that|about)\b/))) {
      return buildBudget('EMAIL_DETAIL', {
        maxSentences: 6,
        maxSpokenSeconds: 20,
        responseStyle: 'detailed-single',
        spillover: false,
        budgetInstruction: 'EMAIL DETAIL MODE: User wants full details on a specific email from the previous summary. Instructions: 1. Identify which email they\'re referring to using conversation context. 2. Fetch the full email content. 3. Speak: sender name, subject, key points from body, and any attachments. 4. Keep it conversational but thorough - up to 6 sentences. Example: "Legal email from Jane Doe about the vendor agreement. She needs contract review by Friday. Three documents attached: master agreement, SOW, and amendment. Marked urgent because legal deadline is approaching. Want me to forward it to someone?"',
      });
    }
  }
  
  // FOLLOW_UP - Continuation phrases
  if (isFollowUp && lower.match(/^(yes|yeah|yep|yup|no|nope|nah|go ahead|do it|proceed|continue|the first one|first one|second one|that one|more|tell me more|anything else|what else)/)) {
    // Match the previous response style
    const prevStyle = previousResponseType || 'QUERY';
    const maxSentences = prevStyle === 'DEEP_DIVE' ? 6 : prevStyle === 'LIST_QUERY' ? 4 : 3;
    
    return buildBudget('FOLLOW_UP', {
      maxSentences,
      maxSpokenSeconds: prevStyle === 'DEEP_DIVE' ? 20 : 10,
      responseStyle: 'continuation',
      spillover: prevStyle === 'DEEP_DIVE',
      budgetInstruction: `RESPONSE BUDGET: Continuation. Match the detail level of what came before (previous was ${prevStyle}). If they said 'yes' to an offer, deliver concisely. If they want 'more', provide the next level of detail.`,
    });
  }
  
  // SUMMARIZE - Email/inbox summary requests (voice-optimized, NOT delegated)
  // Check this BEFORE ACTION and DEEP_DIVE to avoid conflicts
  if (lower.match(/\b(summarize|summary|quick rundown)\b/) && 
      lower.match(/\b(emails?|inbox|messages?)\b/)) {
    return buildBudget('SUMMARIZE', {
      maxSentences: 8,
      maxSpokenSeconds: 25,
      responseStyle: 'brief-summary',
      spillover: false,
      budgetInstruction: 'VOICE SUMMARY MODE: Email inbox summary requested. Instructions: 1. Fetch recent unread emails (use email/calendar tools). 2. For each email, provide ONE sentence: "[Sender] about [subject/topic]". 3. Max 5-7 emails spoken. 4. End with: "Want details on any of these?". 5. Keep it BRIEF - one sentence per email, no elaboration. Example output: "You have 8 unread. Here\'s the top 5: First: John from sales about Q1 revenue numbers. Second: Marketing team about the new campaign launch. Third: Legal about contract review - marked urgent. Fourth: Newsletter from TechCrunch. Fifth: Project manager about project status. Want details on any of these?"',
    });
  }
  
  // Check for inbox queries without "summarize" keyword
  if (lower.match(/\b(what's in my|what is in my|check my)\b/) && 
      lower.match(/\b(emails?|inbox)\b/)) {
    return buildBudget('SUMMARIZE', {
      maxSentences: 8,
      maxSpokenSeconds: 25,
      responseStyle: 'brief-summary',
      spillover: false,
      budgetInstruction: 'VOICE SUMMARY MODE: Email inbox summary requested. Instructions: 1. Fetch recent unread emails (use email/calendar tools). 2. For each email, provide ONE sentence: "[Sender] about [subject/topic]". 3. Max 5-7 emails spoken. 4. End with: "Want details on any of these?". 5. Keep it BRIEF - one sentence per email, no elaboration. Example output: "You have 8 unread. Here\'s the top 5: First: John from sales about Q1 revenue numbers. Second: Marketing team about the new campaign launch. Third: Legal about contract review - marked urgent. Fourth: Newsletter from TechCrunch. Fifth: Project manager about project status. Want details on any of these?"',
    });
  }
  
  // QUERY - Information requests (check BEFORE ACTION to catch questions with action verbs)
  if (lower.match(/\b(what|when|where|who|which|how many|how much|is there|do i have|did|does|can you|could you|would you|any|find)\b/) ||
      lower.match(/\?$/)) {  // Also check for question mark at end
    return buildBudget('QUERY', {
      maxSentences: 4,
      maxSpokenSeconds: 12,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'RESPONSE BUDGET: Direct query. Answer in ≤4 sentences. Lead with the answer, not "Let me check." If listing items, max 3 spoken, then say how many more and offer details. Example: "Yes, 2 meetings today. 2pm standup and 4pm review. Both in conference room A."',
    });
  }
  
  // ACTION - Task execution commands
  if (lower.match(/\b(clean|archive|delete|remove|send|post|message|move|schedule|remind|set up|create|add|update|cancel|clear|mark|flag|snooze|forward|reply|draft|setup|configure|install|deploy|run|execute|start|stop|restart|kill|check out|clone|pull|push|commit|merge)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 15,
      responseStyle: 'brief-confirm',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Action task. Do the work silently. Confirm in ≤3 sentences. Never narrate your process. Just: what you did, the key result, and one follow-up offer if relevant. Example: "Done. Archived 34 emails, 5 need attention. Want the rundown?"',
    });
  }
  
  // LIST_QUERY - Listing/enumeration requests
  if (lower.match(/\b(list|show me|what's on|what are|tell me about my|give me)\b/) && 
      lower.match(/\b(emails?|messages?|threads?|calendar|events?|meetings?|tasks?|reminders?|notifications?|channels?|servers?|files?|documents?)\b/)) {
    return buildBudget('LIST_QUERY', {
      maxSentences: 4,
      maxSpokenSeconds: 15,
      responseStyle: 'summary-list',
      spillover: true,
      spilloverHint: 'post full list to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: List query. State the count first. Speak top 3-5 items max. If more exist, say "plus N more" and offer to post full list to text. Never read an entire list aloud. Example: "You have 12 unread. Top 3: [item], [item], [item]. Plus 9 more. Want the full list in text?"',
    });
  }
  
  // DEEP_DIVE - Detailed explanation requests
  // NOTE: "summarize" is in this pattern BUT we check SUMMARIZE intent first, so email/inbox summarize won't reach here
  if (lower.match(/\b(explain|walk me through|tell me about|break down|analyze|deep dive|how does|why does|what's the difference|compare|what happened|investigate|research|look into|review|summarize|give me the full|detailed|thorough)\b/)) {
    // Skip if this is an email/inbox summarize (should have been caught by SUMMARIZE intent earlier)
    if (lower.match(/\b(emails?|inbox|messages?)\b/) && lower.match(/\b(summarize|summary)\b/)) {
      // This shouldn't happen if SUMMARIZE is checked first, but as a safety net, re-classify as SUMMARIZE
      return buildBudget('SUMMARIZE', {
        maxSentences: 8,
        maxSpokenSeconds: 25,
        responseStyle: 'brief-summary',
        spillover: false,
        budgetInstruction: 'VOICE SUMMARY MODE: Email inbox summary requested. Instructions: 1. Fetch recent unread emails (use email/calendar tools). 2. For each email, provide ONE sentence: "[Sender] about [subject/topic]". 3. Max 5-7 emails spoken. 4. End with: "Want details on any of these?". 5. Keep it BRIEF - one sentence per email, no elaboration. Example output: "You have 8 unread. Here\'s the top 5: First: John from sales about Q1 revenue numbers. Second: Marketing team about the new campaign launch. Third: Legal about contract review - marked urgent. Fourth: Newsletter from TechCrunch. Fifth: Project manager about project status. Want details on any of these?"',
      });
    }
    
    return buildBudget('DEEP_DIVE', {
      maxSentences: 8,
      maxSpokenSeconds: 30,
      responseStyle: 'detailed',
      spillover: true,
      spilloverHint: 'post full analysis to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Detail requested. Up to 8 sentences OK. Be thorough but still conversational. If very complex, give the verbal summary and offer to post the full analysis to text. Lead with the key insight, then supporting details.',
    });
  }
  
  // ── Duration-Based Adjustments ──────────────────────────────────────
  
  // If speech was very short (<3s), tighten the budget (probably quick command)
  if (speechDurationMs < 3000) {
    return buildBudget('QUERY', {
      maxSentences: 3,
      maxSpokenSeconds: 8,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'RESPONSE BUDGET: Quick query. Very brief response. ≤3 sentences. Lead with the answer.',
    });
  }
  
  // If speech was long (>15s), user is being thorough - allow more detail
  if (speechDurationMs > 15000) {
    return buildBudget('QUERY', {
      maxSentences: 6,
      maxSpokenSeconds: 20,
      responseStyle: 'detailed',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Thorough question. Match their detail level. Up to 6 sentences spoken. If answer is complex, summarize verbally and offer to post full details to text.',
    });
  }
  
  // Default: moderate query
  return buildBudget('QUERY', {
    maxSentences: 4,
    maxSpokenSeconds: 12,
    responseStyle: 'concise-answer',
    spillover: false,
    budgetInstruction: 'RESPONSE BUDGET: Standard query. Answer in ≤4 sentences. Be direct and clear.',
  });
}

/**
 * Build a budget response object
 * @private
 */
function buildBudget(type, options) {
  return {
    type,
    maxSentences: options.maxSentences || 4,
    maxSpokenSeconds: options.maxSpokenSeconds || 12,
    responseStyle: options.responseStyle || 'concise-answer',
    spillover: options.spillover || false,
    spilloverHint: options.spilloverHint || null,
    budgetInstruction: options.budgetInstruction,
  };
}
