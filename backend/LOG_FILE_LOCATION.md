# Log File Location

## Current Setup

By default, logs are written to **stdout** (console). The logs are in JSON format when running in production mode.

## Where to Find Logs

### Option 1: Console Output (Default)
- **Development**: Pretty-printed logs appear in your terminal
- **Production**: JSON logs appear in stdout/stderr

### Option 2: File Logging (Recommended for Production)

To write JSON logs to a file, set the `LOG_FILE` environment variable:

```bash
# In your .env file
LOG_FILE=server.log
```

Or use an absolute path:
```bash
LOG_FILE=/var/log/lovdata-backend/server.log
```

### Option 3: Redirect Output Manually

You can also redirect stdout/stderr when starting the server:

```bash
# Write to file
npm start > server.log 2>&1

# Or with timestamp
npm start > "server-$(date +%Y%m%d-%H%M%S).log" 2>&1
```

## Log File Format

All logs are in **JSON format** (one JSON object per line) when written to a file. Each log entry includes:

```json
{
  "level": 30,
  "time": 1704067200000,
  "msg": "[TIMING] Completed: startup (23.10s)",
  "operation": "startup",
  "durationMs": 23100,
  "durationSec": "23.10s",
  "timestamp": "2024-01-01T00:00:23.100Z",
  "port": 3000
}
```

## Finding Timing Logs

To filter for timing logs only:

```bash
# View all timing logs
cat server.log | grep "\[TIMING\]"

# View timing logs as JSON (requires jq)
cat server.log | jq 'select(.msg | contains("[TIMING]"))'

# Find slow operations (>1 second)
cat server.log | jq 'select(.msg | contains("[TIMING] Completed")) | select(.durationMs > 1000)'

# Sort operations by duration
cat server.log | jq 'select(.msg | contains("[TIMING] Completed")) | {operation: .operation, duration: .durationSec}' | jq -s 'sort_by(.duration)'
```

## Default Log File Location

If you set `LOG_FILE=server.log` in your `.env` file, the log file will be created in:

```
/Users/einarrasmussen/projects/SpektralLab/Lovdata/backend/server.log
```

The file will be created automatically when the server starts and logs will be appended to it.

