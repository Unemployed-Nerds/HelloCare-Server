/**
 * Centralized error handling middleware
 * Formats errors according to API documentation specification
 */
function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  // Handle validation errors
  if (err.name === 'ValidationError' || err.code === 'VALIDATION_ERROR') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message || 'Invalid request data',
        details: err.details || {}
      }
    });
  }

  // Handle authentication errors
  if (err.code === 'UNAUTHORIZED' || err.status === 401) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: err.message || 'Authentication required',
        details: {}
      }
    });
  }

  // Handle forbidden errors
  if (err.code === 'FORBIDDEN' || err.status === 403) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: err.message || 'Access denied',
        details: {}
      }
    });
  }

  // Handle not found errors
  if (err.code === 'NOT_FOUND' || err.status === 404) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: err.message || 'Resource not found',
        details: {}
      }
    });
  }

  // Handle rate limiting errors
  if (err.code === 'RATE_LIMIT_EXCEEDED' || err.status === 429) {
    return res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: err.message || 'Too many requests',
        details: {}
      }
    });
  }

  // Default server error
  const statusCode = err.status || err.statusCode || 500;
  return res.status(statusCode).json({
    success: false,
    error: {
      code: 'SERVER_ERROR',
      message: process.env.NODE_ENV === 'production' 
        ? 'An error occurred' 
        : err.message || 'Internal server error',
      details: process.env.NODE_ENV === 'production' ? {} : { stack: err.stack }
    }
  });
}

/**
 * Async handler wrapper to catch errors in async route handlers
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  errorHandler,
  asyncHandler
};

