import type { Request, Response, NextFunction } from 'express';
import { verifySupabaseJwt } from '../../auth/verifySupabaseJwt.js';

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
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ message: 'Authorization header missing' });
      return;
    }

    const token = authHeader.substring('Bearer '.length).trim();
    if (!token) {
      res.status(401).json({ message: 'Invalid authorization header' });
      return;
    }

    const { payload } = await verifySupabaseJwt(token);
    (req as AuthenticatedRequest).auth = {
      userId: payload.sub,
      role: typeof payload.role === 'string' ? payload.role : undefined,
      token
    };
    next();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Supabase auth verification failed:', error);
    res.status(401).json({ message: 'Unauthorized' });
  }
}
