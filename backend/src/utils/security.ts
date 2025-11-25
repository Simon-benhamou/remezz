import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getConfig } from "./env.js";
import { prisma } from "../db/client.js";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: string;
    isLegacy?: boolean;
  };
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const cfg = getConfig();
  
  // If API key not required, still try to extract user but don't fail
  const authHeader = req.headers.authorization || req.headers['x-api-key'];
  
  if (!authHeader && !cfg.REQUIRE_API_KEY) {
    return next();
  }
  
  if (!authHeader) {
    return res.status(401).json({ error: "unauthorized" });
  }
  
  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const tokenStr = token.replace('Bearer ', '');
  
  // Legacy API key check - grant full access as admin
  if (tokenStr === cfg.APP_API_KEY) {
    (req as AuthenticatedRequest).user = { 
      id: 'legacy', 
      username: 'admin', 
      role: 'admin',
      isLegacy: true
    };
    return next();
  }
  
  // JWT token check
  try {
    const decoded = jwt.verify(tokenStr, cfg.JWT_SECRET || cfg.APP_API_KEY || 'default-secret') as any;
    
    if (decoded.userId) {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId }
      });
      
      if (user && user.isActive) {
        (req as AuthenticatedRequest).user = {
          id: user.id,
          username: user.username,
          role: user.role
        };
        return next();
      }
    }
  } catch (jwtError) {
    // JWT verification failed, fall through to error
    console.warn('JWT verification failed:', (jwtError as Error).message);
  }
  
  // If we get here and REQUIRE_API_KEY is false, allow through without user
  if (!cfg.REQUIRE_API_KEY) {
    return next();
  }
  
  return res.status(401).json({ error: "unauthorized" });
}
