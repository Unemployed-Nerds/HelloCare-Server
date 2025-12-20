require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Initialize Firebase Admin SDK
require('./config/firebase.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || '*',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'HelloCare Server API',
    version: '1.0.0',
    baseUrl: '/v1',
    endpoints: {
      health: '/health',
      auth: '/v1/auth',
      reports: '/v1/reports',
      ai: '/v1/ai',
      doctors: '/v1/doctors',
      appointments: '/v1/appointments',
      payment: '/v1/payment'
    }
  });
});

// API Routes
const authRoutes = require('./routes/auth');
const reportsRoutes = require('./routes/reports');
const aiRoutes = require('./routes/ai');
const doctorsRoutes = require('./routes/doctors');
const appointmentsRoutes = require('./routes/appointments');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');

app.use('/v1/auth', authRoutes);
app.use('/v1/reports', reportsRoutes);
app.use('/v1/ai', aiRoutes);
app.use('/v1/doctors', doctorsRoutes);
app.use('/v1/appointments', appointmentsRoutes);
app.use('/v1/payment', paymentRoutes);
app.use('/v1/admin', adminRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
      details: {}
    }
  });
});

// Error handling middleware
const { errorHandler } = require('./middleware/errorHandler');
app.use(errorHandler);

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

