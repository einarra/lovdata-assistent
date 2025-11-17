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
      console.log('Starting backend initialization...');
      // Initialize serverless backend (sets up archive store, etc.)
      try {
        const { initializeServerless } = await import('../backend/dist/serverless.js');
        await initializeServerless();
        console.log('Serverless backend initialized successfully');
      } catch (initError) {
        console.error('Serverless initialization failed, continuing with basic app:', initError);
        // Continue even if initialization fails - some endpoints may still work
      }
      
      // Create the Express app after initialization (or even if it failed)
      const { createApp } = await import('../backend/dist/http/app.js');
      const app = createApp();
      appInstance = app;
      console.log('Express app created successfully');
      return app;
    } catch (error) {
      console.error('Failed to create Express app:', error);
      console.error('Error stack:', error.stack);
      // Even if everything fails, try to create a minimal app
      try {
        const { createApp } = await import('../backend/dist/http/app.js');
        const app = createApp();
        appInstance = app;
        return app;
      } catch (fallbackError) {
        console.error('Fallback app creation also failed:', fallbackError);
        throw error; // Re-throw original error
      }
    }
  })();
  
  await initPromise;
  return appInstance;
}

// Export the handler for Vercel
export default async function handler(req, res) {
  // Log request for debugging
  console.log(`[API] ${req.method} ${req.url || req.path || '/'}`);
  console.log(`[API] Query:`, req.query);
  console.log(`[API] Original URL:`, req.originalUrl);
  
  try {
    // Ensure app is initialized
    const app = await initializeApp();
    
    // Handle path reconstruction
    // Vercel routes /api/* to this function, but Express expects paths without /api
    let path = req.url || req.path || '/';
    
    // If path starts with /api, strip it
    if (path.startsWith('/api')) {
      path = path.replace(/^\/api/, '') || '/';
    }
    
    // If we have query.path (from catch-all), use that instead
    if (req.query && req.query.path) {
      const pathSegments = Array.isArray(req.query.path) 
        ? req.query.path 
        : [req.query.path];
      path = '/' + pathSegments.join('/');
      console.log(`[API] Reconstructed path from query: ${path}`);
    }
    
    // Update all path-related properties
    req.url = path;
    req.path = path;
    if (!req.originalUrl) {
      req.originalUrl = '/api' + path;
    }
    
    console.log(`[API] Final path: ${path}`);
    console.log(`[API] Request method: ${req.method}`);
    console.log(`[API] Request headers:`, JSON.stringify(req.headers, null, 2));
    
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
          console.error('Express error:', err);
          console.error('Express error stack:', err.stack);
          if (!res.headersSent) {
            const statusCode = err.statusCode || err.status || 500;
            res.status(statusCode).json({ 
              error: 'Internal server error', 
              message: err.message,
              ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
            });
          }
          resolve(); // Don't reject, just resolve after sending error
        } else if (!res.headersSent) {
          // If Express didn't send a response, send 404
          res.status(404).json({ error: 'Not found', path: req.url });
          resolve();
        } else {
          resolve(); // Response was sent, resolve
        }
      });
    });
  } catch (error) {
    console.error('Handler error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to initialize server', 
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
    throw error;
  }
}

