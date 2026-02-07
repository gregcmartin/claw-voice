/**
 * Intent Classifier - Dynamic Response Intelligence
 * 
 * Analyzes user speech to determine intent type and response budget.
 * Runs BEFORE the brain call to inject adaptive constraints into the voice prefix.
 * 
 * The core insight: we can't control what the brain does internally,
 * but we CAN control how it formats the spoken output by making the
 * budget instruction clear, authoritative, and positioned as a hard constraint.
 * 
 * Intent priority order (first match wins):
 *   1. ADMIN_CMD     - Model switching, exec, memory, meta commands
 *   2. CHAT          - Greetings, small talk
 *   3. EMAIL_DETAIL  - Follow-up on specific email after SUMMARIZE
 *   4. FOLLOW_UP     - Continuation phrases
 *   5. EMAIL_SUMMARY - Inbox summary requests
 *   6. EMAIL_ACTION  - Reply, forward, compose, flag emails
 *   7. EMAIL_QUERY   - Questions about specific emails
 *   8. CALENDAR      - Calendar queries and actions
 *   9. MEMORY_CMD    - Remember/recall commands
 *  10. PLAN_CMD      - Planning/todo commands
 *  11. STUDY_CMD     - Deep research/study commands
 *  12. QUERY         - General information requests
 *  13. ACTION        - Task execution (expanded verb list)
 *  14. LIST_QUERY    - Listing/enumeration
 *  15. DEEP_DIVE     - Detailed explanations
 *  16. Duration-based fallback
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
  
  // ── 1. ADMIN_CMD - Model switching, exec, meta commands ─────────────
  // These are high-priority overrides — must be checked first
  
  // Model switching: "use opus", "switch to sonnet", "use haiku"
  if (lower.match(/\b(use|switch to|change to|go to)\s+(opus|sonnet|haiku|advanced|basic|default)\b/)) {
    return buildBudget('ADMIN_CMD', {
      maxSentences: 1,
      maxSpokenSeconds: 3,
      responseStyle: 'ack',
      spillover: false,
      budgetInstruction: 'ADMIN COMMAND: Model switch requested. Switch the model, then confirm in ONE sentence. Example: "Switched to Opus." Do NOT explain what the model is or what it does.',
      meta: { action: 'model_switch' },
    });
  }
  
  // Exec/shell commands: "exec [command]", "run command [x]"
  if (lower.match(/^exec\s/) || lower.match(/\b(run command|execute command|shell|terminal|bash)\b/)) {
    return buildBudget('ADMIN_CMD', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'post command output to Discord text',
      budgetInstruction: 'ADMIN COMMAND: Shell/exec command. Execute silently, confirm result in 1-2 sentences. Post full output to text channel. Example: "Done. Service restarted, no errors." Never read command output aloud.',
      meta: { action: 'exec' },
    });
  }
  
  // Admin commands: "admin [x]", "config [x]", "restart [service]"
  if (lower.match(/^admin\s/) || lower.match(/\b(gateway config|clawdbot config|restart gateway|restart service|check status|system status|health check|update clawdbot)\b/)) {
    return buildBudget('ADMIN_CMD', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'ADMIN COMMAND: System administration task. Execute the command, confirm result briefly. Post full details to text if verbose output. Example: "Gateway restarted. All services healthy."',
      meta: { action: 'admin' },
    });
  }
  
  // Self-reflect: "self reflect", "reflect on [x]"
  if (lower.match(/\b(self reflect|reflect on|optimize|what did we learn|lessons learned)\b/)) {
    return buildBudget('ADMIN_CMD', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'post reflection to Discord text',
      budgetInstruction: 'ADMIN COMMAND: Self-reflection requested. Use the self-reflect skill. Acknowledge briefly in voice, post full reflection to text. Example: "Reflecting on that now. I\'ll post the analysis to text."',
      meta: { action: 'self_reflect' },
    });
  }
  
  // ── 1b. NOTIFY_DELEGATE - "let me know when done" / "DM me" / async task patterns
  // These ALWAYS force delegation to background agent + DM notification
  // Must be checked early — before QUERY swallows them
  if (lower.match(/\b(let me know|notify me|dm me|message me|alert me|ping me|tell me when|text me)\b/) &&
      lower.match(/\b(when|once|after|if|done|ready|finished|complete|available|it's out|it drops)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'DM user when task completes',
      budgetInstruction: 'ASYNC TASK: User wants to be notified when something completes. Acknowledge in 1-2 sentences. Delegate the work to background, then DM user with results when done. Example: "Got it. I\'ll DM you when it\'s ready."',
      meta: { action: 'notify_delegate', forceDelegation: true },
    });
  }

  // "Monitor X" / "keep an eye on" / "watch for" — async monitoring patterns
  if (lower.match(/\b(monitor|keep an eye on|watch for|watch this|keep track|keep watching|stay on top of|follow up on this)\b/) &&
      !lower.match(/^(what|how|is|are|did|does|can)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'DM user when monitoring detects change',
      budgetInstruction: 'MONITOR TASK: User wants ongoing monitoring. Set up the check, store a reminder in haivemind, and DM user when the condition is met. Acknowledge in 1-2 sentences. Example: "Monitoring it. I\'ll DM you when there\'s a change."',
      meta: { action: 'monitor_delegate', forceDelegation: true },
    });
  }

  // "Do X and let me know" / "grab X and DM me" — compound action + notify
  if (lower.match(/\b(and|then)\s+(let me know|notify me|dm me|message me|ping me|tell me)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'DM user when task completes',
      budgetInstruction: 'ASYNC TASK: User wants work done and notification on completion. Do the work in background, DM user when done. Acknowledge in 1-2 sentences. Example: "On it. I\'ll DM you when it\'s done."',
      meta: { action: 'notify_delegate', forceDelegation: true },
    });
  }

  // ── 2. CHAT - Greetings, small talk, short responses ────────────────
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
  
  // ── 3. EMAIL_DETAIL - Follow-up detail request after SUMMARIZE ──────
  if (isFollowUp && previousResponseType === 'SUMMARIZE') {
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
  
  // ── 4. FOLLOW_UP - Continuation phrases ─────────────────────────────
  if (isFollowUp && lower.match(/^(yes|yeah|yep|yup|no|nope|nah|go ahead|do it|proceed|continue|the first one|first one|second one|that one|more|tell me more|anything else|what else)/)) {
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
  
  // ── 5. EMAIL_SUMMARY - Inbox summary requests ───────────────────────
  // Only match broad inbox queries, NOT "any emails from [person]" or "read [specific] email"
  if ((lower.match(/\b(summarize|summary|quick rundown)\b/) && lower.match(/\b(emails?|inbox|messages?)\b/)) ||
      (lower.match(/\b(what's in my|what is in my|check my)\b/) && lower.match(/\b(emails?|inbox)\b/)) ||
      (lower.match(/\b(any (new |urgent |important )?emails?)\b/) && !lower.match(/\b(from|about|regarding)\b/)) ||
      (lower.match(/\b(read my)\b/) && lower.match(/\b(inbox|emails)\b/) && !lower.match(/\b(latest|last|recent|first)\b/))) {
    return buildBudget('SUMMARIZE', {
      maxSentences: 8,
      maxSpokenSeconds: 25,
      responseStyle: 'brief-summary',
      spillover: false,
      budgetInstruction: 'VOICE SUMMARY MODE: Email inbox summary requested. Instructions: 1. Fetch recent unread emails (use google-workspace MCP or GAM). 2. For each email, provide ONE sentence: "[Sender] about [subject/topic]". 3. Max 5-7 emails spoken. 4. End with: "Want details on any of these?". 5. Keep it BRIEF - one sentence per email, no elaboration. Example output: "You have 8 unread. Here\'s the top 5: First: John from sales about Q1 revenue numbers. Second: Marketing team about the new campaign launch. Third: Legal about contract review - marked urgent. Fourth: Newsletter from TechCrunch. Fifth: Project manager about project status. Want details on any of these?"',
    });
  }
  
  // ── 6. EMAIL_ACTION - Reply, forward, compose, flag ─────────────────
  if (lower.match(/\b(reply to|respond to|write back|forward|compose|draft|send an? email|email .+ about|flag|star|mark as|snooze|archive|delete)\b/) &&
      lower.match(/\b(email|message|mail|that|it|this|them)\b/)) {
    return buildBudget('EMAIL_ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 10,
      responseStyle: 'brief-confirm',
      spillover: true,
      spilloverHint: 'post email draft/details to Discord text',
      budgetInstruction: 'EMAIL ACTION: User wants to act on email. Execute the action (reply, forward, compose, flag, etc.). For compose/reply: draft the content and confirm verbally in 1-2 sentences. For flag/archive/delete: do it silently, confirm. Example compose: "I\'ve drafted a reply to Jane about the contract. Want me to send it or post the draft for review?" Example flag: "Done. Flagged as urgent."',
    });
  }
  
  // ── 7. EMAIL_QUERY - Questions about specific emails ────────────────
  if (lower.match(/\b(emails?|messages?|mail)\b/) &&
      (lower.match(/\b(from|about|regarding|subject|did .+ send|did .+ email|have I got)\b/) ||
       lower.match(/\b(what did .+ say|what's .+ email|read .+ email|latest from|read my latest|read my last|read my recent|any .+ from)\b/))) {
    return buildBudget('EMAIL_QUERY', {
      maxSentences: 5,
      maxSpokenSeconds: 15,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'EMAIL QUERY: User asking about specific email(s). Search emails using google-workspace MCP or GAM. Answer concisely: sender, subject, key content. Max 5 sentences. Example: "Yes, you got an email from John at 2pm about the Q1 numbers. He\'s asking for your review by Friday. Three attachments: spreadsheet, deck, and summary."',
    });
  }
  
  // ── 8. CALENDAR - Calendar queries and actions ──────────────────────
  
  // Calendar queries: "what's on my calendar", "next meeting", "am I free at"
  // Also catch standalone availability questions without "calendar" keyword
  if ((lower.match(/\b(calendar|schedule|meetings?|events?|appointments?)\b/) &&
      (lower.match(/\b(what's|what is|do i have|any|show|next|today|tomorrow|this week|tonight|morning|afternoon)\b/) ||
       lower.match(/\b(am i free|am i busy|available at|open at|free at|block off|when is|what time)\b/))) ||
      lower.match(/\b(am i free|am i busy|what's my next meeting|when's my next|do i have any meetings|any meetings)\b/)) {
    return buildBudget('CALENDAR', {
      maxSentences: 5,
      maxSpokenSeconds: 15,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'CALENDAR QUERY: Check calendar using google-workspace MCP. Be specific: time, title, attendees. For "am I free" questions, answer yes/no first, then details. Example: "You have 3 meetings today. 10am standup with engineering, 1pm review with Alain, and 4pm call with the client. You\'re free between 2 and 4." For availability: "Yes, you\'re free at 3pm. Your next meeting is at 4."',
    });
  }
  
  // Calendar actions: "schedule a meeting", "cancel my 3pm", "move my meeting"
  if ((lower.match(/\b(calendar|meeting|event|appointment)\b/) &&
      lower.match(/\b(schedule|book|set up|create|cancel|move|reschedule|postpone|push back|block off|add|invite)\b/)) ||
      (lower.match(/\b(cancel|reschedule|postpone|push back|move)\b/) && lower.match(/\b(my |the )?\d+(pm|am|:\d\d)\b/))) {
    return buildBudget('CALENDAR_ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 10,
      responseStyle: 'brief-confirm',
      spillover: false,
      budgetInstruction: 'CALENDAR ACTION: Create, modify, or cancel a calendar event using google-workspace MCP. Always create with attendees if a person is mentioned. Confirm with time, date, and title. Example: "Done. Meeting with Alain scheduled for Tuesday at 2pm. Calendar invite sent."',
    });
  }
  
  // ── 9. MEMORY_CMD - Remember/recall commands ────────────────────────
  if (lower.match(/\b(remember (this|that)?)\b/) || lower.match(/^remember\s/)) {
    return buildBudget('MEMORY_CMD', {
      maxSentences: 1,
      maxSpokenSeconds: 3,
      responseStyle: 'ack',
      spillover: false,
      budgetInstruction: 'MEMORY STORE: User wants you to remember something. Store it to haivemind immediately and silently. Confirm in ONE sentence. Example: "Got it." Do NOT repeat back what they said or explain where it was stored.',
      meta: { action: 'remember' },
    });
  }
  
  if (lower.match(/\b(recall|do you remember|what did i say about|what was that)\b/)) {
    return buildBudget('MEMORY_CMD', {
      maxSentences: 4,
      maxSpokenSeconds: 12,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'MEMORY RECALL: User wants to recall something. Search haivemind for the relevant memory. Answer concisely with what you found. If nothing found, say so briefly. Example: "Yes, you mentioned the deployment deadline is February 15th."',
      meta: { action: 'recall' },
    });
  }
  
  // ── 10. PLAN_CMD - Planning/todo commands ────────────────────────────
  if (lower.match(/\b(plan|todo|to-do|action items|action plan|put together a plan|break down|task list|prioritize)\b/) &&
      (lower.match(/\b(create|make|build|let's|need|start|new)\b/) || wordCount <= 5)) {
    return buildBudget('PLAN_CMD', {
      maxSentences: 3,
      maxSpokenSeconds: 10,
      responseStyle: 'ack-then-work',
      spillover: true,
      spilloverHint: 'post full plan to Discord text',
      budgetInstruction: 'PLAN MODE: User wants a plan or todo list. Switch to Opus for reasoning. Create the plan, store todo list in haivemind, post full plan to text channel. Voice response: brief summary of what you\'re planning. Example: "Building the plan now. I\'ll break it into phases and post it to text."',
      meta: { action: 'plan' },
    });
  }
  
  // ── 11. STUDY_CMD - Deep research/study commands ────────────────────
  // Only when it's a standalone research request, NOT delegation structures like "I need you to investigate"
  if (lower.match(/\b(study|research|deep dive into|look into|dig into)\b/) &&
      lower.match(/\b(the|this|that|how|why|about)\b/) &&
      !lower.match(/\b(emails?|inbox|messages?)\b/) &&
      !lower.match(/^(i need you to|can you please|go ahead and|let's)/)) {
    return buildBudget('STUDY_CMD', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack-then-work',
      spillover: true,
      spilloverHint: 'post full study/research to Discord text',
      budgetInstruction: 'STUDY MODE: User wants deep research on a topic. Acknowledge briefly, then do the research thoroughly in background. Post full findings to text channel. Voice: brief ack only. Example: "On it. I\'ll research that and post findings to text."',
      meta: { action: 'study' },
    });
  }
  
  // ── 12. QUERY - Information requests ────────────────────────────────
  // Check BEFORE ACTION to catch questions with action verbs
  // But AFTER email/calendar/memory specific queries
  if (lower.match(/\b(what|when|where|who|which|how many|how much|is there|do i have|did|does|can you|could you|would you|any|find|status|how's|how is)\b/) ||
      lower.match(/\?$/)) {
    
    // But NOT if it starts with delegation structures
    if (!lower.match(/^(go ahead|let's|i need you to|can you please|would you mind)/)) {
      return buildBudget('QUERY', {
        maxSentences: 4,
        maxSpokenSeconds: 12,
        responseStyle: 'concise-answer',
        spillover: false,
        budgetInstruction: 'RESPONSE BUDGET: Direct query. Answer in ≤4 sentences. Lead with the answer, not "Let me check." If listing items, max 3 spoken, then say how many more and offer details. Example: "Yes, 2 meetings today. 2pm standup and 4pm review. Both in conference room A."',
      });
    }
  }
  
  // ── 13. ACTION - Task execution commands (expanded) ─────────────────
  // Full verb list from communication pattern study
  if (lower.match(/\b(clean|archive|delete|remove|send|post|message|move|schedule|remind|set up|create|add|update|cancel|clear|mark|flag|snooze|forward|reply|draft|setup|configure|install|deploy|run|execute|start|stop|restart|kill|check out|clone|pull|push|commit|merge|build|implement|migrate|refactor|fix|debug|organize|generate|compile|prepare|test|apply|sync|document|validate|verify|monitor|track|handle|design|schema|write|review and fix|spin up|tear down|provision|bootstrap|scaffold|wire up|hook up|connect|disconnect|enable|disable|activate|deactivate|publish|release|ship|launch|rollback|revert)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 15,
      responseStyle: 'brief-confirm',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Action task. Do the work silently. Confirm in ≤3 sentences. Never narrate your process. Just: what you did, the key result, and one follow-up offer if relevant. Example: "Done. Archived 34 emails, 5 need attention. Want the rundown?"',
    });
  }
  
  // Delegation structures that imply ACTION even without matching a verb above
  if (lower.match(/^(go ahead and|let's |i need you to|can you please|would you mind|take care of|handle |get started on|work on|start working on|begin |continue with|proceed with|follow up on|when you get a chance)/)) {
    return buildBudget('ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 15,
      responseStyle: 'brief-confirm',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Delegated action task. User is assigning work. Do the work silently. Confirm in ≤3 sentences. Never narrate your process. Example: "On it. I\'ll handle that and let you know when it\'s done."',
    });
  }
  
  // ── 14. LIST_QUERY - Listing/enumeration requests ───────────────────
  if (lower.match(/\b(list|show me|what's on|what are|tell me about my|give me)\b/) && 
      lower.match(/\b(emails?|messages?|threads?|calendar|events?|meetings?|tasks?|reminders?|notifications?|channels?|servers?|files?|documents?|repos?|branches|issues?|tickets?|PRs?|pull requests?)\b/)) {
    return buildBudget('LIST_QUERY', {
      maxSentences: 4,
      maxSpokenSeconds: 15,
      responseStyle: 'summary-list',
      spillover: true,
      spilloverHint: 'post full list to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: List query. State the count first. Speak top 3-5 items max. If more exist, say "plus N more" and offer to post full list to text. Never read an entire list aloud. Example: "You have 12 unread. Top 3: [item], [item], [item]. Plus 9 more. Want the full list in text?"',
    });
  }
  
  // ── 15. DEEP_DIVE - Detailed explanation requests ───────────────────
  if (lower.match(/\b(explain|walk me through|tell me about|break down|analyze|deep dive|how does|why does|what's the difference|compare|what happened|investigate|research|look into|review|summarize|give me the full|detailed|thorough)\b/)) {
    // Safety net: email/inbox summarize should have been caught earlier
    if (lower.match(/\b(emails?|inbox|messages?)\b/) && lower.match(/\b(summarize|summary)\b/)) {
      return buildBudget('SUMMARIZE', {
        maxSentences: 8,
        maxSpokenSeconds: 25,
        responseStyle: 'brief-summary',
        spillover: false,
        budgetInstruction: 'VOICE SUMMARY MODE: Email inbox summary requested. Fetch and summarize briefly.',
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
  
  // ── 16. Duration-Based Fallback ─────────────────────────────────────
  
  if (speechDurationMs < 3000) {
    return buildBudget('QUERY', {
      maxSentences: 3,
      maxSpokenSeconds: 8,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'RESPONSE BUDGET: Quick query. Very brief response. ≤3 sentences. Lead with the answer.',
    });
  }
  
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
  const result = {
    type,
    maxSentences: options.maxSentences || 4,
    maxSpokenSeconds: options.maxSpokenSeconds || 12,
    responseStyle: options.responseStyle || 'concise-answer',
    spillover: options.spillover || false,
    spilloverHint: options.spilloverHint || null,
    budgetInstruction: options.budgetInstruction,
  };
  
  // Optional metadata for special handling (model switch, exec, etc.)
  if (options.meta) {
    result.meta = options.meta;
  }
  
  return result;
}
