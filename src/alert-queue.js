/**
 * Alert Queue - Stores pending voice alerts for briefing on join
 */

const pendingAlerts = [];

export function queueAlert(alert) {
  // alert: { 
  //   timestamp: Date.now(), 
  //   priority: 'urgent'|'normal', 
  //   message: 'Brief summary',
  //   fullDetails: 'Full context (optional)',
  //   source: 'security-monitor'|'cron'|'system'
  // }
  pendingAlerts.push({
    ...alert,
    timestamp: alert.timestamp || Date.now(),
    priority: alert.priority || 'normal',
  });
  
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
