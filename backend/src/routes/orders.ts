import { Router } from "express";
import { prisma } from "../db/client.js";
export const router = Router();
router.get("/", async (_req, res) =>
  res.json(
    await prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 200 })
  )
);
