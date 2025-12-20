const crypto = require('crypto');
const QRCode = require('qrcode');
const { db } = require('../config/firebase');
const { generateDownloadUrl } = require('../services/storage');

const ALGORITHM = 'aes-256-gcm';
// Generate or use provided secret key (must be 32 bytes for AES-256)
const generateSecretKey = () => {
  if (process.env.QR_SECRET_KEY) {
    // If provided, ensure it's 32 bytes
    const key = Buffer.from(process.env.QR_SECRET_KEY, 'hex');
    if (key.length === 32) {
      return process.env.QR_SECRET_KEY;
    }
    // If not hex or wrong length, hash it to get 32 bytes
    return crypto.createHash('sha256').update(process.env.QR_SECRET_KEY).digest('hex');
  }
  // Generate random 32-byte key
  return crypto.randomBytes(32).toString('hex');
};
const SECRET_KEY = generateSecretKey();
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt a token
 * @param {string} text - Text to encrypt
 * @returns {string} - Encrypted token
 */
function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(SECRET_KEY, 'hex'), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Combine iv, authTag, and encrypted data
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a token
 * @param {string} encryptedText - Encrypted token
 * @returns {string} - Decrypted text
 */
function decrypt(encryptedText) {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(SECRET_KEY, 'hex'), iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Generate QR token for reports
 * @param {Array<string>} reportIds - Array of report IDs
 * @param {number} expiresIn - Expiration time in seconds (default: 3600)
 * @param {string} userId - User ID who owns the reports
 * @returns {Promise<{qrToken: string, expiresAt: string}>}
 */
async function generateQRToken(reportIds, expiresIn = 3600, userId) {
  try {
    // Create token data
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const tokenData = {
      reportIds,
      userId,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString()
    };

    // Encrypt token data
    const encryptedToken = encrypt(JSON.stringify(tokenData));

    // Store token in Firestore (summary will be added later)
    const tokenDoc = {
      qrToken: encryptedToken,
      reportIds,
      userId,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString()
    };

    await db.collection('qrTokens').doc(encryptedToken).set(tokenDoc);

    return {
      qrToken: encryptedToken,
      expiresAt: expiresAt.toISOString()
    };
  } catch (error) {
    console.error('Error generating QR token:', error);
    throw new Error('Failed to generate QR token');
  }
}

/**
 * Validate QR token
 * @param {string} qrToken - QR token to validate
 * @returns {Promise<{valid: boolean, reportIds?: Array<string>, expiresAt?: string}>}
 */
async function validateQRToken(qrToken) {
  try {
    // First, try to get from Firestore (faster and more secure)
    const tokenDoc = await db.collection('qrTokens').doc(qrToken).get();

    if (!tokenDoc.exists) {
      // Try decrypting to verify if it's a valid encrypted token
      try {
        const decrypted = decrypt(qrToken);
        const tokenData = JSON.parse(decrypted);
        
        // Check expiration
        const expiresAt = new Date(tokenData.expiresAt);
        if (expiresAt < new Date()) {
          return { valid: false };
        }

        return {
          valid: true,
          reportIds: tokenData.reportIds,
          expiresAt: tokenData.expiresAt
        };
      } catch (error) {
        return { valid: false };
      }
    }

    const tokenData = tokenDoc.data();

    // Check expiration
    const expiresAt = new Date(tokenData.expiresAt);
    if (expiresAt < new Date()) {
      return { valid: false };
    }

    return {
      valid: true,
      reportIds: tokenData.reportIds,
      expiresAt: tokenData.expiresAt
    };
  } catch (error) {
    console.error('Error validating QR token:', error);
    return { valid: false };
  }
}

/**
 * Generate QR code image as base64 data URL
 * @param {string} qrToken - QR token to encode
 * @returns {Promise<string>} - Base64 data URL of QR code image
 */
async function generateQRCodeImage(qrToken) {
  try {
    // Generate QR code as data URL
    const dataUrl = await QRCode.toDataURL(qrToken, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      width: 300
    });

    return dataUrl;
  } catch (error) {
    console.error('Error generating QR code image:', error);
    throw new Error('Failed to generate QR code image');
  }
}

/**
 * Get reports by QR token (for doctor access)
 * @param {string} qrToken - QR token
 * @returns {Promise<Array>} - Array of report documents
 */
async function getReportsByQRToken(qrToken) {
  try {
    const validation = await validateQRToken(qrToken);

    if (!validation.valid) {
      throw new Error('Invalid or expired QR token');
    }

    const { reportIds } = validation;

    // Fetch report documents
    const reports = [];
    for (const reportId of reportIds) {
      const reportDoc = await db.collection('reports').doc(reportId).get();
      if (reportDoc.exists) {
        const reportData = reportDoc.data();
        // Convert Firestore Timestamp to ISO string
        let reportDateStr = null;
        if (reportData.reportDate) {
          if (reportData.reportDate.toDate) {
            // Firestore Timestamp
            reportDateStr = reportData.reportDate.toDate().toISOString();
          } else if (reportData.reportDate instanceof Date) {
            // Already a Date object
            reportDateStr = reportData.reportDate.toISOString();
          } else if (typeof reportData.reportDate === 'string') {
            // Already a string
            reportDateStr = reportData.reportDate;
          }
        }
        
        // Generate signed download URL for doctor access (valid for 1 hour)
        let downloadUrl = null;
        try {
          if (reportData.fileKey) {
            const urlResult = await generateDownloadUrl(reportData.fileKey, 3600);
            downloadUrl = urlResult.downloadUrl;
          }
        } catch (error) {
          console.error(`Error generating download URL for report ${reportId}:`, error);
          // Continue without download URL - the client can handle this
        }
        
        // Return limited report info (for doctor viewing)
        reports.push({
          reportId: reportDoc.id,
          fileName: reportData.fileName,
          fileType: reportData.fileType,
          title: reportData.title,
          reportDate: reportDateStr,
          category: reportData.category,
          doctorName: reportData.doctorName,
          clinicName: reportData.clinicName,
          storageUrl: downloadUrl || reportData.storageUrl // Use signed URL if available, fallback to storageUrl
        });
      }
    }

    // Get AI summary from QR token document if available
    let aiSummary = null;
    try {
      const tokenDoc = await db.collection('qrTokens').doc(qrToken).get();
      if (tokenDoc.exists) {
        const tokenData = tokenDoc.data();
        aiSummary = tokenData.aiSummary || null;
      }
    } catch (error) {
      console.error('Error fetching AI summary from QR token:', error);
      // Continue without summary
    }

    return {
      reports,
      expiresAt: validation.expiresAt,
      aiSummary: aiSummary
    };
  } catch (error) {
    console.error('Error getting reports by QR token:', error);
    throw error;
  }
}

module.exports = {
  generateQRToken,
  validateQRToken,
  generateQRCodeImage,
  getReportsByQRToken
};

