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
  fetchPatientReports,
  summarizeReports,
  getNavigationRoute,
  generateHumanizedResponse,
} = require('../services/voiceAssistant');
const { generateSummary, generateSuggestions } = require('../services/ai');

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
          const humanizedResponse = await generateHumanizedResponse(
            text,
            appointments,
            intent.action,
            context
          );
          return res.json({
            success: true,
            data: {
              text: humanizedResponse,
              appointments,
              intentAction: intent.action,
            },
          });
        }
        case 'cancel_appointment': {
          if (!intent.appointmentId) {
            const humanizedResponse = await generateHumanizedResponse(
              text,
              { needsClarification: true, type: 'cancel_appointment' },
              intent.action,
              context
            );
            return res.json({
              success: true,
              data: {
                text: humanizedResponse || 'Which appointment would you like to cancel?',
                intentAction: intent.action,
                needsClarification: true,
              },
            });
          }
          const result = await cancelAppointment(intent.appointmentId, userId);
          const humanizedResponse = await generateHumanizedResponse(
            text,
            result,
            intent.action,
            context
          );
          return res.json({
            success: result.success,
            data: {
              text: humanizedResponse || result.message,
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
            
            // Generate humanized follow-up
            const humanizedFollowUp = await generateHumanizedResponse(
              text,
              { needsClarification: true, missingFields: missing, type: 'book_appointment' },
              intent.action,
              context
            );
            
            return res.json({
              success: true,
              data: {
                text: humanizedFollowUp || followUp,
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
              const humanizedResponse = await generateHumanizedResponse(
                text,
                { doctorName: booking.doctorName, found: false },
                intent.action,
                context
              );
              return res.json({
                success: false,
                data: {
                  text: humanizedResponse || `I couldn't find a doctor named "${booking.doctorName}". Could you please provide the exact doctor name?`,
                  intentAction: intent.action,
                },
                error: {
                  code: 'DOCTOR_NOT_FOUND',
                  message: 'Doctor not found',
                },
              });
            } else if (doctors.length > 1) {
              const humanizedResponse = await generateHumanizedResponse(
                text,
                { doctors: doctors.map(d => d.name), multiple: true },
                intent.action,
                context
              );
              return res.json({
                success: true,
                data: {
                  text: humanizedResponse || `I found multiple doctors: ${doctors.map(d => d.name).join(', ')}. Which one would you like to book with?`,
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
              const humanizedResponse = await generateHumanizedResponse(
                text,
                { date: booking.date, slotsAvailable: false },
                intent.action,
                context
              );
              return res.json({
                success: false,
                data: {
                  text: humanizedResponse || `No available slots on ${booking.date}. Would you like to choose a different date?`,
                  intentAction: intent.action,
                  needsClarification: true,
                },
              });
            }
            const humanizedResponse = await generateHumanizedResponse(
              text,
              { date: booking.date, availableSlots, slotsAvailable: true },
              intent.action,
              context
            );
            return res.json({
              success: true,
              data: {
                text: humanizedResponse || `Available slots on ${booking.date}: ${availableSlots.slice(0, 5).join(', ')}${availableSlots.length > 5 ? ` and ${availableSlots.length - 5} more` : ''}. What time would you like?`,
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
          
          const humanizedResponse = await generateHumanizedResponse(
            text,
            result,
            intent.action,
            context
          );
          
          return res.json({
            success: result.success,
            data: {
              text: humanizedResponse || result.message,
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
        case 'navigate': {
          const navigation = intent.navigation || {};
          let route = navigation.route;
          
          // If route not provided, try to infer from text
          if (!route) {
            route = getNavigationRoute(text);
          }
          
          if (!route) {
            return res.json({
              success: false,
              data: {
                text: "I'm not sure where you want to go. Try saying 'show reports', 'go to appointments', or 'open AI summary'.",
                intentAction: intent.action,
              },
            });
          }
          
          return res.json({
            success: true,
            data: {
              text: `Opening ${route.replace('/patient/', '').replace('-', ' ')}...`,
              navigation: { route },
              intentAction: intent.action,
            },
          });
        }
        case 'get_reports': {
          const reports = await fetchPatientReports(userId, intent.reportFilters || {});
          const humanizedResponse = await generateHumanizedResponse(
            text,
            reports,
            intent.action,
            context
          );
          return res.json({
            success: true,
            data: {
              text: humanizedResponse,
              reports,
              intentAction: intent.action,
            },
          });
        }
        case 'get_ai_summary': {
          try {
            const summary = await generateSummary(userId);
            const humanizedResponse = await generateHumanizedResponse(
              text,
              summary,
              intent.action,
              context
            );
            return res.json({
              success: true,
              data: {
                text: humanizedResponse || summary.summary || summary.overallSummary || 'Here\'s your health summary.',
                summary,
                intentAction: intent.action,
              },
            });
          } catch (error) {
            return res.json({
              success: false,
              data: {
                text: 'Sorry, I couldn\'t generate your health summary right now. Please try again later.',
                intentAction: intent.action,
              },
              error: {
                code: 'AI_SUMMARY_ERROR',
                message: error.message,
              },
            });
          }
        }
        case 'get_ai_suggestions': {
          try {
            const suggestions = await generateSuggestions(userId, null);
            const suggestionsList = Array.isArray(suggestions) ? suggestions : (suggestions.suggestions || []);
            
            if (suggestionsList.length === 0) {
              const humanizedResponse = await generateHumanizedResponse(
                text,
                { suggestions: [] },
                intent.action,
                context
              );
              return res.json({
                success: true,
                data: {
                  text: humanizedResponse || 'No suggestions available at the moment.',
                  suggestions: [],
                  intentAction: intent.action,
                },
              });
            }
            
            const humanizedResponse = await generateHumanizedResponse(
              text,
              suggestionsList,
              intent.action,
              context
            );
            
            return res.json({
              success: true,
              data: {
                text: humanizedResponse,
                suggestions: suggestionsList,
                intentAction: intent.action,
              },
            });
          } catch (error) {
            return res.json({
              success: false,
              data: {
                text: 'Sorry, I couldn\'t get suggestions right now. Please try again later.',
                intentAction: intent.action,
              },
              error: {
                code: 'AI_SUGGESTIONS_ERROR',
                message: error.message,
              },
            });
          }
        }
        default: {
          return res.json({
            success: true,
            data: {
              text: "I can help with appointments, reports, AI summary, and navigation. Try asking 'What are my appointments today?', 'Show my reports', 'Get AI summary', or 'Go to appointments'",
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


