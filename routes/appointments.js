const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { db } = require('../config/firebase');

const router = express.Router();

/**
 * Book Appointment
 * POST /v1/appointments
 */
router.post('/', authenticateToken, [
  body('doctorId').trim().notEmpty(),
  body('date').isISO8601(),
  body('time').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('duration').optional().isInt({ min: 15, max: 240 }),
  body('notes').optional().trim()
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

  const { doctorId, date, time, duration = 30, notes } = req.body;
  const patientId = req.user.uid;

  try {
    // Verify doctor exists
    const doctorDoc = await db.collection('doctors').doc(doctorId).get();
    if (!doctorDoc.exists) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Doctor not found',
          details: {}
        }
      });
    }

    const doctorData = doctorDoc.data();

    // Verify slot is available
    const appointmentsSnapshot = await db.collection('appointments')
      .where('doctorId', '==', doctorId)
      .where('date', '==', date)
      .where('time', '==', time)
      .where('status', 'in', ['pending', 'confirmed'])
      .get();

    if (!appointmentsSnapshot.empty) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Time slot is already booked',
          details: {}
        }
      });
    }

    // Get patient info
    const patientDoc = await db.collection('users').doc(patientId).get();
    const patientData = patientDoc.data();

    // Create appointment
    const appointmentRef = db.collection('appointments').doc();
    const appointmentId = appointmentRef.id;

    const appointmentData = {
      appointmentId,
      doctorId,
      doctorName: doctorData.name,
      doctorSpecialization: doctorData.specialization,
      patientId,
      patientName: patientData.name,
      date,
      time,
      duration,
      status: 'pending',
      notes: notes || null,
      doctorNotes: null,
      createdAt: new Date().toISOString()
    };

    await appointmentRef.set(appointmentData);

    res.status(201).json({
      success: true,
      message: 'Appointment booked successfully',
      data: appointmentData
    });
  } catch (error) {
    console.error('Error booking appointment:', error);
    throw error;
  }
}));

/**
 * Get Patient Appointments
 * GET /v1/appointments/patient
 */
router.get('/patient', authenticateToken, [
  query('status').optional().isIn(['pending', 'confirmed', 'completed', 'cancelled']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('doctorId').optional().trim()
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

  const patientId = req.user.uid;
  const { status, startDate, endDate, doctorId } = req.query;

  try {
    let query = db.collection('appointments').where('patientId', '==', patientId);

    // Apply filters
    if (status) {
      query = query.where('status', '==', status);
    }
    if (doctorId) {
      query = query.where('doctorId', '==', doctorId);
    }
    if (startDate) {
      query = query.where('date', '>=', startDate);
    }
    if (endDate) {
      query = query.where('date', '<=', endDate);
    }

    // Order by date and time
    query = query.orderBy('date', 'desc').orderBy('time', 'desc');

    const snapshot = await query.get();
    const appointments = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        appointmentId: doc.id,
        doctorId: data.doctorId,
        doctorName: data.doctorName,
        doctorSpecialization: data.doctorSpecialization,
        date: data.date,
        time: data.time,
        duration: data.duration,
        status: data.status,
        notes: data.notes,
        createdAt: data.createdAt
      };
    });

    res.json({
      success: true,
      data: {
        appointments
      }
    });
  } catch (error) {
    console.error('Error fetching patient appointments:', error);
    throw error;
  }
}));

/**
 * Get Doctor Appointments
 * GET /v1/appointments/doctor
 */
