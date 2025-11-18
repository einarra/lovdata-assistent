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
        // Log error details for debugging
        const errorMessage = initError instanceof Error ? initError.message : String(initError);
        const errorStack = initError instanceof Error ? initError.stack : undefined;
        console.error('Serverless initialization failed:', errorMessage);
        if (errorStack && process.env.NODE_ENV === 'development') {
          console.error('Stack:', errorStack);
        }
      }
      
      // Create the Express app after initialization (or even if it failed)
      try {
        const { createApp } = await import('../backend/dist/http/app.js');
        const app = createApp();
        appInstance = app;
        return app;
      } catch (importError) {
        const errorMessage = importError instanceof Error ? importError.message : String(importError);
        const errorStack = importError instanceof Error ? importError.stack : undefined;
        console.error('Failed to import Express app:', errorMessage);
        if (errorStack) {
          console.error('Stack:', errorStack);
        }
        // Check if it's a module not found error
        if (errorMessage.includes('Cannot find module') || errorMessage.includes('ENOENT')) {
          throw new Error(`Backend not built. Missing: ${errorMessage}. Run 'npm run build' in the backend directory.`);
        }
        throw importError;
      }
    } catch (error) {
      // Even if everything fails, try to create a minimal app
      try {
        const { createApp } = await import('../backend/dist/http/app.js');
        const app = createApp();
        appInstance = app;
        return app;
      } catch (fallbackError) {
        // Log the original error for debugging
        console.error('Initialization completely failed. Original error:', error);
        console.error('Fallback also failed:', fallbackError);
        throw error; // Re-throw original error
      }
    }
  })();
  
  await initPromise;
  return appInstance;
}

