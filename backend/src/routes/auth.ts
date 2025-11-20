import { Router } from 'express';
import { createHash } from 'crypto';
import { getConfig } from '../utils/env.js';
import { prisma } from '../db/client.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { recordOpsEvent } from '../monitor/ops.js';

export const router = Router();

const REGISTRATION_CODE = 'Shira1704';

function collectHeaderValues(...values: (string | string[] | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === 'string') {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') {
          out.push(entry);
        }
      }
    }
  }
  return out;
}

function normalizeToken(raw: string): string {
  return raw.replace(/^Bearer\s+/i, '').trim();
}

// Login endpoint
router.post('/login', async (req, res) => {
  try {
    const { username, password, code } = req.body || {};
    const cfg = getConfig();
    
    // Legacy authentication (backwards compatibility)
    const okByUser = (typeof username === 'string' && typeof password === 'string' && username === cfg.AUTH_USER && password === cfg.AUTH_PASS);
    const okByCode = (typeof code === 'string' && code && (code === (cfg.ACCESS_CODE || cfg.AUTH_PASS)));
    
    if (okByUser || okByCode) {
      return res.json({ 
        token: cfg.APP_API_KEY, 
        user: { id: 'legacy', username: username || 'admin', email: '', role: 'admin' } 
      });
    }

    // New user authentication
    if (username && password) {
      const user = await prisma.user.findUnique({
        where: { username: username.toLowerCase() }
      }).catch(() => null);

      if (user && (await bcrypt.compare(password, user.passwordHash))) {
        const token = jwt.sign(
          { userId: user.id, username: user.username, role: user.role },
          cfg.JWT_SECRET || cfg.APP_API_KEY,
          { expiresIn: '7d' }
        );
        
        return res.json({
          token,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            createdAt: user.createdAt
          }
        });
      }
    }

    return res.status(401).json({ error: 'invalid_credentials' });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

router.post('/ws-token', async (req, res) => {
  try {
    const cfg = getConfig();
    const tokens = collectHeaderValues(req.headers['x-api-key'], req.headers['authorization'])
      .map((value) => normalizeToken(value.trim()))
      .filter(Boolean);

    let identity:
      | { kind: 'apiKey'; id: string; fingerprint: string }
      | { kind: 'user'; id: string; username: string; role: string }
      | null = null;

    for (const candidate of tokens) {
      if (candidate === cfg.APP_API_KEY) {
        const fingerprint = createHash('sha256').update(candidate).digest('hex').slice(0, 16);
        identity = { kind: 'apiKey', id: 'app-key', fingerprint };
        break;
      }

      try {
        const decoded = jwt.verify(candidate, cfg.JWT_SECRET || cfg.APP_API_KEY) as any;
        if (decoded?.userId) {
          const user = await prisma.user
            .findUnique({ where: { id: decoded.userId } })
            .catch(() => null);
          if (user && user.isActive) {
            identity = {
              kind: 'user',
              id: user.id,
              username: user.username,
              role: user.role,
            };
            break;
          }
        }
      } catch (err) {
        // ignore, try next candidate
      }
    }

    if (!identity) {
      recordOpsEvent({
        level: 'warn',
        source: 'ws_auth',
        message: 'ws_token_denied',
        details: {
          reason: 'invalid_credentials',
          ip: req.ip,
        },
      });
      return res.status(401).json({
        error: 'unauthorized',
        code: 'ws.auth.required',
        message: 'Valid API key or session token is required to obtain a WebSocket credential.',
      });
    }

    const ttlSec = Math.max(15, Number(cfg.WS_JWT_TTL_SEC || 60));
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined;

    const payload: Record<string, any> = {
      sub: identity.id,
      kind: identity.kind,
      sessionId,
    };

    if (identity.kind === 'apiKey') {
      payload.fingerprint = identity.fingerprint;
    } else {
      payload.user = {
        id: identity.id,
        username: identity.username,
        role: identity.role,
      };
    }

    const token = jwt.sign(payload, cfg.WS_JWT_SECRET || cfg.JWT_SECRET || cfg.APP_API_KEY, {
      expiresIn: ttlSec,
    });

    recordOpsEvent({
      level: 'debug', // Changed from 'info' to reduce frontend noise
      source: 'ws_auth',
      message: 'ws_token_issued',
      details: {
        identity: identity.kind,
        sessionId,
        ip: req.ip,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return res.json({
      token,
      expiresIn: ttlSec,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('WS token issuance error:', error);
    recordOpsEvent({
      level: 'error',
      source: 'ws_auth',
      message: 'ws_token_error',
      details: { error: String((error as any)?.message || error) },
    });
    return res.status(500).json({ error: 'ws_token_error' });
  }
});

// Register endpoint
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, registrationCode } = req.body || {};

    // Validate required fields
    if (!username || !email || !password || !registrationCode) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Validate registration code
    if (registrationCode !== REGISTRATION_CODE) {
      return res.status(400).json({ error: 'invalid_registration_code' });
    }

    // Validate input formats
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'username_must_be_3_20_chars' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'password_must_be_at_least_6_chars' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'invalid_email_format' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username: username.toLowerCase() },
          { email: email.toLowerCase() }
        ]
      }
    }).catch(() => null);

    if (existingUser) {
      return res.status(400).json({ 
        error: existingUser.username === username.toLowerCase() ? 'username_already_exists' : 'email_already_exists' 
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        passwordHash,
        role: 'trader',
        isActive: true
      }
    });

    // Generate token
    const cfg = getConfig();
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      cfg.JWT_SECRET || cfg.APP_API_KEY,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Get current user info
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || req.headers['x-api-key'];
    if (!authHeader) {
      return res.status(401).json({ error: 'no_token_provided' });
    }

    const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const tokenStr = token.replace('Bearer ', '');
    const cfg = getConfig();

    // Legacy token check
    if (tokenStr === cfg.APP_API_KEY) {
      return res.json({
        user: { id: 'legacy', username: 'admin', email: '', role: 'admin' }
      });
    }

    // JWT token check
    try {
      const decoded = jwt.verify(tokenStr, cfg.JWT_SECRET || cfg.APP_API_KEY) as any;
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId }
      });

      if (user && user.isActive) {
        return res.json({
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            createdAt: user.createdAt
          }
        });
      }
    } catch (jwtError) {
      console.error('JWT verification failed:', jwtError);
    }

    return res.status(401).json({ error: 'invalid_token' });
  } catch (error) {
    console.error('Get user error:', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Update user profile
router.put('/profile', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(403).json({ error: 'legacy_users_cannot_update_profile' });
    }

    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email_required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'invalid_email_format' });
    }

    // Check if email is already taken by another user
    const existingUser = await prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        id: { not: req.user!.id }
      }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'email_already_exists' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user!.id },
      data: { email: email.toLowerCase() }
    });

    res.json({
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        role: updatedUser.role,
        createdAt: updatedUser.createdAt
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Change password
router.put('/password', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.isLegacy) {
      return res.status(403).json({ error: 'legacy_users_cannot_change_password' });
    }

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'password_must_be_at_least_6_chars' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id }
    });

    if (!user || !await bcrypt.compare(currentPassword, user.passwordHash)) {
      return res.status(400).json({ error: 'current_password_incorrect' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { passwordHash: newPasswordHash }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ error: 'server_error' });
  }
});
