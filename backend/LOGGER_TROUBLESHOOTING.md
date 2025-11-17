# Logger Troubleshooting Guide

## ✅ Logger is Now Fixed and Working

The logger has been fixed and verified to work correctly. Logs should now appear in stdout when running `npm run dev`.

## What Was Fixed

The issue was with how the logger intercepted log calls when `LOG_FILE` was set in development mode. The interception method has been updated to properly handle both object and string arguments.

## Verification

To verify the logger is working, you should see logs immediately when starting the server:

```bash
npm run dev
```

Expected output:
```
[2025-11-14 10:04:57.832 +0100] INFO: 🚀 Server starting...
[2025-11-14 10:04:57.832 +0100] INFO: Logger configuration
    env: "development"
    logLevel: "info"
    logFile: "server.log"
[2025-11-14 10:04:57.832 +0100] INFO: Initializing Supabase archive storage
...
```

## If Logs Still Don't Appear

### 1. Check Your Environment Variables

```bash
# In your .env file, ensure:
NODE_ENV=development
LOG_LEVEL=info  # or debug for more verbose logs
LOG_FILE=server.log  # optional
```

### 2. Verify Logger is Imported Correctly

The logger should be imported at the top of `src/index.ts`:
```typescript
import { logger } from './logger.js';
```

### 3. Check for Build Issues

```bash
npm run build
# Should complete without errors
```

### 4. Test Logger Directly

```bash
node -e "import('./dist/logger.js').then(m => { m.logger.info('Test'); })"
# Should output: [timestamp] INFO: Test
```

### 5. Check tsx Watch Mode

If using `tsx watch`, it might buffer output. Try:
- Restart the dev server
- Check if there are any errors preventing startup
- Look for port conflicts (the server.log shows EADDRINUSE errors)

### 6. Check for Port Conflicts

If you see "EADDRINUSE" errors in server.log, another process is using port 4000:
```bash
# Find and kill the process
lsof -ti:4000 | xargs kill -9

# Or change the port in .env
PORT=4001
```

## Current Configuration

- **Development Mode**: Pretty-printed logs to console (stdout)
- **File Logging**: If `LOG_FILE` is set, also writes JSON logs to file
- **Production Mode**: JSON logs to stdout (and file if `LOG_FILE` is set)

## Log Levels

- `trace` - Most verbose
- `debug` - Debug information
- `info` - General information (default)
- `warn` - Warnings
- `error` - Errors only
- `fatal` - Fatal errors only

Set `LOG_LEVEL=debug` in your `.env` to see more detailed logs including timing information.

