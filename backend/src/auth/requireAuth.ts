import type { Request, Response, NextFunction } from 'express';
import { verifySupabaseJwt } from './verifySupabaseJwt.js';

export type AuthenticatedRequest = Request & {
  user?: {
    id: string;
    role?: string;
    email?: string;
  };
};

const UNAUTHORIZED = { message: 'Unauthorized' };

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    const { payload } = await verifySupabaseJwt(token);
    if (!payload.sub) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }
    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      role: typeof payload.role === 'string' ? payload.role : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined
    };
    next();
  } catch (error) {
    res.status(401).json(UNAUTHORIZED);
  }
}

