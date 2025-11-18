# Assistant Run Debugging Guide

## Current Status

✅ **Authentication is working!**
- `/api/session` endpoint is working correctly
- Authorization header is being sent
- Token is being verified successfully
- User ID is extracted: `5ba30fed-16ba-4f72-9673-92fb995bb078`

❓ **Assistant run is failing** - Need logs for `/api/assistant/run`

## What We Need

The logs you shared are for `/api/session`, which is working. We need logs specifically for `/api/assistant/run` to diagnose the issue.

### Expected Log Sequence for `/api/assistant/run`

When you send a message in the app, you should see these logs in order:

1. **Catch-all entry point:**
```json
{
  "method": "POST",  // ⚠️ Should be POST, not GET
  "'...path': 'assistant/run'",
  "headers": {
    "authorization": "present",
    "content-type": "application/json"  // ⚠️ Should be present
  }
}
```

2. **Method preservation:**
```json
{
  "method": "POST",  // ⚠️ Should be POST
  "path": "/assistant/run",
  "hasBody": true,  // ⚠️ Should be true
  "contentType": "application/json"
}
```

3. **Auth middleware:**
```json
{
  "msg": "Auth middleware: checking authorization",
  "hasAuthHeader": true
}
```

4. **Auth successful:**
```json
{
  "msg": "Auth successful",
  "userId": "5ba30fed-16ba-4f72-9673-92fb995bb078"
}
```

5. **Assistant run: request received:**
```json
{
  "msg": "Assistant run: request received",
  "hasBody": true,
  "bodyType": "object",
  "bodyKeys": ["question", ...]
}
```

6. **Assistant run: payload validated:**
```json
{
  "msg": "Assistant run: payload validated",
  "questionLength": 25
}
```

7. **Assistant run: completed successfully:**
```json
{
  "msg": "Assistant run: completed successfully",
  "answerLength": 500,
  "evidenceCount": 5
}
```

## Common Issues

### Issue 1: Method is GET instead of POST
**Symptoms:**
- Logs show `"method": "GET"` instead of `"method": "POST"`
- You'll see the 405 error handler response

**Cause:**
- Frontend is sending GET instead of POST
- Or Vercel is converting POST to GET

**Check:**
- Browser Network tab: What method is shown?
- Frontend code: Is `method: 'POST'` being used?

### Issue 2: Request body is missing
**Symptoms:**
- Logs show `"hasBody": false`
- `"bodyType": "undefined"` or `"bodyType": "string"` (not "object")
- Payload validation fails

**Cause:**
- Body not being sent from frontend
- Body not being parsed correctly in Vercel

**Check:**
- Browser Network tab: Is there a Request Payload?
- Vercel logs: Is body being parsed?

### Issue 3: Payload validation fails
**Symptoms:**
- Log shows: `"Assistant run: payload validation failed"`
- Error: `"Invalid request payload"`

**Cause:**
- Missing `question` field
- `question` is too short (< 3 characters)
- Invalid `page` or `pageSize` values

**Check:**
- What is the request body in browser Network tab?
- Is `question` field present and valid?

### Issue 4: Error in runAssistant function
**Symptoms:**
- Log shows: `"Assistant run: error occurred"`
- Error details in the log

**Cause:**
- Error in the assistant logic
- Missing OpenAI API key
- Error in Supabase operations
- Error in archive search

**Check:**
- Look for the error message in the logs
- Check if `OPENAI_API_KEY` is set in Vercel
- Check if Supabase is configured correctly

## How to Get the Logs

1. **Deploy the enhanced logging** (already done)
2. **Open the app in browser**
3. **Open browser DevTools → Console tab**
4. **Send a message in the app**
5. **Check Vercel Function Logs** for entries with:
   - `'...path': 'assistant/run'`
   - `"Assistant run: request received"`
   - Any error messages

6. **Share the complete log sequence** for `/api/assistant/run`

## What to Share

When sharing logs, please include:
1. The complete log sequence from `[API/[...path].js] Catch-all entry point` to the final result
2. Any error messages
3. The method (should be POST)
4. Whether body is present
5. Any validation errors

The enhanced logging will now show:
- ✅ When request is received
- ✅ If body is present and what type it is
- ✅ If payload validation passes
- ✅ If assistant run completes successfully
- ✅ Any errors with full details

