/**
 * Alert Webhook - Simple HTTP server for external alerts
 * 
 * Receives alerts from monitoring systems and queues them for voice briefing
 */

import express from 'express';
import { queueAlert } from './alert-queue.js';

const app = express();
app.use(express.json({ limit: '10kb' }));

const WEBHOOK_PORT = process.env.ALERT_WEBHOOK_PORT || 3335;
const WEBHOOK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || 'change-me';

let client = null; // Will be set by main bot
let GUILD_ID = null;
let ALLOWED_USERS = [];
let currentVoiceChannelId = null;
let briefOnPauseCallback = null; // Callback to trigger briefing on next pause

export function initAlertWebhook(discordClient, guildId, allowedUsers, briefCallback) {
  client = discordClient;
  GUILD_ID = guildId;
  ALLOWED_USERS = allowedUsers;
  briefOnPauseCallback = briefCallback;
}

export function setCurrentVoiceChannelId(channelId) {
  currentVoiceChannelId = channelId;
}

app.post('/alert', async (req, res) => {
  // Verify token
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { message, priority, fullDetails, source } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }
  
  const alert = {
    message,
    priority: priority || 'normal',
    fullDetails: fullDetails || null,
    source: source || 'external',
  };
  
  queueAlert(alert);
  
  const userInVoice = isUserInVoice(ALLOWED_USERS[0]);
  
  if (!userInVoice) {
    // Not in voice - send text notification
    await sendTextNotification(alert);
  } else {
    // Already in voice - flag for briefing on next pause
    console.log('📢 Alert received while user in voice - will brief on next pause');
    if (briefOnPauseCallback) {
      briefOnPauseCallback(ALLOWED_USERS[0]);
    }
  }
  
  res.json({ ok: true, queued: true, userInVoice });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'mandy-voice-alerts' });
});

function isUserInVoice(userId) {
  if (!client || !GUILD_ID || !currentVoiceChannelId) return false;
  
  // Check if user is in the current voice channel
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return false;
  
  const member = guild.members.cache.get(userId);
  if (!member) return false;
  
  return member.voice.channelId === currentVoiceChannelId;
}

async function sendTextNotification(alert) {
  if (!client || !ALLOWED_USERS[0]) return;
  
  // Send Discord DM
  try {
    const user = await client.users.fetch(ALLOWED_USERS[0]);
    const priorityBadge = alert.priority === 'urgent' ? '🚨 **Urgent Alert**' : '🔔 **Alert**';
    const sourceBadge = alert.source ? `\n*Source: ${alert.source}*` : '';
    await user.send(`${priorityBadge}\n${alert.message}${sourceBadge}\n\nJoin voice for briefing.`);
    console.log(`📱 Text notification sent to user`);
  } catch (err) {
    console.error(`❌ Failed to send DM: ${err.message}`);
  }
}

export function startAlertWebhook() {
  const TAILSCALE_IP = process.env.TAILSCALE_IP || 'localhost';
  app.listen(WEBHOOK_PORT, TAILSCALE_IP, () => {
    console.log(`🔔 Alert webhook listening on ${TAILSCALE_IP}:${WEBHOOK_PORT} (Tailscale only)`);
  });
}
