# GDPR Consent Form Setup Instructions

## Prerequisites

Before the GDPR consent form can be used, you must run the database migration to create the `gdpr_consents` table.

## Step 1: Run the Database Migration

The migration file is located at:
```
backend/supabase/migrations/add_gdpr_consent.sql
```

### Option A: Using Supabase Dashboard (Recommended)

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Click **New Query**
4. Copy the entire contents of `backend/supabase/migrations/add_gdpr_consent.sql`
5. Paste it into the SQL editor
6. Click **Run** (or press Cmd/Ctrl + Enter)
7. Verify the table was created by checking the **Table Editor** → `gdpr_consents`

### Option B: Using Supabase CLI

If you have Supabase CLI installed:

```bash
cd backend
supabase migration up
```

Or apply the specific migration:

```bash
supabase db push
```

## Step 2: Verify the Table Exists

Run this query in Supabase SQL Editor to verify:

```sql
SELECT * FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name = 'gdpr_consents';
```

You should see a row returned. If not, the migration didn't run successfully.

## Step 3: Test the Form

1. Start your backend server:
   ```bash
   cd backend
   npm run dev
   ```

2. Start your frontend:
   ```bash
   cd frontend
   npm run dev
   ```

3. Log in to the application
4. You should see the GDPR consent form
5. Fill it out and submit

## Troubleshooting

### Error: "Database table not found" or "Failed to save consent record"

**Cause**: The `gdpr_consents` table doesn't exist in your Supabase database.

**Solution**: 
1. Run the migration as described in Step 1
2. Verify the table exists (Step 2)
3. Restart your backend server

### Error: "Unauthorized" or 401 error

**Cause**: You're not logged in or the authentication token is invalid.

**Solution**: 
1. Make sure you're logged in
2. Check that Supabase authentication is configured correctly
3. Check browser console for authentication errors

### Error: "Invalid consent data" or 400 error

**Cause**: The form data doesn't match the expected schema.

**Solution**: 
1. Make sure both required checkboxes (Data Processing and Data Storage) are checked
2. Check browser console for validation errors
3. Verify the frontend is sending the correct data format

### Checking Backend Logs

If you're still having issues, check the backend logs:

```bash
# If LOG_FILE is set in .env
tail -f backend/server.log

# Or check console output
```

Look for errors containing "Failed to save GDPR consent" or "gdpr_consents".

### Checking Network Requests

1. Open browser DevTools (F12)
2. Go to **Network** tab
3. Filter by "gdpr" or "consent"
4. Try submitting the form
5. Check the request:
   - **Status**: Should be 200 (success) or you'll see the error code
   - **Request Payload**: Should contain `dataProcessing: true, dataStorage: true`
   - **Response**: Should show the error message if it failed

### Common Issues

1. **Migration not run**: Most common issue - the table doesn't exist
2. **RLS policies**: Make sure Row Level Security policies allow the service role to insert
3. **Column name mismatch**: Ensure migration matches the code (snake_case in DB, camelCase in code)
4. **CORS issues**: Check that backend CORS allows requests from frontend URL

## Verification Checklist

- [ ] Migration file exists: `backend/supabase/migrations/add_gdpr_consent.sql`
- [ ] Migration has been run in Supabase
- [ ] Table `gdpr_consents` exists in Supabase
- [ ] Backend server is running
- [ ] Frontend is running
- [ ] User is logged in
- [ ] Network request shows 200 status (or clear error message)

## Next Steps

Once the form is working:
1. Test with a new user (should see form on first login)
2. Test with existing user (should not see form if consent already given)
3. Verify consent is saved in Supabase `gdpr_consents` table
4. Test updating consent (should update existing record)

