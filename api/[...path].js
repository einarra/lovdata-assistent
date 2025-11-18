// Vercel catch-all serverless function for /api/* routes
// This handles all API routes like /api/health, /api/assistant/run, etc.

import handler from './index.js';

// Export handler that reconstructs the path from Vercel's path parameter
export default async function catchAllHandler(req, res) {
  // Log the incoming request method for debugging
  const incomingMethod = req.method || req.headers['x-http-method-override'] || 'UNKNOWN';
  if (process.env.NODE_ENV === 'development' || process.env.VERCEL) {
    console.log('[CatchAll] Incoming request:', {
      method: incomingMethod,
      url: req.url,
      path: req.path,
      query: req.query
    });
  }
  
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
  
  // CRITICAL: Preserve the HTTP method - NEVER override if it's already set
  // Vercel should set req.method correctly, but let's be extra careful
  // Store the original method before any processing
  const originalMethod = req.method;
  
  // Only set method if it's truly missing (shouldn't happen with Vercel)
  if (!req.method) {
    // Try to get method from headers (some proxies use this)
    const methodOverride = req.headers['x-http-method-override'] || req.headers['x-method-override'];
    if (methodOverride) {
      req.method = methodOverride.toUpperCase();
    } else {
      // Only default to GET if truly missing (shouldn't happen with Vercel)
      req.method = 'GET';
    }
  }
  
  // Log the method we're using (always log in Vercel to debug)
  if (process.env.VERCEL || process.env.NODE_ENV === 'development') {
    console.log('[CatchAll] Method preservation:', {
      original: originalMethod,
      final: req.method,
      path: path,
      hasBody: !!req.body,
      contentType: req.headers['content-type']
    });
  }
  
  // Don't delete query params here - let the main handler use them if needed
  // The main handler will use req.url which we've already set correctly
  
  // Call the main handler
  return handler(req, res);
}

