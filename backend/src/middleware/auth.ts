import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig } from '../utils/env.js';
import { prisma } from '../db/client.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: string;
  };
}

export const authenticateUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization || req.headers['x-api-key'];
    if (!authHeader) {
      return res.status(401).json({ error: 'no_token_provided' });
    }

    const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const tokenStr = token.replace('Bearer ', '');
    const cfg = getConfig();

    // JWT token check
    try {
      const decoded = jwt.verify(tokenStr, cfg.JWT_SECRET) as any;
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId }
      });

      if (user && user.isActive) {
        req.user = {
          id: user.id,
          username: user.username,
          role: user.role
        };
        return next();
      }
    } catch (jwtError) {
      console.error('JWT verification failed:', jwtError);
    }

    return res.status(401).json({ error: 'invalid_token' });
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({ error: 'authentication_error' });
  }
};

export const requireRole = (roles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'authentication_required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'insufficient_permissions' });
    }

    next();
  };
};