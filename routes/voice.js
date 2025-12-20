const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  inferIntentFromText,
  fetchPatientAppointments,
  summarizeAppointments,
  cancelAppointment,
} = require('../services/voiceAssistant');

const router = express.Router();

/**
 * Voice Assistant (text-based for now)
 * POST /v1/voice/assistant
 * Body: { text: string }
 */
router.post(
  '/assistant',
  authenticateToken,
  [body('text').isString().trim().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Text is required',
          details: errors.array(),
        },
      });
    }

    const { text } = req.body;
    const userId = req.user.uid;

    try {
      const intent = await inferIntentFromText(text);

      if (intent.needsClarification) {
        return res.json({
          success: true,
          data: {
            text: intent.followUp || 'Can you provide more details?',
          },
        });
      }

      switch (intent.action) {
        case 'get_patient_appointments': {
          const appointments = await fetchPatientAppointments(userId, intent.filters || {});
          return res.json({
            success: true,
            data: {
              text: summarizeAppointments(appointments),
              appointments,
            },
          });
        }
        case 'cancel_appointment': {
          if (!intent.appointmentId) {
            return res.json({
              success: true,
              data: {
                text: 'Which appointment ID should I cancel?',
              },
            });
          }
          const result = await cancelAppointment(intent.appointmentId, userId);
          return res.json({
            success: result.success,
            data: {
              text: result.message,
            },
            error: result.success
              ? null
              : {
                  code: 'CANCEL_FAILED',
                  message: result.message,
                },
          });
        }
        default: {
          return res.json({
            success: true,
            data: {
              text: "I can help with appointments right now. Try asking 'What are my appointments today?'",
            },
          });
        }
      }
    } catch (error) {
      console.error('Voice assistant error:', error);
      return res.status(500).json({
        success: false,
        error: {
          code: 'VOICE_ASSISTANT_ERROR',
          message: 'Failed to process request',
          details: error.message,
        },
      });
    }
  })
);

module.exports = router;


