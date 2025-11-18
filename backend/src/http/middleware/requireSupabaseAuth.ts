import type { Request, Response, NextFunction } from 'express';
import { verifySupabaseJwt } from '../../auth/verifySupabaseJwt.js';
import { logger } from '../../logger.js';

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    role?: string;
    token: string;
  };
}

export async function requireSupabaseAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    
    // Log auth attempt for debugging (always log in Vercel)
    if (process.env.VERCEL || process.env.NODE_ENV === 'development') {
      logger.info({
        path: req.path,
        method: req.method,
        hasAuthHeader: !!authHeader,
        authHeaderPrefix: authHeader?.substring(0, 20) || 'missing'
      }, 'Auth middleware: checking authorization');
    }
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn({
        path: req.path,
        method: req.method,
        hasAuthHeader: !!authHeader,
        authHeaderValue: authHeader ? 'present but invalid format' : 'missing'
      }, 'Auth failed: Authorization header missing or invalid format');
      
      res.status(401).json({ 
        message: 'Authorization header missing',
        hint: 'Include Authorization header with format: Bearer <token>'
      });
      return;
    }

    const token = authHeader.substring('Bearer '.length).trim();
    if (!token) {
      res.status(401).json({ 
        message: 'Invalid authorization header',
        hint: 'Token is empty. Check that the session token is being sent correctly.'
      });
      return;
    }

    const { payload } = await verifySupabaseJwt(token);
    
    // Log successful auth
    if (process.env.VERCEL || process.env.NODE_ENV === 'development') {
      logger.info({
        path: req.path,
        method: req.method,
        userId: payload.sub,
        hasRole: !!payload.role
      }, 'Auth successful');
    }
    
    (req as AuthenticatedRequest).auth = {
      userId: payload.sub,
      role: typeof payload.role === 'string' ? payload.role : undefined,
      token
    };
    next();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error }, 'Supabase auth verification failed');
    
    // Provide more helpful error messages
    let message = 'Unauthorized';
    let hint: string | undefined;
    
    if (errorMessage.includes('not configured') || errorMessage.includes('SUPABASE_URL') || errorMessage.includes('SUPABASE_SERVICE_ROLE_KEY')) {
      message = 'Supabase not configured';
      hint = 'Check that SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Vercel environment variables';
    } else if (errorMessage.includes('Invalid') || errorMessage.includes('token')) {
      message = 'Invalid token';
      hint = 'The authentication token is invalid or expired. Please log in again.';
    } else if (errorMessage.includes('getUser')) {
      message = 'Token verification failed';
      hint = 'Unable to verify token with Supabase. Check Supabase configuration.';
    }
    
    res.status(401).json({ 
      message,
      ...(hint && { hint }),
      ...(process.env.NODE_ENV === 'development' && { error: errorMessage })
    });
  }
}
