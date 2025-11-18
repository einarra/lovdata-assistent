# Code Review: Communication Issues Fix

## Issues Identified

### 1. ✅ FIXED: Request Body Parsing Issue
**Problem:** In `api/index.js`, we were setting `req.body = {}` for all requests, which prevented Express from parsing POST request bodies. This could cause:
- POST requests to appear as if they have no body
- Routes expecting body data to fail
- Method mismatches (POST without body might be treated as GET)

**Fix:** Updated body handling to:
- Only initialize `req.body = {}` for non-body methods (GET, DELETE, etc.)
- For POST/PUT/PATCH with JSON content-type:
  - If body is a string, parse it manually
  - If body is already an object (Vercel parsed it), leave it as is
  - If body is missing, log a warning but set to empty object

**Location:** `api/index.js` lines 240-269

### 2. ⚠️ PENDING: HTTP Method Preservation
**Problem:** Logs show POST routes receiving GET requests. This could be:
- Browser sending GET (unlikely given frontend code)
- Vercel converting POST to GET (routing issue)
- Method being lost during path reconstruction

**Status:** Enhanced logging added to detect this. Need to verify with actual `/api/assistant/run` request logs.

**Location:** `api/[...path].js` lines 79-108

### 3. ⚠️ PENDING: Authentication Flow
**Problem:** Frontend shows 401 errors. Possible causes:
- Token not being sent correctly
- Supabase environment variables not set in Vercel
- Token verification failing in `verifySupabaseJwt`

**Status:** Error messages enhanced with hints. Need to verify:
- Vercel environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Token is being sent in Authorization header
- Supabase client is initialized correctly

**Location:** 
- `backend/src/http/middleware/requireSupabaseAuth.ts`
- `backend/src/services/supabaseClient.ts`
- `backend/src/auth/verifySupabaseJwt.ts`

### 4. ⚠️ PENDING: End-to-End Communication
**Status:** Need to test complete flow:
1. Frontend sends POST to `/api/assistant/run` with token
2. Vercel routes to `api/[...path].js` → `api/index.js`
3. Express receives request with correct method and body
4. `requireSupabaseAuth` middleware verifies token
5. `runAssistant` processes request
6. Response sent back to frontend

## Routes Verified

From logs, these routes are registered correctly:
- ✅ `GET /health`
- ✅ `GET /ready`
- ✅ `GET /metrics`
- ✅ `POST /skills/run`
- ✅ `POST /assistant/run`
- ✅ `GET /assistant/run` (returns 405 Method Not Allowed)
- ✅ `GET /session`
- ✅ `GET /documents/xml`

## Environment Variables for Vercel

### Required Variables (Backend)
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key (for server-side operations)
- `OPENAI_API_KEY` - OpenAI API key for the agent

### Required Variables (Frontend)
- `VITE_SUPABASE_URL` - Supabase project URL (same as backend)
- `VITE_SUPABASE_ANON_KEY` - Supabase anonymous key (for client-side auth)

### NOT Needed in Vercel
- ❌ `PORT` - Only used for local development. Serverless functions don't listen on ports.
- ❌ `NODE_ENV` - Vercel sets this automatically to `production`

## Next Steps

1. **Deploy the body parsing fix**
2. **Test with actual POST request to `/api/assistant/run`**
3. **Check Vercel function logs for:**
   - Method received (should be POST)
   - Body present and parsed correctly
   - Authentication header present
4. **Verify Vercel environment variables** (see above)
5. **Check browser Network tab:**
   - Request method is POST
   - Request includes Authorization header
   - Request body is JSON

## Debugging Commands

To check if routes are working:
```bash
# Health check (should work)
curl https://lovdata-assistent.vercel.app/api/health

# Session (requires auth token)
curl -H "Authorization: Bearer <token>" https://lovdata-assistent.vercel.app/api/session
```

## Expected Behavior After Fix

1. POST request to `/api/assistant/run` should:
   - Arrive with method: POST
   - Have parsed JSON body
   - Include Authorization header
   - Pass through `requireSupabaseAuth` middleware
   - Execute `runAssistant` function
   - Return response to frontend

2. If method is GET, should return 405 with helpful error message

3. If authentication fails, should return 401 with hint message

