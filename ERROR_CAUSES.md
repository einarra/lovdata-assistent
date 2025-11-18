# What Causes "Assistant run failed" Error

## Error Flow

The error message "Assistant run failed" comes from the frontend when the API request to `/api/assistant/run` returns a non-successful HTTP status code (not 200-299).

### Frontend Code Flow

1. **Request Made** (`frontend/src/services/api.ts` line 201):
   ```typescript
   const response = await fetch(url, requestOptions);
   ```

2. **Check Response** (line 203):
   ```typescript
   if (!response.ok) {  // Status code is NOT 200-299
     let errorMessage = `Assistant run failed: ${response.statusText}`;
     // ... tries to get better error message from response body
     throw new Error(errorMessage);
   }
   ```

3. **Error Displayed** (`frontend/src/App.tsx` line 133-143):
   ```typescript
   catch (err) {
     const message = err instanceof Error ? err.message : 'Kunne ikke få svar fra assistenten';
     setError(message);
     // Shows error message to user
   }
   ```

## Possible Causes (Backend Status Codes)

### 1. **404 Not Found** - Route Not Found
**Cause:**
- Request method is GET instead of POST (hits GET handler which returns 405, but might show as 404)
- Path reconstruction failed (path doesn't match `/assistant/run`)
- Express doesn't find the route

**Backend Response:**
```json
{
  "error": "Not found",
  "path": "/assistant/run",
  "method": "GET"  // or "POST"
}
```

**Frontend Shows:**
- "Assistant run failed: Not Found"
- Or the error message from response body

**How to Diagnose:**
- Check Vercel logs for: `"Express did not send response - route not found"`
- Check if method is POST in logs
- Check if path is correctly reconstructed to `/assistant/run`

### 2. **405 Method Not Allowed** - Wrong HTTP Method
**Cause:**
- Request is sent as GET instead of POST
- Frontend is using wrong method
- Vercel is converting POST to GET

**Backend Response:**
```json
{
  "error": "Method Not Allowed",
  "message": "This endpoint only accepts POST requests",
  "hint": "The request was sent as GET instead of POST..."
}
```

**Frontend Shows:**
- "Assistant run failed: Method Not Allowed"
- Or "This endpoint only accepts POST requests"

**How to Diagnose:**
- Check browser Network tab: What method is shown?
- Check Vercel logs: What method is received?
- Look for: `[CatchAll] ERROR: POST route received GET request!`

### 3. **401 Unauthorized** - Authentication Failed
**Cause:**
- Authorization header missing
- Token is invalid or expired
- Supabase not configured correctly
- Token verification fails

**Backend Response:**
```json
{
  "message": "Unauthorized",
  "hint": "Include Authorization header with format: Bearer <token>"
}
```

**Frontend Shows:**
- "Authentication failed. Please log in again."
- Or the error message from response body

**How to Diagnose:**
- Check Vercel logs for: `"Auth failed: Authorization header missing"`
- Check if `authorization: 'present'` in catch-all entry point log
- Check if token is being sent in browser Network tab

### 4. **400 Bad Request** - Invalid Payload
**Cause:**
- Request body is missing
- Request body is not valid JSON
- `question` field is missing or too short (< 3 characters)
- Invalid `page` or `pageSize` values

**Backend Response:**
```json
{
  "message": "Invalid request payload",
  "issues": [
    {
      "path": ["question"],
      "message": "String must contain at least 3 character(s)"
    }
  ]
}
```

**Frontend Shows:**
- "Assistant run failed: Bad Request"
- Or "Invalid request payload"

**How to Diagnose:**
- Check Vercel logs for: `"Assistant run: payload validation failed"`
- Check browser Network tab: Is Request Payload present?
- Check if `question` field is in the request body

### 5. **500 Internal Server Error** - Server Error
**Cause:**
- Error in `runAssistant` function
- Missing OpenAI API key
- Error in Supabase operations
- Error in archive search
- Any unhandled exception

**Backend Response:**
```json
{
  "message": "Internal Server Error"
}
```

**Frontend Shows:**
- "Assistant run failed: Internal Server Error"
- Or the error message from response body

**How to Diagnose:**
- Check Vercel logs for: `"Assistant run: error occurred"`
- Check for error stack traces
- Check if `OPENAI_API_KEY` is set in Vercel
- Check for any error messages in logs

### 6. **503 Service Unavailable** - Backend Not Ready
**Cause:**
- Backend initialization failed
- Services not ready
- Archive store not initialized

**Backend Response:**
```json
{
  "status": "degraded",
  "message": "Backend not initialized"
}
```

**Frontend Shows:**
- "Assistant run failed: Service Unavailable"

**How to Diagnose:**
- Check Vercel logs for initialization errors
- Check if backend/dist directory exists
- Check if Supabase is configured

## How to Diagnose the Specific Cause

### Step 1: Check Browser Network Tab
1. Open DevTools → Network tab
2. Find the request to `/api/assistant/run`
3. Check:
   - **Status Code**: This tells you the error type
   - **Method**: Should be POST
   - **Request Headers**: Should include `Authorization: Bearer <token>`
   - **Request Payload**: Should show JSON with `question` field
   - **Response**: Shows the error message from backend

### Step 2: Check Vercel Function Logs
Look for these log entries (in order):

1. **Catch-all entry point:**
   - Should show: `'...path': 'assistant/run'`
   - Should show: `method: 'POST'` (not GET)
   - Should show: `authorization: 'present'`

2. **Path reconstruction:**
   - Should show: `path: '/assistant/run'`
   - Should show: `method: 'POST'`

3. **About to call Express:**
   - Should show: `method: 'POST'`
   - Should show: `hasBody: true`

4. **Auth middleware:**
   - Should show: `"Auth middleware: checking authorization"`
   - Should show: `"Auth successful"` (not "Auth failed")

5. **Assistant run handler:**
   - Should show: `"Assistant run: request received"`
   - Should show: `"Assistant run: payload validated"`
   - Should show: `"Assistant run: completed successfully"` (or error)

### Step 3: Match Status Code to Cause

| Status Code | Most Likely Cause | Check Logs For |
|------------|-------------------|----------------|
| 404 | Route not found | "Express did not send response" |
| 405 | Wrong method (GET instead of POST) | "POST route received GET request" |
| 401 | Authentication failed | "Auth failed" or "Auth middleware" |
| 400 | Invalid payload | "payload validation failed" |
| 500 | Server error | "Assistant run: error occurred" |
| 503 | Backend not ready | "Backend not initialized" |

## Common Issues and Solutions

### Issue: "Assistant run failed" with 404
**Solution:**
- Check if method is POST (not GET)
- Check if path is correctly reconstructed
- Check if route is registered (should see in route registration log)

### Issue: "Assistant run failed" with 405
**Solution:**
- Ensure frontend is using `method: 'POST'`
- Check if Vercel is converting POST to GET
- Check browser Network tab for actual method

### Issue: "Assistant run failed" with 401
**Solution:**
- Ensure user is logged in
- Check if token is being sent in Authorization header
- Verify Supabase environment variables are set
- Check if token is expired (try logging out and back in)

### Issue: "Assistant run failed" with 400
**Solution:**
- Check if request body is present
- Check if `question` field exists and is at least 3 characters
- Check if body is valid JSON

### Issue: "Assistant run failed" with 500
**Solution:**
- Check Vercel logs for error details
- Verify `OPENAI_API_KEY` is set
- Check for any error stack traces
- Verify Supabase is configured correctly

## Next Steps

1. **Check browser Network tab** for the status code
2. **Check Vercel function logs** for the specific error
3. **Match the status code** to the cause above
4. **Follow the solution** for that specific issue

The enhanced logging will show exactly where the failure occurs, making it easier to diagnose the specific cause.

