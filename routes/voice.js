const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  inferIntentFromText,
  fetchPatientAppointments,
  summarizeAppointments,
  cancelAppointment,
  searchDoctors,
  getAvailableSlots,
  bookAppointment,
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
  [
    body('text').isString().trim().notEmpty(),
    body('context').optional().isArray(),
    body('lastAction').optional().isString(),
  ],
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

    const { text, context = [], lastAction = null } = req.body;
    const userId = req.user.uid;

    try {
      const intent = await inferIntentFromText(text, context, lastAction);

      if (intent.needsClarification) {
        return res.json({
          success: true,
          data: {
            text: intent.followUp || 'Can you provide more details?',
            intentAction: intent.action,
            needsClarification: true,
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
              intentAction: intent.action,
            },
          });
        }
        case 'cancel_appointment': {
          if (!intent.appointmentId) {
            return res.json({
              success: true,
              data: {
                text: 'Which appointment ID should I cancel?',
                intentAction: intent.action,
                needsClarification: true,
              },
            });
          }
          const result = await cancelAppointment(intent.appointmentId, userId);
          return res.json({
            success: result.success,
            data: {
              text: result.message,
              intentAction: intent.action,
            },
            error: result.success
              ? null
              : {
                  code: 'CANCEL_FAILED',
                  message: result.message,
                },
          });
        }
        case 'book_appointment': {
          const booking = intent.booking || {};
          
          // Check what information is missing
          const missing = [];
          if (!booking.doctorName && !booking.doctorId) missing.push('doctor');
          if (!booking.date) missing.push('date');
          if (!booking.time) missing.push('time');
          
          // If information is missing, ask follow-up questions
          if (missing.length > 0 || intent.needsClarification) {
            let followUp = intent.followUp;
            
            if (!followUp) {
              if (missing.includes('doctor')) {
                followUp = 'Which doctor would you like to book with?';
              } else if (missing.includes('date')) {
                followUp = 'What date would you like to book?';
              } else if (missing.includes('time')) {
                followUp = 'What time would you like to book?';
              } else {
                followUp = 'I need more information to book your appointment.';
              }
            }
            
            return res.json({
              success: true,
              data: {
                text: followUp,
                needsClarification: true,
                missingFields: missing,
                intentAction: intent.action,
              },
            });
          }
          
          // Search for doctor if only name is provided
          let doctorId = booking.doctorId;
          if (!doctorId && booking.doctorName) {
            const doctors = await searchDoctors(booking.doctorName);
            if (doctors.length === 0) {
              return res.json({
                success: false,
                data: {
                  text: `I couldn't find a doctor named "${booking.doctorName}". Could you please provide the exact doctor name?`,
                  intentAction: intent.action,
                },
                error: {
                  code: 'DOCTOR_NOT_FOUND',
                  message: 'Doctor not found',
                },
              });
            } else if (doctors.length > 1) {
              const doctorList = doctors.map(d => d.name).join(', ');
              return res.json({
                success: true,
                data: {
                  text: `I found multiple doctors: ${doctorList}. Which one would you like to book with?`,
                  doctors,
                  intentAction: intent.action,
                  needsClarification: true,
                },
              });
            } else {
              doctorId = doctors[0].doctorId;
            }
          }
          
          // Check available slots if date is provided but time is not
          if (doctorId && booking.date && !booking.time) {
            const availableSlots = await getAvailableSlots(doctorId, booking.date);
            if (availableSlots.length === 0) {
              return res.json({
                success: false,
                data: {
                  text: `No available slots on ${booking.date}. Would you like to choose a different date?`,
                  intentAction: intent.action,
                  needsClarification: true,
                },
              });
            }
            const slotsText = availableSlots.slice(0, 5).join(', ');
            return res.json({
              success: true,
              data: {
                text: `Available slots on ${booking.date}: ${slotsText}${availableSlots.length > 5 ? ` and ${availableSlots.length - 5} more` : ''}. What time would you like?`,
                availableSlots,
                intentAction: intent.action,
                needsClarification: true,
              },
            });
          }
          
          // Book the appointment
          const result = await bookAppointment(userId, {
            doctorId,
            date: booking.date,
            time: booking.time,
            duration: booking.duration || 30,
            notes: booking.notes,
          });
          
          return res.json({
            success: result.success,
            data: {
              text: result.message,
              appointmentId: result.appointmentId,
              intentAction: intent.action,
            },
            error: result.success
              ? null
              : {
                  code: 'BOOKING_FAILED',
                  message: result.message,
                },
          });
        }
        default: {
          return res.json({
            success: true,
            data: {
              text: "I can help with appointments. Try asking 'What are my appointments today?' or 'Book an appointment with Dr. Smith tomorrow at 2 PM'",
              intentAction: intent.action,
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


