const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { db } = require('../config/firebase');

const router = express.Router();

/**
 * Get All Doctors
 * GET /v1/doctors
 */
router.get('/', [
  query('specialization').optional().trim(),
  query('search').optional().trim()
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

  const { specialization, search } = req.query;

  try {
    let query = db.collection('doctors');

    // Apply specialization filter
    if (specialization) {
      query = query.where('specialization', '==', specialization);
    }

    const snapshot = await query.get();
    let doctors = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        doctorId: doc.id,
        name: data.name,
        email: data.email,
        phone: data.phone,
        specialization: data.specialization,
        bio: data.bio,
        yearsOfExperience: data.yearsOfExperience,
        rating: data.rating || 0,
        reviewCount: data.reviewCount || 0,
        profileImageUrl: data.profileImageUrl || null
      };
    });

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      doctors = doctors.filter(doctor => {
        return (
          doctor.name?.toLowerCase().includes(searchLower) ||
          doctor.specialization?.toLowerCase().includes(searchLower) ||
          doctor.bio?.toLowerCase().includes(searchLower)
        );
      });
    }

    res.json({
      success: true,
      data: {
        doctors
      }
    });
  } catch (error) {
    console.error('Error fetching doctors:', error);
    throw error;
  }
}));

/**
 * Get Doctor Details
 * GET /v1/doctors/:doctorId
 */
router.get('/:doctorId', asyncHandler(async (req, res) => {
  const { doctorId } = req.params;

  try {
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

    res.json({
      success: true,
      data: {
        doctorId: doctorDoc.id,
        name: doctorData.name,
        email: doctorData.email,
        phone: doctorData.phone,
        specialization: doctorData.specialization,
        bio: doctorData.bio,
        yearsOfExperience: doctorData.yearsOfExperience,
        rating: doctorData.rating || 0,
        reviewCount: doctorData.reviewCount || 0,
        profileImageUrl: doctorData.profileImageUrl || null,
        availability: doctorData.availability || {
          monday: { start: null, end: null, available: false },
          tuesday: { start: null, end: null, available: false },
          wednesday: { start: null, end: null, available: false },
          thursday: { start: null, end: null, available: false },
          friday: { start: null, end: null, available: false },
          saturday: { start: null, end: null, available: false },
          sunday: { start: null, end: null, available: false }
        }
      }
    });
  } catch (error) {
    console.error('Error fetching doctor:', error);
    throw error;
  }
}));

/**
 * Update Doctor Availability
 * PUT /v1/doctors/:doctorId/availability
 */
router.put('/:doctorId/availability', authenticateToken, requireRole('doctor'), [
  body('availability').isObject()
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

  const { doctorId } = req.params;
  const { availability } = req.body;
  const userId = req.user.uid;

  // Verify doctor owns this profile
  if (doctorId !== userId) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Access denied',
        details: {}
      }
    });
  }

  try {
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

    // Validate availability structure
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const validatedAvailability = {};

    for (const day of days) {
      if (availability[day]) {
        validatedAvailability[day] = {
          start: availability[day].start || null,
          end: availability[day].end || null,
          available: availability[day].available || false
        };
      } else {
        validatedAvailability[day] = {
          start: null,
          end: null,
          available: false
        };
      }
    }

    // Update availability
    await db.collection('doctors').doc(doctorId).update({
      availability: validatedAvailability,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Availability updated successfully'
    });
  } catch (error) {
    console.error('Error updating availability:', error);
    throw error;
  }
}));

/**
 * Get Available Time Slots
 * GET /v1/doctors/:doctorId/slots
 */
router.get('/:doctorId/slots', [
  query('date').isISO8601()
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

  const { doctorId } = req.params;
  const { date } = req.query;

  try {
    // Get doctor availability
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
    const availability = doctorData.availability || {};

    // Get day of week from date
    const dateObj = new Date(date);
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[dateObj.getDay()];

    const dayAvailability = availability[dayName];

    if (!dayAvailability || !dayAvailability.available || !dayAvailability.start || !dayAvailability.end) {
      return res.json({
        success: true,
        data: {
          date,
          slots: []
        }
      });
    }

    // Get existing appointments for this date
    const appointmentsSnapshot = await db.collection('appointments')
      .where('doctorId', '==', doctorId)
      .where('date', '==', date)
      .where('status', 'in', ['pending', 'confirmed'])
      .get();

    const bookedSlots = new Set();
    appointmentsSnapshot.docs.forEach(doc => {
      const appointment = doc.data();
      if (appointment.time) {
        bookedSlots.add(appointment.time);
      }
    });

    // Generate time slots (30-minute intervals)
    const slots = [];
    const startTime = dayAvailability.start;
    const endTime = dayAvailability.end;

    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);

    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    for (let minutes = startMinutes; minutes < endMinutes; minutes += 30) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      const timeSlot = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
      
      slots.push({
        time: timeSlot,
        available: !bookedSlots.has(timeSlot)
      });
    }

    res.json({
      success: true,
      data: {
        date,
        slots
      }
    });
  } catch (error) {
    console.error('Error fetching available slots:', error);
    throw error;
  }
}));

module.exports = router;

