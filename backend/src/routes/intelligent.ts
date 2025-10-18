import { Router } from 'express';
import { getAllIntelligentOpportunities } from '../services/smartAgent.js';
import {
  evaluateOpportunity as evaluateEvOpportunity,
  fitProbabilityModel as fitEvProbabilityModel,
  updateBandit as updateEvBandit,
} from '../services/intelligentAgent.js';

export const router = Router();

// Get all intelligent opportunities
router.get('/intelligent-opportunities', async (req, res) => {
  try {
    console.log('🧠 API: Fetching intelligent opportunities...');
    const opportunities = await getAllIntelligentOpportunities();
    
    res.json({
      success: true,
      count: opportunities.length,
      data: opportunities,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching intelligent opportunities:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch intelligent opportunities',
      data: []
    });
  }
});

router.post('/ai/opportunities/rank', async (req, res) => {
  try {
    const { symbol, equityUsd, contextFeatures, playbooks, now } = req.body || {};
    if (typeof symbol !== 'string' || !Number.isFinite(Number(equityUsd))) {
      return res.status(400).json({ success: false, error: 'symbol and equityUsd are required' });
    }
    const result = await evaluateEvOpportunity(symbol, Number(equityUsd), {
      context: contextFeatures,
      playbooks,
      now: typeof now === 'number' ? now : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('Error ranking opportunity:', error);
    res.status(500).json({ success: false, error: error?.message || 'internal_error' });
  }
});

router.post('/ai/bandit/update', async (req, res) => {
  try {
    const { symbol, ctx, action, reward } = req.body || {};
    const allowedActions = ['PULLBACK', 'BREAKOUT', 'MR'] as const;
    const isStrategyKind = (value: unknown): value is typeof allowedActions[number] =>
      typeof value === 'string' && allowedActions.includes(value as typeof allowedActions[number]);
    if (typeof symbol !== 'string' || !ctx || !isStrategyKind(action) || !Number.isFinite(Number(reward))) {
      return res.status(400).json({ success: false, error: 'invalid payload' });
    }
    updateEvBandit(symbol, ctx, action, Number(reward));
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating bandit:', error);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
});

router.post('/ai/model/fit', async (req, res) => {
  try {
    const { dataset } = req.body || {};
    if (!Array.isArray(dataset) || !dataset.length) {
      return res.status(400).json({ success: false, error: 'dataset array required' });
    }
    fitEvProbabilityModel(dataset);
    res.json({ success: true, count: dataset.length });
  } catch (error: any) {
    console.error('Error fitting probability model:', error);
    res.status(500).json({ success: false, error: error?.message || 'internal_error' });
  }
});