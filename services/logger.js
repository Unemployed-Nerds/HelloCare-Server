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
    // Legacy: Keep writing to admin_logs for now, or just switch to activity_logs
    // For unified view, we'll write to activity_logs as role='admin'
    const logData = {
      userId: adminId,
      userName: adminName,
      role: 'admin',
      action,
      details,
      ip,
      timestamp: new Date().toISOString()
    };

    await db.collection('activity_logs').add(logData);

    // Also write to admin_logs for backward compatibility if needed, 
    // but for now let's prioritize the unified collection.
    // await db.collection('admin_logs').add({ ... }); 

    console.log(`[Audit Log] ${action} by ${adminName} (${adminId})`);
  } catch (error) {
    console.error('Error writing audit log:', error);
    // Don't throw error to prevent blocking the main action
  }
};



/**
 * Log a user action (Patient, Doctor, etc.)
 * @param {string} userId - The ID of the user performing the action
 * @param {string} userName - The name of the user
 * @param {string} role - The role of the user (patient, doctor, admin)
 * @param {string} action - The type of action (e.g., 'LOGIN', 'UPLOAD_FILE')
 * @param {Object} details - Additional details about the action
 * @param {string} [ip] - IP address of the requester
 */
const logUserAction = async (userId, userName, role, action, details = {}, ip = null) => {
  try {
    const logData = {
      userId,
      userName,
      role,
      action,
      details,
      ip,
      timestamp: new Date().toISOString()
    };

    // Store in a generic activity_logs collection for now
    // In the future, this can be split into patient_logs, doctor_logs, etc. if needed
    await db.collection('activity_logs').add(logData);
    console.log(`[User Log] ${action} by ${role}:${userName} (${userId})`);
  } catch (error) {
    console.error('Error writing user log:', error);
    // Don't throw error to prevent blocking the main action
  }
};

module.exports = {
  logAdminAction,
  logUserAction
};
