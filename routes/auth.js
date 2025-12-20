const express = require('express');
const { body, validationResult } = require('express-validator');
const { auth, db } = require('../config/firebase');
const { asyncHandler } = require('../middleware/errorHandler');
const axios = require('axios');

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

  // STEP 1: Verify password FIRST - this is the primary authentication check
  const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!firebaseApiKey) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Server configuration error',
        details: {}
      }
    });
  }

  // Authenticate with Firebase Auth REST API - this VERIFIES the password
  // This is the CRITICAL step - password MUST be verified here
  let authResponse;
  let passwordVerified = false;

  try {
    authResponse = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
      {
        email,
        password,
        returnSecureToken: true
      },
      {
        validateStatus: function (status) {
          // Don't throw on any status - we'll check the response manually
          return status >= 200 && status < 600;
        }
      }
    );

    // Check HTTP status code first
    if (authResponse.status !== 200) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    // Check if response contains an error (Firebase sometimes returns errors in response body even with 200 status)
    if (authResponse.data && authResponse.data.error) {
      const firebaseError = authResponse.data.error;
      const errorMessage = firebaseError.message || '';
      const errorCode = firebaseError.code || '';

      // Handle all password/authentication errors
      if (errorMessage.includes('INVALID_PASSWORD') ||
        errorCode === 'INVALID_PASSWORD' ||
        errorMessage.includes('EMAIL_NOT_FOUND') ||
        errorCode === 'EMAIL_NOT_FOUND' ||
        errorMessage.includes('INVALID_EMAIL') ||
        errorCode === 'INVALID_EMAIL' ||
        errorMessage.includes('USER_DISABLED') ||
        errorCode === 'USER_DISABLED' ||
        errorMessage.includes('TOO_MANY_ATTEMPTS_TRY_LATER') ||
        errorCode === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
            details: {}
          }
        });
      }

      // If there's any error in the response, reject login
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    // Validate that we have the required fields (this confirms password was correct)
    if (!authResponse.data || !authResponse.data.localId || !authResponse.data.idToken) {
      console.error('Firebase Auth response missing required fields:', authResponse.data);
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    // Password verified successfully - we have a valid userId and idToken
    passwordVerified = true;

  } catch (authError) {
    // Password verification failed - return immediately without checking anything else

    if (authError.response?.data?.error) {
      const firebaseError = authError.response.data.error;
      const errorMessage = firebaseError.message || '';
      const errorCode = firebaseError.code || '';

      // Handle all password/authentication errors
      if (errorMessage.includes('INVALID_PASSWORD') ||
        errorCode === 'INVALID_PASSWORD' ||
        errorMessage.includes('EMAIL_NOT_FOUND') ||
        errorCode === 'EMAIL_NOT_FOUND' ||
        errorMessage.includes('INVALID_EMAIL') ||
        errorCode === 'INVALID_EMAIL' ||
        errorMessage.includes('USER_DISABLED') ||
        errorCode === 'USER_DISABLED' ||
        errorMessage.includes('TOO_MANY_ATTEMPTS_TRY_LATER') ||
        errorCode === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
            details: {}
          }
        });
      }
    }

    // If password verification failed for any other reason, return error
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password',
        details: {}
      }
    });
  }

  // STEP 2: CRITICAL CHECK - Only proceed if password was verified
  if (!passwordVerified || !authResponse || !authResponse.data || !authResponse.data.localId || !authResponse.data.idToken) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Password verification failed',
        details: {}
      }
    });
  }

  const { localId: userId, idToken } = authResponse.data;

  // STEP 3: Now that password is verified, check user in database
  try {
    // Verify user exists in Firebase Auth (using Admin SDK)
    let userRecord;
    try {
      userRecord = await auth.getUser(userId);
    } catch (adminError) {
      console.error('Error getting user from Admin SDK:', adminError);
      if (adminError.code === 'auth/user-not-found') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User account not properly configured',
            details: {}
          }
        });
      }
      throw adminError;
    }

    // Verify user document exists and is a patient
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'User account not found',
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
    let customToken;
    try {
      customToken = await auth.createCustomToken(userId);
    } catch (tokenError) {
      console.error('Error creating custom token:', tokenError);
      // If custom token creation fails, we can still return the idToken from REST API
      // But custom token is preferred for consistency
      if (tokenError.code === 'auth/user-not-found') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User account not properly configured',
            details: {}
          }
        });
      }
      throw tokenError;
    }

    res.json({
      success: true,
      data: {
        token: customToken,
        userId: userId,
        email: email,
        name: userData.name,
        role: userData.role
      }
    });
  } catch (error) {
    console.error('Patient login error:', error);

    // Handle any remaining authentication errors
    if (error.response?.data?.error) {
      const firebaseError = error.response.data.error;
      const errorMessage = firebaseError.message || '';

      if (errorMessage.includes('INVALID_PASSWORD') ||
        errorMessage.includes('EMAIL_NOT_FOUND') ||
        errorMessage.includes('INVALID_EMAIL') ||
        errorMessage.includes('USER_DISABLED') ||
        errorMessage.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
            details: {}
          }
        });
      }
    }

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
        monday: { start: '09:00', end: '17:00', available: true },
        tuesday: { start: '09:00', end: '17:00', available: true },
        wednesday: { start: '09:00', end: '17:00', available: true },
        thursday: { start: '09:00', end: '17:00', available: true },
        friday: { start: '09:00', end: '17:00', available: true },
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

  // STEP 1: Verify password FIRST - this is the primary authentication check
  const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!firebaseApiKey) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Server configuration error',
        details: {}
      }
    });
  }

  // Authenticate with Firebase Auth REST API - this VERIFIES the password
  // This is the CRITICAL step - password MUST be verified here
  let authResponse;
  let passwordVerified = false;

  try {
    authResponse = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
      {
        email,
        password,
        returnSecureToken: true
      },
      {
        validateStatus: function (status) {
          // Don't throw on any status - we'll check the response manually
          return status >= 200 && status < 600;
        }
      }
    );

    // Check HTTP status code first
    if (authResponse.status !== 200) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    // Check if response contains an error (Firebase sometimes returns errors in response body even with 200 status)
    if (authResponse.data && authResponse.data.error) {
      const firebaseError = authResponse.data.error;
      const errorMessage = firebaseError.message || '';
      const errorCode = firebaseError.code || '';

      // Handle all password/authentication errors
      if (errorMessage.includes('INVALID_PASSWORD') ||
        errorCode === 'INVALID_PASSWORD' ||
        errorMessage.includes('EMAIL_NOT_FOUND') ||
        errorCode === 'EMAIL_NOT_FOUND' ||
        errorMessage.includes('INVALID_EMAIL') ||
        errorCode === 'INVALID_EMAIL' ||
        errorMessage.includes('USER_DISABLED') ||
        errorCode === 'USER_DISABLED' ||
        errorMessage.includes('TOO_MANY_ATTEMPTS_TRY_LATER') ||
        errorCode === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
            details: {}
          }
        });
      }

      // If there's any error in the response, reject login
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    // Validate that we have the required fields (this confirms password was correct)
    if (!authResponse.data || !authResponse.data.localId || !authResponse.data.idToken) {
      console.error('Firebase Auth response missing required fields:', authResponse.data);
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    // Password verified successfully - we have a valid userId and idToken
    passwordVerified = true;

  } catch (authError) {
    // Password verification failed - return immediately without checking anything else

    if (authError.response?.data?.error) {
      const firebaseError = authError.response.data.error;
      const errorMessage = firebaseError.message || '';
      const errorCode = firebaseError.code || '';

      // Handle all password/authentication errors
      if (errorMessage.includes('INVALID_PASSWORD') ||
        errorCode === 'INVALID_PASSWORD' ||
        errorMessage.includes('EMAIL_NOT_FOUND') ||
        errorCode === 'EMAIL_NOT_FOUND' ||
        errorMessage.includes('INVALID_EMAIL') ||
        errorCode === 'INVALID_EMAIL' ||
        errorMessage.includes('USER_DISABLED') ||
        errorCode === 'USER_DISABLED' ||
        errorMessage.includes('TOO_MANY_ATTEMPTS_TRY_LATER') ||
        errorCode === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
            details: {}
          }
        });
      }
    }

    // If password verification failed for any other reason, return error
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password',
        details: {}
      }
    });
  }

  // STEP 2: CRITICAL CHECK - Only proceed if password was verified
  if (!passwordVerified || !authResponse || !authResponse.data || !authResponse.data.localId || !authResponse.data.idToken) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Password verification failed',
        details: {}
      }
    });
  }

  const { localId: userId, idToken } = authResponse.data;

  // STEP 3: Now that password is verified, check user in database
  try {
    // Verify user exists in Firebase Auth (using Admin SDK)
    let userRecord;
    try {
      userRecord = await auth.getUser(userId);
    } catch (adminError) {
      console.error('Error getting user from Admin SDK:', adminError);
      if (adminError.code === 'auth/user-not-found') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User account not properly configured',
            details: {}
          }
        });
      }
      throw adminError;
    }

    // Verify user document exists and is a doctor
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'User account not found',
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
    let customToken;
    try {
      customToken = await auth.createCustomToken(userId);
    } catch (tokenError) {
      console.error('Error creating custom token:', tokenError);
      // If custom token creation fails, we can still return the idToken from REST API
      // But custom token is preferred for consistency
      if (tokenError.code === 'auth/user-not-found') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User account not properly configured',
            details: {}
          }
        });
      }
      throw tokenError;
    }

    res.json({
      success: true,
      data: {
        token: customToken,
        userId: userId,
        email: email,
        name: userData.name,
        role: userData.role
      }
    });
  } catch (error) {
    console.error('Doctor login error:', error);

    // Handle any remaining authentication errors
    if (error.response?.data?.error) {
      const firebaseError = error.response.data.error;
      const errorMessage = firebaseError.message || '';

      if (errorMessage.includes('INVALID_PASSWORD') ||
        errorMessage.includes('EMAIL_NOT_FOUND') ||
        errorMessage.includes('INVALID_EMAIL') ||
        errorMessage.includes('USER_DISABLED') ||
        errorMessage.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
            details: {}
          }
        });
      }
    }

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

