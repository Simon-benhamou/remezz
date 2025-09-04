import type { Request, Response, NextFunction } from "express";
import { getConfig } from "./env.js";
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const cfg = getConfig();
  if (!cfg.REQUIRE_API_KEY) return next();
  const key = req.header("x-api-key") || "";
  if (key === cfg.APP_API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}
