# Alert System Quick Start

## Concept
1. **Alert happens** → Text notification (Discord DM)
2. **You join voice** → Jarvis briefs you immediately

## Setup (1 minute)

1. **Already configured in `.env`:**
   ```bash
   ALERT_WEBHOOK_PORT=3335
   ALERT_WEBHOOK_TOKEN=jarvis-alert-secure-token-change-me
   ```

2. **Restart Jarvis Voice:**
   ```bash
   sudo systemctl restart jarvis-voice
   ```

3. **Test it:**
   ```bash
   ./test-alert.sh
   ```
   
   You should see: `{"ok":true,"queued":true}`

4. **Check for Discord DM** (if you're not in voice)

5. **Join the voice channel** → Jarvis briefs you

## Send Alerts from Scripts

### Bash
```bash
curl -X POST http://your.tailscale.ip:3335/alert \
  -H "Authorization: Bearer jarvis-alert-secure-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Your brief alert message here",
    "priority": "urgent",
    "source": "my-script"
  }'
```

### Python
```python
import requests

requests.post('http://localhost:3335/alert', 
    headers={'Authorization': 'Bearer jarvis-alert-secure-token-change-me'},
    json={
        'message': 'Your brief alert message here',
        'priority': 'urgent',
        'fullDetails': 'Extended context spoken if you say yes',
        'source': 'my-script'
    })
```

### JavaScript
```javascript
fetch('http://localhost:3335/alert', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer jarvis-alert-secure-token-change-me',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    message: 'Your brief alert message here',
    priority: 'urgent',
    source: 'my-script'
  })
});
```

## Use Cases

**Security monitoring:**
- project-alpha detects phishing → urgent alert → voice briefing when you return

**Cron jobs:**
- Backup failed → normal alert → check status next time you join voice

**System alerts:**
- High memory usage → urgent alert → investigate immediately

**Build/Deploy notifications:**
- CI/CD pipeline finished → normal alert → review when convenient

## Priority Levels
- `urgent` → Spoken first, 🚨 in Discord DM
- `normal` (default) → 🔔 in Discord DM

## Voice Commands
- **"Yes"** / **"Tell me more"** → Full details spoken
- **"No"** / ignore → Alerts stay queued (re-brief next time)

## Full Documentation
See [ALERTS.md](ALERTS.md) for complete API reference, examples, and architecture details.
