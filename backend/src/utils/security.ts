import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getConfig } from "./env.js";
import { prisma } from "../db/client.js";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: string;
  };
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const cfg = getConfig();

  const authHeader = req.headers.authorization || req.headers['x-api-key'];

  if (!authHeader) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const tokenStr = token.replace('Bearer ', '');

  // JWT token check
  try {
    const decoded = jwt.verify(tokenStr, cfg.JWT_SECRET) as any;

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

  return res.status(401).json({ error: "unauthorized" });
}
