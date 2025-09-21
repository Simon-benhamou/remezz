import { Router } from 'express';
import { getAllIntelligentOpportunities } from '../services/smartAgent.js';

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