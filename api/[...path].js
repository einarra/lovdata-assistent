// Vercel catch-all serverless function for /api/* routes
// This handles all API routes like /api/health, /api/assistant/run, etc.

import handler from './index.js';

// Export handler that reconstructs the path from Vercel's path parameter
export default async function catchAllHandler(req, res) {
  // Vercel provides path segments in req.query.path as an array
  // Reconstruct the full path: /api/health -> ['health'] -> '/health'
  const pathSegments = req.query.path || [];
  const path = Array.isArray(pathSegments) 
    ? '/' + pathSegments.join('/')
    : '/' + pathSegments;
  
  // Set the reconstructed path on the request
  req.url = path;
  req.path = path;
  if (!req.originalUrl) {
    req.originalUrl = '/api' + path;
  }
  
  // Call the main handler
  return handler(req, res);
}

