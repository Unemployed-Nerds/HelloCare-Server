const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { db } = require('../config/firebase');
const { createOrder, verifySignature } = require('../services/razorpay');

const router = express.Router();

/**
 * Create Razorpay Order
 * POST /v1/payment/process
 */
router.post('/process', authenticateToken, [
  body('appointmentId').trim().notEmpty(),
  body('amount').isFloat({ min: 1 }),
  body('currency').optional().trim().default('INR')
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

  const { appointmentId, amount, currency = 'INR' } = req.body;
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

    if (appointmentData.paymentStatus === 'paid') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ALREADY_PAID',
          message: 'Appointment already paid',
          details: {}
        }
      });
    }

    const order = await createOrder({
      amount,
      currency,
      metadata: {
        appointmentId,
        patientId: userId,
        doctorId: appointmentData.doctorId || null
      }
    });

    const paymentRef = db.collection('payments').doc(order.id);
    await paymentRef.set({
      appointmentId,
      patientId: userId,
      doctorId: appointmentData.doctorId || null,
      amount: parseFloat(amount),
      currency,
      orderId: order.id,
      status: 'created',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Razorpay order created successfully',
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt || null,
        keyId: process.env.RAZORPAY_KEY_ID
      }
    });
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    throw error;
  }
}));

/**
 * Confirm Razorpay Payment
 * POST /v1/payment/confirm
 */
router.post('/confirm', authenticateToken, [
  body('orderId').trim().notEmpty(),
  body('paymentId').trim().notEmpty(),
  body('signature').trim().notEmpty()
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

  const { orderId, paymentId, signature } = req.body;
  const userId = req.user.uid;

  const paymentRef = db.collection('payments').doc(orderId);
  const paymentDoc = await paymentRef.get();

  if (!paymentDoc.exists) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'PAYMENT_NOT_FOUND',
        message: 'Payment record not found',
        details: {}
      }
    });
  }

  const paymentData = paymentDoc.data();
  if (paymentData.patientId !== userId) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Access denied',
        details: {}
      }
    });
  }

  const signatureIsValid = verifySignature({
    orderId,
    paymentId,
    signature
  });

  if (!signatureIsValid) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_SIGNATURE',
        message: 'Unable to verify Razorpay signature',
        details: {}
      }
    });
  }

  const appointmentRef = db.collection('appointments').doc(paymentData.appointmentId);
  const appointmentDoc = await appointmentRef.get();

  if (!appointmentDoc.exists) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'APPOINTMENT_NOT_FOUND',
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

  await paymentRef.update({
    paymentId,
    signature,
    status: 'paid',
    updatedAt: new Date().toISOString()
  });

  await appointmentRef.update({
    status: 'confirmed',
    paymentStatus: 'paid',
    transactionId: paymentId,
    amount: paymentData.amount,
    currency: paymentData.currency,
    updatedAt: new Date().toISOString()
  });

  res.json({
    success: true,
    message: 'Payment confirmed successfully',
    data: {
      orderId,
      paymentId,
      status: 'paid'
    }
  });
}));

module.exports = router;

