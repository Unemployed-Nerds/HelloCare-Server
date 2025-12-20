const { auth } = require('../config/firebase');

/**
 * Authentication middleware to verify Firebase ID tokens
 * Adds user information to req.user if token is valid
 */
async function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required. Provide a valid Bearer token.',
          details: {}
        }
      });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
      const decodedToken = await auth.verifyIdToken(token);
      
      // Attach user info to request object
      req.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        emailVerified: decodedToken.email_verified || false
      };

      next();
    } catch (error) {
      console.error('Token verification error:', error.message);
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired token.',
          details: {}
        }
      });
    }
  } catch (error) {
    console.error('Authentication middleware error:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Authentication error occurred.',
        details: {}
      }
    });
  }
}

/**
 * Middleware to check if user has a specific role
 */
function requireRole(role) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required.',
            details: {}
          }
        });
      }

      // Get user document from Firestore to check role
      const { db } = require('../config/firebase');
      const userDoc = await db.collection('users').doc(req.user.uid).get();

      if (!userDoc.exists) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'User profile not found.',
            details: {}
          }
        });
      }

      const userData = userDoc.data();
      if (userData.role !== role) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: `Access denied. ${role} role required.`,
            details: {}
          }
        });
      }

      req.user.role = userData.role;
      next();
    } catch (error) {
      console.error('Role check error:', error);
      return res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Error checking user role.',
          details: {}
        }
      });
    }
  };
}

module.exports = {
  authenticateToken,
  requireRole
};

