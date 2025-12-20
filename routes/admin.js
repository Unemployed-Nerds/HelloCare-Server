const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { db } = require('../config/firebase');

const router = express.Router();

/**
 * Middleware to require admin role
 */
const requireAdmin = async (req, res, next) => {
    try {
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists || userDoc.data().role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: {
                    code: 'FORBIDDEN',
                    message: 'Admin access required',
                    details: {}
                }
            });
        }
        next();
    } catch (error) {
        console.error('Admin role check error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'SERVER_ERROR',
                message: 'Error checking permissions',
                details: {}
            }
        });
    }
};

/**
 * Get All Patients
 * GET /v1/admin/patients
 */
router.get('/patients', authenticateToken, requireAdmin, [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 })
], asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    try {
        const patientsSnapshot = await db.collection('users')
            .where('role', '==', 'patient')
            .limit(limit)
            .offset(offset)
            .get();

        const patients = patientsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json({
            success: true,
            data: {
                patients
            }
        });
    } catch (error) {
        console.error('Error fetching all patients:', error);
        throw error;
    }
}));

/**
 * Get All Appointments
 * GET /v1/admin/appointments
 */
router.get('/appointments', authenticateToken, requireAdmin, [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
    query('status').optional().isIn(['pending', 'confirmed', 'completed', 'cancelled'])
], asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const { status } = req.query;

    try {
        let query = db.collection('appointments');

        if (status) {
            query = query.where('status', '==', status);
        }

        query = query.orderBy('date', 'desc').orderBy('time', 'desc').limit(limit).offset(offset);

        const snapshot = await query.get();
        const appointments = snapshot.docs.map(doc => ({
            appointmentId: doc.id,
            ...doc.data()
        }));

        res.json({
            success: true,
            data: {
                appointments
            }
        });
    } catch (error) {
        console.error('Error fetching all appointments:', error);
        throw error;
    }
}));

/**
 * Get System Stats
 * GET /v1/admin/stats
 */
router.get('/stats', authenticateToken, requireAdmin, asyncHandler(async (req, res) => {
    try {
        // Count doctors
        const doctorsSnapshot = await db.collection('users').where('role', '==', 'doctor').count().get();
        const doctorsCount = doctorsSnapshot.data().count;

        // Count patients
        const patientsSnapshot = await db.collection('users').where('role', '==', 'patient').count().get();
        const patientsCount = patientsSnapshot.data().count;

        // Count appointments
        const appointmentsSnapshot = await db.collection('appointments').count().get();
        const appointmentsCount = appointmentsSnapshot.data().count;

        // Calculate revenue (approximate based on completed/confirmed appointments)
        // Assuming $50 per appointment as per frontend logic
        const revenueSnapshot = await db.collection('appointments')
            .where('status', 'in', ['completed', 'confirmed'])
            .count().get();
        const revenueCount = revenueSnapshot.data().count;
        const revenue = revenueCount * 50;

        res.json({
            success: true,
            data: {
                stats: {
                    doctors: doctorsCount,
                    patients: patientsCount,
                    appointments: appointmentsCount,
                    revenue: revenue
                }
            }
        });
    } catch (error) {
        console.error('Error fetching admin stats:', error);
        throw error;
    }
}));

module.exports = router;
