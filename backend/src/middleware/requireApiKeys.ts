import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.js';
import { getUserCredentials, createApiKeyRequiredError } from '../services/userCredentials.js';

export const requireLiveApiKeys = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Only check for live trading operations
    const isLiveMode = req.body?.mode === 'live' || req.query?.mode === 'live';
    
    if (!isLiveMode) {
      return next(); // Paper trading doesn't need API keys
    }

    if (req.user?.isLegacy) {
      return res.status(403).json({
        error: 'legacy_users_no_live_trading',
        message: 'Legacy users cannot use live trading. Please register a new account with API keys.',
        action: 'register_new_account'
      });
    }

    if (!req.user?.id) {
      return res.status(401).json({
        error: 'authentication_required',
        message: 'You must be authenticated to use live trading'
      });
    }

    const credentials = await getUserCredentials(req.user.id);
    
    if (!credentials) {
      return res.status(400).json(createApiKeyRequiredError());
    }

    // Store credentials in request for use by downstream handlers
    (req as any).userCredentials = credentials;
    next();
  } catch (error) {
    console.error('Live API keys check failed:', error);
    res.status(500).json({
      error: 'server_error',
      message: 'Failed to validate API keys'
    });
  }
};

export const requireApiKeysForLiveSession = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Check if this is a live session operation
    const sessionId = req.params.sessionId || req.body?.sessionId;
    
    if (sessionId) {
      // TODO: Check if session is in live mode by querying database
      // For now, we'll skip this check and let the operation handler deal with it
      return next();
    }

    // For session creation, use the existing requireLiveApiKeys middleware
    return requireLiveApiKeys(req, res, next);
  } catch (error) {
    console.error('Session API keys check failed:', error);
    res.status(500).json({
      error: 'server_error',
      message: 'Failed to validate session API keys'
    });
  }
};