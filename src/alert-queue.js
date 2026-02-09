/**
 * Alert Queue - Stores pending voice alerts for briefing on join
 */

const pendingAlerts = [];
const MAX_ALERTS = 50;
const ALERT_TTL_MS = 4 * 60 * 60 * 1000; // Expire alerts older than 4 hours

export function queueAlert(alert) {
  // alert: { 
  //   timestamp: Date.now(), 
  //   priority: 'urgent'|'normal', 
  //   message: 'Brief summary',
  //   fullDetails: 'Full context (optional)',
  //   source: 'security-monitor'|'cron'|'system'
  // }
  
  // Prune expired alerts first
  const now = Date.now();
  for (let i = pendingAlerts.length - 1; i >= 0; i--) {
    if (now - pendingAlerts[i].timestamp > ALERT_TTL_MS) {
      pendingAlerts.splice(i, 1);
    }
  }
  
  pendingAlerts.push({
    ...alert,
    timestamp: alert.timestamp || now,
    priority: alert.priority || 'normal',
  });
  
  // Cap total alerts — drop oldest non-urgent first
  while (pendingAlerts.length > MAX_ALERTS) {
    const normalIdx = pendingAlerts.findIndex(a => a.priority !== 'urgent');
    pendingAlerts.splice(normalIdx >= 0 ? normalIdx : 0, 1);
  }
  
  // Sort by priority (urgent first), then timestamp (oldest first)
  pendingAlerts.sort((a, b) => {
    if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
    if (a.priority !== 'urgent' && b.priority === 'urgent') return 1;
    return a.timestamp - b.timestamp;
  });
  
  console.log(`📬 Alert queued: ${alert.message.substring(0, 50)}...`);
}

export function getPendingAlerts() {
  return [...pendingAlerts];
}

export function clearAlerts() {
  const count = pendingAlerts.length;
  pendingAlerts.length = 0;
  console.log(`🗑️  Cleared ${count} alerts`);
  return count;
}

export function hasPendingAlerts() {
  return pendingAlerts.length > 0;
}
