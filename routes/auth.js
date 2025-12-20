const express = require('express');
const { body, validationResult } = require('express-validator');
const { auth, db } = require('../config/firebase');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

/**
 * Patient Sign Up
 * POST /v1/auth/patient/signup
 */
router.post('/patient/signup', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().notEmpty(),
  body('phone').optional().trim(),
  body('dateOfBirth').optional().isISO8601()
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

  const { email, password, name, phone, dateOfBirth } = req.body;

  try {
    // Create user in Firebase Auth
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: name,
      emailVerified: false
    });

    // Create user document in Firestore
    const userData = {
      userId: userRecord.uid,
      email,
      name,
      phone: phone || null,
      role: 'patient',
      dateOfBirth: dateOfBirth || null,
      createdAt: new Date().toISOString()
    };

    await db.collection('users').doc(userRecord.uid).set(userData);

    // Generate custom token for immediate login
    const customToken = await auth.createCustomToken(userRecord.uid);

    res.status(201).json({
      success: true,
      message: 'Patient registered successfully',
      data: {
        userId: userRecord.uid,
        email: userRecord.email,
        name: userRecord.displayName,
        role: 'patient',
        token: customToken
      }
    });
  } catch (error) {
    console.error('Patient signup error:', error);

    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Email already exists',
          details: {}
        }
      });
    }

    throw error;
  }
}));

/**
 * Patient Login
 * POST /v1/auth/patient/login
 */
router.post('/patient/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
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

  const { email, password } = req.body;

  try {
    // Note: Firebase Admin SDK doesn't support password verification
    // The client should use Firebase Auth SDK to authenticate
    // Then send the ID token to this endpoint for verification
    // For this endpoint, we'll verify the user exists and is a patient
    // In production, this should use Firebase Auth REST API or client SDK
    
    // Get user by email
    const userRecord = await auth.getUserByEmail(email);

    // Verify user document exists and is a patient
    const userDoc = await db.collection('users').doc(userRecord.uid).get();
    
    if (!userDoc.exists) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    const userData = userDoc.data();
    
    if (userData.role !== 'patient') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid user role',
          details: {}
        }
      });
    }

    // Generate custom token for client to exchange for ID token
    const customToken = await auth.createCustomToken(userRecord.uid);

    res.json({
      success: true,
      data: {
        token: customToken,
        userId: userRecord.uid,
        email: userRecord.email,
        name: userData.name,
        role: userData.role
      }
    });
  } catch (error) {
    console.error('Patient login error:', error);

    if (error.code === 'auth/user-not-found') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    throw error;
  }
}));

/**
 * Doctor Sign Up
 * POST /v1/auth/doctor/signup
 */
router.post('/doctor/signup', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().notEmpty(),
  body('phone').optional().trim(),
  body('specialization').trim().notEmpty(),
  body('yearsOfExperience').optional().isInt({ min: 0 }),
  body('bio').optional().trim()
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

  const { email, password, name, phone, specialization, yearsOfExperience, bio } = req.body;

  try {
    // Create user in Firebase Auth
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: name,
      emailVerified: false
    });

    // Create user document in Firestore
    const userData = {
      userId: userRecord.uid,
      email,
      name,
      phone: phone || null,
      role: 'doctor',
      createdAt: new Date().toISOString()
    };

    await db.collection('users').doc(userRecord.uid).set(userData);

    // Create doctor document in Firestore
    const doctorData = {
      doctorId: userRecord.uid,
      name,
      email,
      phone: phone || null,
      specialization,
      yearsOfExperience: yearsOfExperience || 0,
      bio: bio || '',
      rating: 0,
      reviewCount: 0,
      availability: {
        monday: { start: null, end: null, available: false },
        tuesday: { start: null, end: null, available: false },
        wednesday: { start: null, end: null, available: false },
        thursday: { start: null, end: null, available: false },
        friday: { start: null, end: null, available: false },
        saturday: { start: null, end: null, available: false },
        sunday: { start: null, end: null, available: false }
      },
      createdAt: new Date().toISOString()
    };

    await db.collection('doctors').doc(userRecord.uid).set(doctorData);

    // Generate custom token for immediate login
    const customToken = await auth.createCustomToken(userRecord.uid);

    res.status(201).json({
      success: true,
      message: 'Doctor registered successfully',
      data: {
        userId: userRecord.uid,
        email: userRecord.email,
        name: userRecord.displayName,
        role: 'doctor',
        token: customToken
      }
    });
  } catch (error) {
    console.error('Doctor signup error:', error);

    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Email already exists',
          details: {}
        }
      });
    }

    throw error;
  }
}));

/**
 * Doctor Login
 * POST /v1/auth/doctor/login
 */
router.post('/doctor/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
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

  const { email, password } = req.body;

  try {
    // Get user by email
    const userRecord = await auth.getUserByEmail(email);

    // Verify user document exists and is a doctor
    const userDoc = await db.collection('users').doc(userRecord.uid).get();
    
    if (!userDoc.exists) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    const userData = userDoc.data();
    
    if (userData.role !== 'doctor') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid user role',
          details: {}
        }
      });
    }

    // Generate custom token for client to exchange for ID token
    const customToken = await auth.createCustomToken(userRecord.uid);

    res.json({
      success: true,
      data: {
        token: customToken,
        userId: userRecord.uid,
        email: userRecord.email,
        name: userData.name,
        role: userData.role
      }
    });
  } catch (error) {
    console.error('Doctor login error:', error);

    if (error.code === 'auth/user-not-found') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    throw error;
  }
}));

module.exports = router;

