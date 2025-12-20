const express = require('express');
const { query, body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { db } = require('../config/firebase');
const { logAdminAction } = require('../services/logger');

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
 * Get Admin Logs
 * GET /v1/admin/logs
 * Retrieves paginated audit logs for admin activities
 */
router.get('/logs', authenticateToken, requireAdmin, [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 })
], asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    try {
        console.log('Fetching admin logs (activity_logs)...');
        const snapshot = await db.collection('activity_logs')
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .offset(offset)
            .get();

        const logs = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json({
            success: true,
            data: {
                logs
            }
        });
    } catch (error) {
        console.error('Error fetching admin logs:', error);
        throw error;
    }
}));

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
    query('status').optional().isIn(['pending', 'confirmed', 'completed', 'cancelled']),
    query('patientId').optional().trim(),
    query('doctorId').optional().trim()
], asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const { status, patientId, doctorId } = req.query;

    try {
        let query = db.collection('appointments');

        if (status) {
            query = query.where('status', '==', status);
        }

        if (patientId) {
            query = query.where('patientId', '==', patientId);
        }

        if (doctorId) {
            query = query.where('doctorId', '==', doctorId);
        }

        query = query.orderBy('date', 'desc').limit(limit).offset(offset);

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
            .get();

        const revenue = revenueSnapshot.docs.reduce((total, doc) => {
            const data = doc.data();
            return total + (data.amount || 50);
        }, 0);

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



/**
 * Update Appointment Status
 * PUT /v1/admin/appointments/:id/status
 */
router.put('/appointments/:id/status', authenticateToken, requireAdmin, [
    body('status').isIn(['pending', 'confirmed', 'completed', 'cancelled'])
], asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const appointmentRef = db.collection('appointments').doc(id);
        const doc = await appointmentRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Appointment not found'
                }
            });
        }

        await appointmentRef.update({
            status,
            updatedAt: new Date().toISOString()
        });

        // Log the action
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        // Fetch current user details to get name (assuming req.user only has uid)
        // Optimization: In a real app we might cache this or store name in token
        const adminDoc = await db.collection('users').doc(req.user.uid).get();
        const adminName = adminDoc.exists ? adminDoc.data().name : 'Unknown Admin';

        logAdminAction(req.user.uid, adminName, 'UPDATE_APPOINTMENT_STATUS', {
            appointmentId: id,
            newStatus: status,
            previousStatus: doc.data().status
        }, ip);

        res.json({
            success: true,
            message: 'Appointment status updated successfully'
        });
    } catch (error) {
        console.error('Error updating appointment status:', error);
        throw error;
    }
}));

module.exports = router;
