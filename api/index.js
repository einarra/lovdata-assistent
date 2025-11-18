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
      try {
        const { initializeServerless } = await import('../backend/dist/serverless.js');
        await initializeServerless();
      } catch (initError) {
        // Continue even if initialization fails - some endpoints may still work
        if (process.env.NODE_ENV === 'development') {
          console.error('Serverless initialization failed, continuing with basic app:', initError);
        }
      }
      
      // Create the Express app after initialization (or even if it failed)
      const { createApp } = await import('../backend/dist/http/app.js');
      const app = createApp();
      appInstance = app;
      return app;
    } catch (error) {
      // Even if everything fails, try to create a minimal app
      try {
        const { createApp } = await import('../backend/dist/http/app.js');
        const app = createApp();
        appInstance = app;
        return app;
      } catch (fallbackError) {
        throw error; // Re-throw original error
      }
    }
  })();
  
  await initPromise;
  return appInstance;
}

// Export the handler for Vercel
export default async function handler(req, res) {
  try {
    // Ensure app is initialized
    const app = await initializeApp();
    
    // Handle path reconstruction
    // Vercel routes /api/* to this function, but Express expects paths without /api
    // If called from catch-all handler, path is already set correctly
    // Otherwise, we need to reconstruct it
    let path = req.url || req.path || '/';
    
    // If path starts with /api, strip it (direct call to index.js)
    if (path.startsWith('/api')) {
      path = path.replace(/^\/api/, '') || '/';
    }
    
    // If we have query.path (from catch-all that didn't set it), use that
    // But catch-all should have already set req.url, so this is a fallback
    if (req.query && req.query.path && (path === '/' || path === '')) {
      const pathSegments = Array.isArray(req.query.path) 
        ? req.query.path 
        : [req.query.path];
      path = '/' + pathSegments.join('/');
    }
    
    // Update all path-related properties
    req.url = path;
    req.path = path;
    if (!req.originalUrl) {
      req.originalUrl = '/api' + path;
    }
    
    // Ensure request has all necessary properties for Express
    // Vercel's req/res should be compatible, but let's make sure
    if (!req.method) {
      req.method = 'GET';
    }
    if (!req.url) {
      req.url = path;
    }
    if (!req.path) {
      req.path = path;
    }
    if (!req.originalUrl) {
      req.originalUrl = '/api' + path;
    }
    if (!req.baseUrl) {
      req.baseUrl = '';
    }
    
    // Vercel's req/res are compatible with Express
    // Use the Express app to handle the request
    return new Promise((resolve) => {
      let responseEnded = false;
      
      // Save original method BEFORE setting up wrapper
      const originalEnd = res.end.bind(res);
      
      // Override res.end to track completion - MUST be set before calling Express
      res.end = function(...args) {
        const result = originalEnd(...args);
        if (!responseEnded) {
          responseEnded = true;
          clearInterval(checkExpressResponse);
          // Give Vercel a moment to process the response
          setTimeout(() => {
            resolve();
          }, 0);
        }
        return result;
      };
      
      // Add timeout to detect if Express doesn't respond
      const timeout = setTimeout(() => {
        if (!responseEnded && !res.headersSent) {
          if (!res.headersSent) {
            res.status(404).json({ error: 'Not found', path: req.url, method: req.method });
          }
          if (!responseEnded) {
            responseEnded = true;
            resolve();
          }
        }
      }, 5000);
      
      // Ensure request has all properties Express expects
      if (!req.headers) {
        req.headers = {};
      }
      if (!req.query) {
        req.query = {};
      }
      if (!req.body) {
        req.body = {};
      }
      if (!req.params) {
        req.params = {};
      }
      
      // Express expects certain properties on the request
      req.method = req.method || 'GET';
      req.url = req.url || path;
      req.path = req.path || path;
      req.originalUrl = req.originalUrl || '/api' + path;
      req.baseUrl = req.baseUrl || '';
      req.protocol = req.protocol || 'https';
      req.hostname = req.hostname || req.headers.host || 'localhost';
      req.ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
      
      // Set up response tracking before calling Express
      const checkExpressResponse = setInterval(() => {
        if (res.headersSent) {
          clearInterval(checkExpressResponse);
        }
      }, 10);
      
      // Clear interval after timeout
      setTimeout(() => {
        clearInterval(checkExpressResponse);
      }, 1000);
      
      try {
        app(req, res, (err) => {
          clearTimeout(timeout);
          if (err) {
            if (!res.headersSent) {
              const statusCode = err.statusCode || err.status || 500;
              res.status(statusCode).json({ 
                error: 'Internal server error', 
                message: err.message,
                ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
              });
            }
            if (!responseEnded) {
              responseEnded = true;
              resolve();
            }
          } else if (!res.headersSent) {
            // If Express didn't send a response, send 404
            res.status(404).json({ error: 'Not found', path: req.url, method: req.method });
            if (!responseEnded) {
              responseEnded = true;
              resolve();
            }
          }
          // Response was sent, wait for it to end
          // The res.end wrapper will call resolve
        });
      } catch (expressError) {
        clearTimeout(timeout);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Failed to process request', 
            message: expressError.message 
          });
        }
        if (!responseEnded) {
          responseEnded = true;
          resolve();
        }
      }
    });
  } catch (error) {
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

