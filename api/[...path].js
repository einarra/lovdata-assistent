// Vercel catch-all serverless function for /api/* routes
// This handles all API routes like /api/health, /api/assistant/run, etc.

// Re-export the same handler from index.js
export { default } from './index.js';

