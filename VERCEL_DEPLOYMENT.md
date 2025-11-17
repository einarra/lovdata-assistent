# Vercel Deployment Guide

This guide explains how to deploy the Lovdata Assistant application to Vercel.

## Prerequisites

1. A Vercel account (sign up at https://vercel.com)
2. All required environment variables configured
3. Backend and frontend dependencies installed

## Project Structure

The project is a monorepo with:
- `backend/`: Express/TypeScript backend API
- `frontend/`: React/Vite frontend
- `api/`: Vercel serverless function wrapper

## Environment Variables

Configure the following environment variables in Vercel Dashboard (Settings → Environment Variables):

### Backend Variables

```
NODE_ENV=production
PORT=4000
LOG_LEVEL=info

# Lovdata API
LOVDATA_BASE_URL=https://api.lovdata.no
LOVDATA_TIMEOUT_MS=30000

# Public API URL (your Vercel deployment URL)
PUBLIC_API_BASE_URL=https://your-app.vercel.app

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-key

# OpenAI (required)
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-4o-mini
OPENAI_TEMPERATURE=1

# Optional: Serper
SERPER_API_KEY=your-serper-key
SERPER_BASE_URL=https://google.serper.dev/search
SERPER_SITE_FILTER=lovdata.no

# Optional: Archive sync on startup
SYNC_ARCHIVES_ON_STARTUP=false

# Optional: Observability
LANGSMITH_API_KEY=your-langsmith-key
LANGSMITH_PROJECT=your-project-name
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```

### Frontend Variables

```
VITE_API_URL=/api
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

**Note:** In production, `VITE_API_URL` should be `/api` (relative path) so it uses the same domain.

## Deployment Steps

### 1. Connect Repository to Vercel

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click "Add New Project"
3. Import your Git repository
4. Vercel will auto-detect the project settings

### 2. Configure Build Settings

Vercel should auto-detect from `vercel.json`, but verify:

- **Framework Preset:** Other
- **Root Directory:** `.` (root of the repository)
- **Build Command:** `cd backend && npm install && npm run build && cd ../frontend && npm install && npm run build`
- **Output Directory:** `frontend/dist`
- **Install Command:** `npm install`

### 3. Set Environment Variables

Add all environment variables listed above in the Vercel Dashboard:
- Go to Project Settings → Environment Variables
- Add each variable for **Production**, **Preview**, and **Development** environments as needed

### 4. Deploy

1. Push your code to the connected Git repository
2. Vercel will automatically trigger a deployment
3. Monitor the deployment logs in the Vercel Dashboard

## How It Works

### Serverless Function

The backend Express app is wrapped as a Vercel serverless function in `api/index.js`:
- Routes `/api/*` requests to the Express backend
- Strips the `/api` prefix before passing to Express
- Initializes backend services on first request (cached per container)

### Frontend

The React frontend is built and served as static files:
- Built output goes to `frontend/dist`
- All routes are rewritten to `index.html` for client-side routing
- API calls use `/api` prefix which routes to the serverless function

### Routing

- `/api/*` → Serverless function (backend)
- `/*` → Frontend static files (React app)

## Troubleshooting

### Build Failures

1. **Backend build fails:**
   - Ensure all TypeScript dependencies are installed
   - Check that `backend/tsconfig.json` is valid
   - Verify Node.js version is >= 20

2. **Frontend build fails:**
   - Check that all environment variables starting with `VITE_` are set
   - Verify React/Vite dependencies are installed

### Runtime Errors

1. **API routes return 404:**
   - Check that `api/index.js` exists in the root
   - Verify the `/api` prefix is being stripped correctly
   - Check serverless function logs in Vercel Dashboard

2. **Environment variables not loading:**
   - Ensure variables are set in Vercel Dashboard
   - Check that variable names match exactly (case-sensitive)
   - Verify `NODE_ENV=production` is set

3. **Cold start timeouts:**
   - Increase function timeout in `vercel.json` (max 60s on Hobby plan)
   - Consider upgrading to Pro plan for longer timeouts
   - Optimize initialization code in `backend/src/serverless.ts`

### Database/Archive Issues

1. **Archive store not initializing:**
   - Check Supabase credentials
   - Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct
   - Check serverless function logs for initialization errors

2. **Archive sync fails:**
   - Set `SYNC_ARCHIVES_ON_STARTUP=false` to skip sync on startup
   - Sync can be done manually via scripts if needed

## Performance Considerations

1. **Cold Starts:** First request after inactivity may be slow due to initialization
   - Services are cached per container, so subsequent requests are faster
   - Consider using Vercel Pro plan for better performance

2. **Function Memory:** Set to 1024MB in `vercel.json` for better performance
   - Can be increased if needed (up to 3008MB on Pro plan)

3. **Function Timeout:** Set to 60s (maximum on Hobby plan)
   - Increase if you have long-running operations
   - Consider breaking up long operations into smaller chunks

## Monitoring

- Check Vercel Dashboard for function logs and metrics
- Monitor error rates and response times
- Set up alerts for critical errors
- Use LangSmith for AI/LLM observability (if configured)

## Updating Deployment

1. Push changes to your Git repository
2. Vercel automatically deploys on push to main branch
3. Preview deployments are created for pull requests
4. Monitor deployment status in Vercel Dashboard

## Additional Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Vercel Serverless Functions](https://vercel.com/docs/functions)
- [Environment Variables in Vercel](https://vercel.com/docs/environment-variables)

