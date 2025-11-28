// Explicit route handler for /api/assistant/run
// This ensures Vercel routes POST requests to this endpoint correctly
// It delegates to the main handler (index.js) for actual processing

import mainHandler from '../index.js';

// Explicitly configure Vercel function timeout (60 seconds for Pro plan)
export const config = {
  maxDuration: 60, // 60 seconds - Vercel Pro plan maximum
};

export default async function handler(req, res) {
  // Log that we're in the explicit route handler
  console.log('[API/assistant/run.js] Explicit route handler called:', {
    method: req.method,
    url: req.url,
    path: req.path,
    hasBody: !!req.body,
    contentType: req.headers['content-type'],
    authorization: req.headers.authorization ? 'present' : 'missing'
  });
  
  // Set up the path so the main handler processes it correctly
  // The main handler expects paths without /api prefix
  req.url = '/assistant/run';
  req.path = '/assistant/run';
  if (!req.originalUrl) {
    req.originalUrl = '/api/assistant/run';
  }
  
  // Call the main handler
  return mainHandler(req, res);
}

