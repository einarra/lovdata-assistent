// Vercel catch-all serverless function for /api/* routes
// This handles all API routes like /api/health, /api/assistant/run, etc.

import handler from './index.js';

// Export handler that reconstructs the path from Vercel's path parameter
export default async function catchAllHandler(req, res) {
  // Vercel provides path segments in req.query.path as an array
  // For /api/health, req.query.path = ['health']
  // For /api/assistant/run, req.query.path = ['assistant', 'run']
  const pathSegments = req.query.path || [];
  const path = Array.isArray(pathSegments) 
    ? '/' + pathSegments.join('/')
    : '/' + String(pathSegments);
  
  // Log for debugging
  console.log(`[Catch-all] Original URL: ${req.url}, Path segments:`, pathSegments, `Reconstructed path: ${path}`);
  
  // Set the reconstructed path on the request
  // The main handler expects paths without /api prefix
  req.url = path;
  req.path = path;
  req.originalUrl = req.originalUrl || '/api' + path;
  
  // Call the main handler
  return handler(req, res);
}

