# Authentication Diagnostics Guide

## Understanding the Logs

### `/api/health` Endpoint (No Auth Required)
The logs you showed are for `/api/health`, which **does NOT require authentication**. This is expected behavior:
- ✅ `authorization: 'missing'` is **normal** for `/api/health`
- ✅ This endpoint is used for health checks and doesn't need auth

### Protected Endpoints (Auth Required)
These endpoints **DO require authentication**:
- `/api/assistant/run` (POST)
- `/api/session` (GET)
- `/api/skills/run` (POST)

## Checking Authentication Issues

### 1. Check Logs for Protected Endpoints
Look for logs with `'...path': 'assistant/run'` or `'...path': 'session'`:

**Expected for authenticated request:**
```json
{
  "method": "POST",
  "path": "/assistant/run",
  "headers": {
    "authorization": "present",
    "content-type": "application/json"
  }
}
```

**Problem: Missing auth header:**
```json
{
  "method": "POST",
  "path": "/assistant/run",
  "headers": {
    "authorization": "missing"  // ❌ This is the problem
  }
}
```

### 2. Verify Frontend Supabase Configuration
Check that these environment variables are set in Vercel:
- ✅ `VITE_SUPABASE_URL` - Your Supabase project URL
- ✅ `VITE_SUPABASE_ANON_KEY` - Your Supabase anonymous key

**Check in browser console:**
```javascript
// Should show your Supabase URL
console.log(import.meta.env.VITE_SUPABASE_URL);

// Should show your anon key
console.log(import.meta.env.VITE_SUPABASE_ANON_KEY);
```

### 3. Verify Backend Supabase Configuration
Check that these environment variables are set in Vercel:
- ✅ `SUPABASE_URL` - Your Supabase project URL (same as frontend)
- ✅ `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key

**The service role key is different from the anon key!**
- Anon key: Used by frontend (public, has RLS restrictions)
- Service role key: Used by backend (private, bypasses RLS)

### 4. Check User Login Status
In the browser console, check if user is logged in:
```javascript
// Should show session object if logged in
const { data: { session } } = await supabase.auth.getSession();
console.log('Session:', session);
console.log('Access token:', session?.access_token);
```

### 5. Check Network Tab
When making a request to `/api/assistant/run`:
1. Open DevTools → Network tab
2. Send a message in the app
3. Find the request to `/api/assistant/run`
4. Check Request Headers:
   - ✅ Should have: `Authorization: Bearer <token>`
   - ❌ If missing: Frontend is not sending the token

## Common Issues and Solutions

### Issue 1: "Authorization header missing"
**Cause:** Frontend is not sending the Authorization header

**Check:**
1. Is user logged in? (Check browser console for session)
2. Is `accessToken` available? (Check `App.tsx` line 55)
3. Is token being passed to `apiService.assistantRun()`? (Check `App.tsx` line 123)

**Solution:**
- Ensure user is logged in via Supabase auth
- Verify `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set in Vercel
- Check browser console for Supabase initialization errors

### Issue 2: "Supabase not configured"
**Cause:** Backend Supabase environment variables are missing

**Check Vercel environment variables:**
- `SUPABASE_URL` - Must be set
- `SUPABASE_SERVICE_ROLE_KEY` - Must be set (NOT the anon key!)

**Solution:**
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Add `SUPABASE_URL` with your Supabase project URL
3. Add `SUPABASE_SERVICE_ROLE_KEY` with your service role key (from Supabase Dashboard → Settings → API)

### Issue 3: "Invalid token" or "Token verification failed"
**Cause:** Token is invalid, expired, or Supabase can't verify it

**Check:**
1. Is the token being sent correctly? (Check Network tab)
2. Is the service role key correct? (Must be service role, not anon key)
3. Is the Supabase URL correct? (Must match between frontend and backend)

**Solution:**
- Verify `SUPABASE_SERVICE_ROLE_KEY` is the service role key (starts with `eyJ...`)
- Ensure `SUPABASE_URL` matches between frontend (`VITE_SUPABASE_URL`) and backend (`SUPABASE_URL`)
- Try logging out and logging back in to get a fresh token

## Testing Authentication Flow

### Step 1: Test Health Endpoint (No Auth)
```bash
curl https://lovdata-assistent.vercel.app/api/health
```
Should return: `{"status":"ok",...}`

### Step 2: Test Session Endpoint (Requires Auth)
```bash
# This should fail with 401 if no token
curl https://lovdata-assistent.vercel.app/api/session

# This should work with a valid token
curl -H "Authorization: Bearer <your-token>" \
  https://lovdata-assistent.vercel.app/api/session
```

### Step 3: Check Vercel Function Logs
Look for these log entries:
- `[API/[...path].js] Catch-all entry point:` - Shows incoming request
- `Auth middleware: checking authorization` - Shows auth check
- `Auth successful` - Shows successful authentication
- `Auth failed: Authorization header missing` - Shows auth failure

## Next Steps

1. **Deploy the enhanced logging** (already done)
2. **Try sending a message** in the app (triggers `/api/assistant/run`)
3. **Check Vercel function logs** for:
   - `'...path': 'assistant/run'` entry
   - `authorization: 'present'` or `'missing'`
   - `Auth middleware: checking authorization` log
   - Any error messages from auth middleware
4. **Share the logs** for `/api/assistant/run` (not `/api/health`)

The `/api/health` endpoint is working correctly - it doesn't need auth. We need to see logs from protected endpoints to diagnose the authentication issue.

