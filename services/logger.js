const { db } = require('../config/firebase');

/**
 * Log an admin action
 * @param {string} adminId - The ID of the admin performing the action
 * @param {string} adminName - The name of the admin
 * @param {string} action - The type of action (e.g., 'LOGIN', 'APPROVE_APPOINTMENT')
 * @param {Object} details - Additional details about the action
 * @param {string} [ip] - IP address of the requester
 */
const logAdminAction = async (adminId, adminName, action, details = {}, ip = null) => {
  try {
    const logData = {
      adminId,
      adminName,
      action,
      details,
      ip,
      timestamp: new Date().toISOString()
    };

    await db.collection('admin_logs').add(logData);
    console.log(`[Audit Log] ${action} by ${adminName} (${adminId})`);
  } catch (error) {
    console.error('Error writing audit log:', error);
    // Don't throw error to prevent blocking the main action
  }
};

module.exports = {
  logAdminAction
};
