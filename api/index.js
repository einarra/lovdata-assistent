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
    // If called from catch-all handler, path is already set correctly
    // Otherwise, we need to reconstruct it
    let path = req.url || req.path || '/';
    
    // If path starts with /api, strip it (direct call to index.js)
    if (path.startsWith('/api')) {
      path = path.replace(/^\/api/, '') || '/';
      console.log(`[API] Stripped /api prefix, new path: ${path}`);
    }
    
    // If we have query.path (from catch-all that didn't set it), use that
    // But catch-all should have already set req.url, so this is a fallback
    if (req.query && req.query.path && (path === '/' || path === '')) {
      const pathSegments = Array.isArray(req.query.path) 
        ? req.query.path 
        : [req.query.path];
      path = '/' + pathSegments.join('/');
      console.log(`[API] Reconstructed path from query (fallback): ${path}`);
    }
    
    // Update all path-related properties
    req.url = path;
    req.path = path;
    if (!req.originalUrl) {
      req.originalUrl = '/api' + path;
    }
    
    console.log(`[API] Final path for Express: ${path}`);
    console.log(`[API] Request method: ${req.method}`);
    console.log(`[API] Final req.url: ${req.url}`);
    console.log(`[API] Final req.path: ${req.path}`);
    console.log(`[API] Final req.originalUrl: ${req.originalUrl}`);
    
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
      
      // Track when response ends
      const originalEnd = res.end.bind(res);
      res.end = function(...args) {
        if (!responseEnded) {
          responseEnded = true;
          resolve();
        }
        return originalEnd(...args);
      };
      
      // Add timeout to detect if Express doesn't respond
      const timeout = setTimeout(() => {
        if (!responseEnded && !res.headersSent) {
          console.error('[API] Timeout: Express did not send a response');
          if (!res.headersSent) {
            res.status(404).json({ error: 'Not found', path: req.url, method: req.method });
          }
          if (!responseEnded) {
            responseEnded = true;
            resolve();
          }
        }
      }, 5000);
      
      // Call Express app handler
      // Express app is a function, so call it directly
      console.log(`[API] Calling app() with method: ${req.method}, url: ${req.url}`);
      console.log(`[API] Request object type: ${typeof req}, has method: ${!!req.method}, has url: ${!!req.url}`);
      console.log(`[API] Response object type: ${typeof res}, has status: ${typeof res.status === 'function'}, has json: ${typeof res.json === 'function'}`);
      
      // Ensure request has all properties Express expects
      // Vercel's req/res should be compatible, but let's be explicit
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
      // Ensure they're set correctly
      req.method = req.method || 'GET';
      req.url = req.url || path;
      req.path = req.path || path;
      req.originalUrl = req.originalUrl || '/api' + path;
      req.baseUrl = req.baseUrl || '';
      req.protocol = req.protocol || 'https';
      req.hostname = req.hostname || req.headers.host || 'localhost';
      req.ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
      
      console.log(`[API] About to call app(), req properties: method=${req.method}, url=${req.url}, path=${req.path}`);
      console.log(`[API] Express app type: ${typeof app}, is function: ${typeof app === 'function'}`);
      
      // Set up response tracking before calling Express
      let expressProcessed = false;
      const checkExpressResponse = setInterval(() => {
        if (res.headersSent && !expressProcessed) {
          expressProcessed = true;
          clearInterval(checkExpressResponse);
          console.log(`[API] Express sent response! headersSent: ${res.headersSent}`);
        }
      }, 10);
      
      // Clear interval after timeout
      setTimeout(() => {
        clearInterval(checkExpressResponse);
        if (!expressProcessed && !res.headersSent) {
          console.error(`[API] Express did not process request after 1 second`);
        }
      }, 1000);
      
      try {
        const result = app(req, res, (err) => {
          console.log(`[API] Express callback invoked! err=${err ? err.message : 'none'}, headersSent=${res.headersSent}`);
        clearTimeout(timeout);
        console.log(`[API] app() callback called, err: ${err ? err.message : 'none'}, headersSent: ${res.headersSent}`);
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
          if (!responseEnded) {
            responseEnded = true;
            resolve();
          }
        } else if (!res.headersSent) {
          // If Express didn't send a response, send 404
          console.error(`[API] Express did not handle route: ${req.method} ${req.url}`);
          console.error(`[API] Response headers sent: ${res.headersSent}, response ended: ${responseEnded}`);
          res.status(404).json({ error: 'Not found', path: req.url, method: req.method });
          if (!responseEnded) {
            responseEnded = true;
            resolve();
          }
        } else {
          console.log(`[API] Express handled route successfully, headers sent: ${res.headersSent}`);
          // Response was sent, wait for it to end
          // The res.end wrapper will call resolve
        }
      });
      
      console.log(`[API] app() call completed, result: ${result}, type: ${typeof result}`);
      } catch (expressError) {
        clearTimeout(timeout);
        console.error('[API] Error calling Express app:', expressError);
        console.error('[API] Error stack:', expressError.stack);
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

