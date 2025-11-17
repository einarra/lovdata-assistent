// Vercel serverless function wrapper for Express backend
// This file must be in the root /api directory for Vercel to recognize it

// Note: This is a serverless function entry point
// The backend needs to be built before deployment (npm run build in backend/)

// Initialize the app once (module-level cache)
// This will be reused across invocations in the same container
let appInstance = null;
let initPromise = null;

async function initializeApp() {
  if (appInstance) {
    return appInstance;
  }
  
  if (initPromise) {
    await initPromise;
    return appInstance;
  }
  
  initPromise = (async () => {
    try {
      // Initialize serverless backend (sets up archive store, etc.)
      const { initializeServerless } = await import('../backend/dist/serverless.js');
      await initializeServerless();
      
      // Create the Express app after initialization
      const { createApp } = await import('../backend/dist/http/app.js');
      const app = createApp();
      appInstance = app;
      return app;
    } catch (error) {
      console.error('Failed to initialize backend:', error);
      // Fallback: create app without full initialization
      // This allows the app to start even if some services aren't ready
      const { createApp } = await import('../backend/dist/http/app.js');
      const app = createApp();
      appInstance = app;
      return app;
    }
  })();
  
  await initPromise;
  return appInstance;
}

// Export the handler for Vercel
export default async function handler(req, res) {
  // Ensure app is initialized
  const app = await initializeApp();
  
  // Strip /api prefix from the request path
  // Vercel routes /api/* to this function, but Express expects paths without /api
  if (req.url && req.url.startsWith('/api')) {
    // Update all path-related properties
    req.url = req.url.replace(/^\/api/, '') || '/';
    req.originalUrl = req.originalUrl ? req.originalUrl.replace(/^\/api/, '') || '/' : req.url;
    if (req.path) {
      req.path = req.path.replace(/^\/api/, '') || '/';
    }
    if (req.baseUrl) {
      req.baseUrl = req.baseUrl.replace(/^\/api/, '') || '';
    }
  }
  
  // Vercel's req/res are compatible with Express
  // Use the Express app to handle the request
  return new Promise((resolve, reject) => {
    // Ensure response is properly handled
    const originalEnd = res.end.bind(res);
    res.end = function(...args) {
      originalEnd(...args);
      resolve();
    };
    
    app(req, res, (err) => {
      if (err) {
        reject(err);
      } else if (!res.headersSent) {
        // If Express didn't send a response, resolve anyway
        resolve();
      }
    });
  });
}