/**
 * Admin Sign Up
 * POST /v1/auth/admin/signup
 */
router.post('/admin/signup', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().notEmpty(),
  body('phone').optional().trim()
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

  const { email, password, name, phone } = req.body;

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
      role: 'admin',
      createdAt: new Date().toISOString()
    };

    await db.collection('users').doc(userRecord.uid).set(userData);

    // Generate custom token for immediate login
    const customToken = await auth.createCustomToken(userRecord.uid);

    res.status(201).json({
      success: true,
      message: 'Admin registered successfully',
      data: {
        userId: userRecord.uid,
        email: userRecord.email,
        name: userRecord.displayName,
        role: 'admin',
        token: customToken
      }
    });
  } catch (error) {
    console.error('Admin signup error:', error);

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
 * Admin Login
 * POST /v1/auth/admin/login
 */
router.post('/admin/login', [
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

  // STEP 1: Verify password FIRST - this is the primary authentication check
  const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!firebaseApiKey) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Server configuration error',
        details: {}
      }
    });
  }

  // Authenticate with Firebase Auth REST API - this VERIFIES the password
  let authResponse;
  let passwordVerified = false;

  try {
    authResponse = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
      {
        email,
        password,
        returnSecureToken: true
      },
      {
        validateStatus: function (status) {
          return status >= 200 && status < 600;
        }
      }
    );

    if (authResponse.status !== 200) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    if (authResponse.data && authResponse.data.error) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    if (!authResponse.data || !authResponse.data.localId || !authResponse.data.idToken) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
          details: {}
        }
      });
    }

    passwordVerified = true;

  } catch (authError) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password',
        details: {}
      }
    });
  }

  if (!passwordVerified) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Password verification failed',
        details: {}
      }
    });
  }

  const { localId: userId } = authResponse.data;

  // STEP 3: Now that password is verified, check user in database
  try {
    // Verify user exists in Firebase Auth (using Admin SDK)
    try {
      await auth.getUser(userId);
    } catch (adminError) {
      if (adminError.code === 'auth/user-not-found') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User account not properly configured',
            details: {}
          }
        });
      }
      throw adminError;
    }

    // Verify user document exists and is an admin
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'User account not found',
          details: {}
        }
      });
    }

    const userData = userDoc.data();

    if (userData.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid user role. Admin access required.',
          details: {}
        }
      });
    }

    // Generate custom token for client to exchange for ID token
    let customToken;
    try {
      customToken = await auth.createCustomToken(userId);
    } catch (tokenError) {
      console.error('Error creating custom token:', tokenError);
      throw tokenError;
    }

    res.json({
      success: true,
      data: {
        token: customToken,
        userId: userId,
        email: email,
        name: userData.name,
        role: userData.role
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    throw error;
  }
}));

module.exports = router;

