const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { db } = require('../config/firebase');

const router = express.Router();

/**
 * Process Payment (Mock)
 * POST /v1/payment/process
 */
router.post('/process', authenticateToken, [
  body('appointmentId').trim().notEmpty(),
  body('amount').isFloat({ min: 0 }),
  body('currency').optional().trim().default('USD'),
  body('paymentMethod').optional().trim().default('card')
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

  const { appointmentId, amount, currency = 'USD', paymentMethod = 'card' } = req.body;
  const userId = req.user.uid;

  try {
    // Verify appointment exists and belongs to user
    const appointmentDoc = await db.collection('appointments').doc(appointmentId).get();

    if (!appointmentDoc.exists) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Appointment not found',
          details: {}
        }
      });
    }

    const appointmentData = appointmentDoc.data();

    if (appointmentData.patientId !== userId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
          details: {}
        }
      });
    }

    // Generate mock transaction ID
    const transactionId = `txn_mock_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // In a real implementation, you would:
    // 1. Process payment through payment gateway (Stripe, PayPal, etc.)
    // 2. Store transaction in database
    // 3. Update appointment status
    await db.collection('appointments').doc(appointmentId).update({
      status: 'confirmed',
      paymentStatus: 'paid',
      amount: parseFloat(amount),
      currency,
      transactionId,
      updatedAt: new Date().toISOString()
    });
    // 4. Send confirmation email

    // Mock response
    res.json({
      success: true,
      message: 'Payment processed successfully (mock)',
      data: {
        transactionId,
        amount: parseFloat(amount),
        currency,
        status: 'completed',
        paymentMethod,
        processedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error processing payment:', error);
    throw error;
  }
}));

module.exports = router;

