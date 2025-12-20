const express = require('express');
const { query, body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { generateSummary, generateSuggestions, generateSummaryForReports } = require('../services/ai');

const router = express.Router();

/**
 * Get AI Summary
 * GET /v1/ai/summary
 */
router.get('/summary', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user.uid;

  try {
    const result = await generateSummary(userId);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching AI summary:', error);
    throw error;
  }
}));

/**
 * Get AI Summary for Specific Reports
 * POST /v1/ai/summary
 */
router.post('/summary', authenticateToken, [
  body('reportIds').isArray().notEmpty().withMessage('reportIds must be a non-empty array'),
  body('reportIds.*').isString().trim().notEmpty().withMessage('Each reportId must be a non-empty string')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: errors.array()
      }
    });
  }

  const { reportIds } = req.body;

  try {
    const result = await generateSummaryForReports(reportIds);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error generating AI summary for reports:', error);
    throw error;
  }
}));

/**
 * Get AI Suggestions
 * GET /v1/ai/suggestions
 */
router.get('/suggestions', authenticateToken, [
  query('reportId').optional().trim()
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid query parameters',
        details: errors.array()
      }
    });
  }

  const userId = req.user.uid;
  const { reportId } = req.query;

  try {
    const result = await generateSuggestions(userId, reportId || null);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching AI suggestions:', error);
    throw error;
  }
}));

module.exports = router;

