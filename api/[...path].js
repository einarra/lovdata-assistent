// Vercel catch-all serverless function for /api/* routes
// This handles all API routes like /api/health, /api/assistant/run, etc.

import handler from './index.js';

// Export handler that reconstructs the path from Vercel's path parameter
export default async function catchAllHandler(req, res) {
  // Log EVERY request at the entry point - this is critical for debugging
  console.log('[API/[...path].js] Catch-all entry point:', {
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    query: req.query,
    '...path': req.query['...path'],
    headers: {
      'content-type': req.headers['content-type'],
      'authorization': req.headers.authorization ? 'present' : 'missing',
      'x-http-method-override': req.headers['x-http-method-override']
    }
  });
  
  // Log the incoming request method for debugging
  const incomingMethod = req.method || req.headers['x-http-method-override'] || 'UNKNOWN';
  
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
  
  // WARNING: Detect when a POST route receives GET (common issue)
  const postRoutes = ['/assistant/run', '/skills/run'];
  if (postRoutes.includes(path)) {
    if (req.method === 'GET') {
      console.error('[CatchAll] ERROR: POST route received GET request!', {
        path: path,
        method: req.method,
        originalMethod: originalMethod,
        url: req.url,
        query: req.query,
        headers: {
          ...req.headers,
          'content-type': req.headers['content-type'],
          'content-length': req.headers['content-length'],
          'authorization': req.headers.authorization ? 'present' : 'missing'
        },
        hasBody: !!req.body,
        bodyType: typeof req.body,
        bodyPreview: req.body ? JSON.stringify(req.body).substring(0, 100) : 'none'
      });
    } else {
      console.log('[CatchAll] POST route received correctly:', {
        path: path,
        method: req.method,
        hasBody: !!req.body,
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
        authorization: req.headers.authorization ? 'present' : 'missing'
      });
    }
  }
  
  // Special logging for assistant/run to help diagnose issues
  if (path === '/assistant/run') {
    console.log('[CatchAll] Assistant run request detected:', {
      method: req.method,
      path: path,
      hasBody: !!req.body,
      bodyType: typeof req.body,
      bodyPreview: req.body && typeof req.body === 'object' ? JSON.stringify(req.body).substring(0, 200) : (typeof req.body === 'string' ? req.body.substring(0, 200) : 'none'),
      contentType: req.headers['content-type'],
      authorization: req.headers.authorization ? 'present' : 'missing'
    });
  }
  
  // Don't delete query params here - let the main handler use them if needed
  // The main handler will use req.url which we've already set correctly
  
  // Call the main handler
  return handler(req, res);
}