// Export the handler for Vercel
export default async function handler(req, res) {
  // Log EVERY request at the entry point to see what Vercel is sending
  console.log('[API/index.js] Entry point:', {
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    query: req.query,
    headers: {
      'content-type': req.headers['content-type'],
      'authorization': req.headers.authorization ? 'present' : 'missing',
      'x-http-method-override': req.headers['x-http-method-override']
    }
  });
  
  // Quick health check that doesn't require backend initialization
  const path = (req.url || req.path || '/').replace(/^\/api/, '') || '/';
  if (path === '/health' && req.method === 'GET') {
    try {
      const app = await initializeApp();
      // If we got here, pass to Express
    } catch (error) {
      // Even if backend fails, return a basic health response
      if (!res.headersSent) {
        res.status(503).json({ 
          status: 'degraded',
          message: 'Backend not initialized',
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
  }

  try {
    // Ensure app is initialized
    let app;
    try {
      app = await initializeApp();
    } catch (initError) {
      // If initialization fails completely, return a helpful error
      const errorMessage = initError instanceof Error ? initError.message : String(initError);
      console.error('App initialization failed:', errorMessage);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: 'Backend initialization failed', 
          message: errorMessage,
          hint: 'Check that backend/dist directory exists. Run "npm run build" in the backend directory.',
          ...(process.env.NODE_ENV === 'development' && { 
            stack: initError instanceof Error ? initError.stack : undefined 
          })
        });
      }
      return;
    }
    
    // Handle path reconstruction
    // Vercel routes /api/* to this function, but Express expects paths without /api
    // If called from catch-all handler, path is already set correctly
    // Otherwise, we need to reconstruct it
    let path = req.url || req.path || '/';
    
    // Check if this came from the catch-all handler (has ...path in query)
    // The catch-all handler should have already set req.url, but check query as fallback
    if (req.query && (req.query['...path'] || req.query.path)) {
      const pathParam = req.query['...path'] || req.query.path;
      if (Array.isArray(pathParam)) {
        path = '/' + pathParam.join('/');
      } else if (typeof pathParam === 'string' && pathParam.length > 0) {
        path = pathParam.startsWith('/') ? pathParam : '/' + pathParam;
      }
    } else if (path.startsWith('/api')) {
      // Direct call to index.js with /api prefix - strip it
      path = path.replace(/^\/api/, '') || '/';
    }
    
    // Update all path-related properties
    req.url = path;
    req.path = path;
    if (!req.originalUrl) {
      req.originalUrl = '/api' + path;
    }
    
    // Debug logging in development and Vercel
    if (process.env.NODE_ENV === 'development' || process.env.VERCEL) {
      console.log('[API] Path reconstruction:', {
        originalUrl: req.originalUrl,
        url: req.url,
        path: req.path,
        method: req.method,
        incomingMethod: req.method || req.headers['x-http-method-override'] || 'UNKNOWN',
        query: req.query,
        headers: {
          'content-type': req.headers['content-type'],
          'authorization': req.headers.authorization ? 'present' : 'missing'
        }
      });
    }
    
    // Ensure request has all necessary properties for Express
    // Vercel's req/res should be compatible, but let's make sure
    // CRITICAL: Preserve the HTTP method - don't override if it's already set
    // Only set default if method is truly missing (shouldn't happen with Vercel)
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
      // CRITICAL: Handle request body for Vercel serverless functions
      // Vercel typically provides req.body as already parsed JSON (if content-type is JSON)
      // OR as a string/Buffer that needs parsing
      // Express's json() middleware expects a readable stream, which Vercel doesn't provide
      // So we need to handle body parsing ourselves if Vercel hasn't already done it
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          // If body is a string, parse it (Vercel sometimes provides it as string)
          if (typeof req.body === 'string' && req.body.length > 0) {
            try {
              req.body = JSON.parse(req.body);
              console.log('[API] Parsed JSON body from string');
            } catch (parseError) {
              console.error('[API] Failed to parse JSON body:', parseError);
              // Set to empty object so Express doesn't crash
              req.body = {};
            }
          } else if (req.body === undefined || req.body === null) {
            // Vercel should provide the body, but if it doesn't, we can't read from stream
            // Set to empty object - the route handler will handle missing body
            req.body = {};
            console.warn('[API] Request body is missing for', req.method, req.url);
          }
          // If body is already an object, leave it as is (Vercel already parsed it)
        }
      } else if (!req.body) {
        // For non-body methods (GET, DELETE, etc.), safe to initialize as empty object
        req.body = {};
      }
      if (!req.params) {
        req.params = {};
      }
      
      // Express expects certain properties on the request
      // Preserve the original method - don't override it
      if (!req.method) {
        req.method = 'GET';
      }
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
      
      // Log before calling Express
      console.log('[API/index.js] About to call Express app:', {
        method: req.method,
        url: req.url,
        path: req.path,
        originalUrl: req.originalUrl,
        hasBody: !!req.body,
        bodyType: typeof req.body
      });
      
      try {
        app(req, res, (err) => {
          clearTimeout(timeout);
          if (err) {
            console.error('[API/index.js] Express error handler called:', {
              error: err.message,
              statusCode: err.statusCode || err.status,
              path: req.path,
              method: req.method
            });
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
            // If Express didn't send a response, send 404 with debug info
            console.warn('[API/index.js] Express did not send response - route not found:', {
              method: req.method,
              url: req.url,
              path: req.path,
              originalUrl: req.originalUrl
            });
            const errorResponse = { 
              error: 'Not found', 
              path: req.url, 
              method: req.method,
              originalUrl: req.originalUrl,
              reconstructedPath: req.path
            };
            // Always include debug info to help diagnose routing issues
            if (process.env.NODE_ENV === 'development' || process.env.VERCEL) {
              errorResponse.debug = {
                baseUrl: req.baseUrl,
                query: req.query,
                headers: {
                  'content-type': req.headers['content-type'],
                  'authorization': req.headers.authorization ? 'present' : 'missing'
                }
              };
            }
            res.status(404).json(errorResponse);
            if (!responseEnded) {
              responseEnded = true;
              resolve();
            }
          } else {
            console.log('[API/index.js] Express sent response successfully:', {
              method: req.method,
              path: req.path,
              statusCode: res.statusCode
            });
          }
          // Response was sent, wait for it to end
          // The res.end wrapper will call resolve
        });
      } catch (expressError) {
        clearTimeout(timeout);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Failed to process request', 
            message: expressError.message,
            ...(process.env.NODE_ENV === 'development' && { stack: expressError.stack })
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

