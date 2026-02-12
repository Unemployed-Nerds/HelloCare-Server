const express = require('express');
const { query, body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { generateSummary, generateSuggestions, generateSummaryForReports } = require('../services/ai');

const router = express.Router();

/**
 * @swagger
 * /ai/summary:
 *   get:
 *     summary: Get AI-generated summary of user's health
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Health summary retrieved successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: AI service error
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
 * @swagger
 * /ai/summary:
 *   post:
 *     summary: Generate summary for specific reports
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reportIds
 *             properties:
 *               reportIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Summary generated successfully
 *       400:
 *         description: Invalid request data
 *       401:
 *         description: Unauthorized
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
 * @swagger
 * /ai/suggestions:
 *   get:
 *     summary: Get AI health suggestions
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: reportId
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional report ID to get suggestions specific to a report
 *     responses:
 *       200:
 *         description: Suggestions retrieved successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: AI service error
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
