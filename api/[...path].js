// Vercel catch-all serverless function for /api/* routes
// This handles all API routes like /api/health, /api/assistant/run, etc.

import handler from './index.js';

// Export handler that reconstructs the path from Vercel's path parameter
export default async function catchAllHandler(req, res) {
  // Log all request properties for debugging
  console.log(`[Catch-all] ===== Request Details =====`);
  console.log(`[Catch-all] Method: ${req.method}`);
  console.log(`[Catch-all] URL: ${req.url}`);
  console.log(`[Catch-all] Path: ${req.path}`);
  console.log(`[Catch-all] Original URL: ${req.originalUrl}`);
  console.log(`[Catch-all] Query object:`, req.query);
  console.log(`[Catch-all] Query keys:`, Object.keys(req.query || {}));
  
  // Vercel provides path segments in req.query.path as an array
  // For /api/health, req.query.path = ['health']
  // For /api/assistant/run, req.query.path = ['assistant', 'run']
  const pathSegments = req.query.path || [];
  console.log(`[Catch-all] Path segments (raw):`, pathSegments);
  console.log(`[Catch-all] Path segments type:`, typeof pathSegments, Array.isArray(pathSegments));
  
  const path = Array.isArray(pathSegments) 
    ? '/' + pathSegments.join('/')
    : '/' + String(pathSegments);
  
  console.log(`[Catch-all] Reconstructed path: ${path}`);
  
  // Set the reconstructed path on the request
  // The main handler expects paths without /api prefix
  req.url = path;
  req.path = path;
  req.originalUrl = req.originalUrl || '/api' + path;
  
  // Also set query.path to undefined so the main handler doesn't try to use it again
  if (req.query) {
    delete req.query.path;
  }
  
  console.log(`[Catch-all] Calling main handler with path: ${path}`);
  
  // Call the main handler
  return handler(req, res);
}

