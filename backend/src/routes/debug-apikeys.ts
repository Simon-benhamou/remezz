import { Router } from 'express';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../db/client.js';

export const router = Router();

// Debug endpoint to check if API keys exist
router.get('/check-apikeys', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user?.id) {
      return res.json({ error: 'not_authenticated', userId: null });
    }

    const apiKeys = await prisma.userApiKey.findMany({
      where: { userId: req.user.id },
      select: {
        id: true,
        exchange: true,
        testnet: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        keyName: true
      }
    });

    return res.json({
      userId: req.user.id,
      username: req.user.username,
      isLegacy: req.user.isLegacy,
      apiKeysCount: apiKeys.length,
      apiKeys: apiKeys
    });
  } catch (error: any) {
    console.error('Debug API keys check error:', error);
    return res.status(500).json({ error: error.message });
  }
});