router.get('/doctor', authenticateToken, [
  query('status').optional().isIn(['pending', 'confirmed', 'completed', 'cancelled']),
  query('date').optional().isISO8601(),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601()
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

  // Verify user is a doctor
  const userDoc = await db.collection('users').doc(req.user.uid).get();
  if (!userDoc.exists || userDoc.data().role !== 'doctor') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Doctor access required',
        details: {}
      }
    });
  }

  const doctorId = req.user.uid;
  const { status, date, startDate, endDate } = req.query;

  try {
    let query = db.collection('appointments').where('doctorId', '==', doctorId);

    // Apply filters
    if (status) {
      query = query.where('status', '==', status);
    }
    if (date) {
      query = query.where('date', '==', date);
    }
    if (startDate) {
      query = query.where('date', '>=', startDate);
    }
    if (endDate) {
      query = query.where('date', '<=', endDate);
    }

    // Order by date and time
    query = query.orderBy('date', 'desc').orderBy('time', 'desc');

    const snapshot = await query.get();
    const appointments = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        appointmentId: doc.id,
        patientId: data.patientId,
        patientName: data.patientName,
        date: data.date,
        time: data.time,
        duration: data.duration,
        status: data.status,
        notes: data.notes,
        doctorNotes: data.doctorNotes,
        createdAt: data.createdAt
      };
    });

    res.json({
      success: true,
      data: {
        appointments
      }
    });
  } catch (error) {
    console.error('Error fetching doctor appointments:', error);
    throw error;
  }
}));

/**
 * Get Appointment Details
 * GET /v1/appointments/:appointmentId
 */
router.get('/:appointmentId', authenticateToken, asyncHandler(async (req, res) => {
  const { appointmentId } = req.params;
  const userId = req.user.uid;

  try {
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

    // Verify user has access (either patient or doctor)
    if (appointmentData.patientId !== userId && appointmentData.doctorId !== userId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
          details: {}
        }
      });
    }

    res.json({
      success: true,
      data: {
        appointmentId: appointmentDoc.id,
        doctorId: appointmentData.doctorId,
        doctorName: appointmentData.doctorName,
        patientId: appointmentData.patientId,
        patientName: appointmentData.patientName,
        date: appointmentData.date,
        time: appointmentData.time,
        duration: appointmentData.duration,
        status: appointmentData.status,
        notes: appointmentData.notes,
        doctorNotes: appointmentData.doctorNotes,
        createdAt: appointmentData.createdAt
      }
    });
  } catch (error) {
    console.error('Error fetching appointment:', error);
    throw error;
  }
}));

/**
 * Update Appointment Status
 * PUT /v1/appointments/:appointmentId/status
 */
router.put('/:appointmentId/status', authenticateToken, [
  body('status').isIn(['pending', 'confirmed', 'completed', 'cancelled'])
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

  const { appointmentId } = req.params;
  const { status } = req.body;
  const userId = req.user.uid;

  try {
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

    // Verify user has access (either patient or doctor)
    if (appointmentData.patientId !== userId && appointmentData.doctorId !== userId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
          details: {}
        }
      });
    }

    // Update status
    await db.collection('appointments').doc(appointmentId).update({
      status,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Appointment status updated successfully'
    });
  } catch (error) {
    console.error('Error updating appointment status:', error);
    throw error;
  }
}));

/**
 * Add Doctor Notes to Appointment
 * PUT /v1/appointments/:appointmentId/notes
 */
router.put('/:appointmentId/notes', authenticateToken, [
  body('doctorNotes').trim().notEmpty()
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

  const { appointmentId } = req.params;
  const { doctorNotes } = req.body;
  const userId = req.user.uid;

  try {
    // Verify user is a doctor
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists || userDoc.data().role !== 'doctor') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Doctor access required',
          details: {}
        }
      });
    }

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

    // Verify doctor owns this appointment
    if (appointmentData.doctorId !== userId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
          details: {}
        }
      });
    }

    // Update doctor notes
    await db.collection('appointments').doc(appointmentId).update({
      doctorNotes,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Notes updated successfully'
    });
  } catch (error) {
    console.error('Error updating appointment notes:', error);
    throw error;
  }
}));

/**
 * Cancel Appointment
 * DELETE /v1/appointments/:appointmentId
 */
router.delete('/:appointmentId', authenticateToken, asyncHandler(async (req, res) => {
  const { appointmentId } = req.params;
  const userId = req.user.uid;

  try {
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

    // Verify user has access (either patient or doctor)
    if (appointmentData.patientId !== userId && appointmentData.doctorId !== userId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
          details: {}
        }
      });
    }

    // Update status to cancelled (soft delete)
    await db.collection('appointments').doc(appointmentId).update({
      status: 'cancelled',
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Appointment cancelled successfully'
    });
  } catch (error) {
    console.error('Error cancelling appointment:', error);
    throw error;
  }
}));

module.exports = router;

