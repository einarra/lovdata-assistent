// Vercel catch-all serverless function for /api/* routes
// This handles all API routes like /api/health, /api/assistant/run, etc.

import handler from './index.js';

// Export handler that reconstructs the path from Vercel's path parameter
export default async function catchAllHandler(req, res) {
  // Vercel provides path segments in req.query['...path'] (with three dots) for catch-all routes
  // For /api/health, req.query['...path'] = 'health'
  // For /api/assistant/run, req.query['...path'] = 'assistant/run' (string with slashes)
  const pathParam = req.query['...path'] || req.query.path || '';
  
  // Handle both string and array formats
  let path;
  if (Array.isArray(pathParam)) {
    // If it's an array, join with slashes
    path = '/' + pathParam.join('/');
  } else if (typeof pathParam === 'string' && pathParam.length > 0) {
    // If it's a string, ensure it starts with /
    // Vercel passes 'assistant/run' for /api/assistant/run
    path = pathParam.startsWith('/') ? pathParam : '/' + pathParam;
  } else {
    // Empty or undefined - default to root
    path = '/';
  }
  
  // Set the reconstructed path on the request
  // The main handler expects paths without /api prefix
  req.url = path;
  req.path = path;
  req.originalUrl = req.originalUrl || '/api' + path;
  
  // CRITICAL: Preserve the HTTP method - don't default to GET
  // Vercel should set this, but ensure it's preserved for POST/PUT/DELETE etc.
  // Only set default if method is truly missing (shouldn't happen)
  if (!req.method) {
    req.method = 'GET';
  }
  
  // Don't delete query params here - let the main handler use them if needed
  // The main handler will use req.url which we've already set correctly
  
  // Call the main handler
  return handler(req, res);
}

