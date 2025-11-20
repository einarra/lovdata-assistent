// Explicit route handler for /api/documents/xml
// This ensures Vercel routes GET requests to this endpoint correctly
// It delegates to the main handler (index.js) for actual processing

import mainHandler from '../index.js';

export default async function handler(req, res) {
  // Log that we're in the explicit route handler
  console.log('[API/documents/xml.js] Explicit route handler called:', {
    method: req.method,
    url: req.url,
    path: req.path,
    query: req.query,
    queryString: req.url?.split('?')[1]
  });
  
  // Set up the path so the main handler processes it correctly
  // The main handler expects paths without /api prefix
  // Preserve the query string
  const queryString = req.url?.includes('?') ? req.url.split('?')[1] : '';
  req.url = '/documents/xml' + (queryString ? '?' + queryString : '');
  req.path = '/documents/xml';
  if (!req.originalUrl) {
    req.originalUrl = '/api/documents/xml' + (queryString ? '?' + queryString : '');
  }
  
  // Ensure query params are preserved
  // Query params should already be parsed by Vercel, but log for debugging
  if (req.query) {
    console.log('[API/documents/xml.js] Query params:', req.query);
  }
  
  // Call the main handler
  return mainHandler(req, res);
}

