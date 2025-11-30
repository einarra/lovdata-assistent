// Direct Vercel serverless function for /api/gdpr/consent
// This is a test to see if a direct route works better than the catch-all

import handler from '../index.js';

export const config = {
  maxDuration: 60,
  runtime: 'nodejs',
};

export default async function gdprConsentHandler(req, res) {
  console.log('[API/gdpr/consent.js] Direct route handler called:', {
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    query: req.query
  });
  
  // Reconstruct path - Vercel will pass 'consent' as the path
  // But we need '/gdpr/consent' for Express
  req.url = '/gdpr/consent';
  req.path = '/gdpr/consent';
  if (!req.originalUrl) {
    req.originalUrl = '/api/gdpr/consent';
  }
  
  // Call the main handler
  return handler(req, res);
}

