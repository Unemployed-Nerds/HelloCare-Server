const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { db, admin } = require('../config/firebase');
const { generateUploadUrl, generateDownloadUrl, exportReports } = require('../services/storage');
const { processDocumentAsync } = require('../services/ocr');
const { generateQRToken, validateQRToken, generateQRCodeImage, getReportsByQRToken } = require('../services/qr');
const { generateSummaryForReports } = require('../services/ai');

const router = express.Router();

/**
 * Get Firebase Storage Upload URL
 * POST /v1/reports/upload-url
 */
router.post('/upload-url', authenticateToken, [
  body('fileName').trim().notEmpty(),
  body('fileType').trim().notEmpty(),
  body('fileSize').isInt({ min: 1 })
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

  const { fileName, fileType, fileSize } = req.body;
  const userId = req.user.uid;

  // Generate unique file key
  const timestamp = Date.now();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const fileKey = `reports/${userId}/${timestamp}_${sanitizedFileName}`;

  // Determine content type
  const contentTypes = {
    pdf: 'application/pdf',
    image: 'image/jpeg',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
  };
  const contentType = contentTypes[fileType.toLowerCase()] || fileType || 'application/octet-stream';

  try {
    const result = await generateUploadUrl(fileKey, contentType);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    throw error;
  }
}));

/**
 * Submit Report Metadata
 * POST /v1/reports
 */
router.post('/', authenticateToken, [
  body('fileKey').trim().notEmpty(),
  body('fileName').trim().notEmpty(),
  body('fileType').trim().notEmpty(),
  body('title').trim().notEmpty(),
  body('reportDate').isISO8601(),
  body('category').optional().trim(),
  body('doctorName').optional().trim(),
  body('clinicName').optional().trim()
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

  const { fileKey, fileName, fileType, title, reportDate, category, doctorName, clinicName } = req.body;
  const userId = req.user.uid;

  // Verify fileKey belongs to user
  if (!fileKey.startsWith(`reports/${userId}/`)) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Invalid file key',
        details: {}
      }
    });
  }

  try {
    // Generate report ID
    const reportRef = db.collection('reports').doc();
    const reportId = reportRef.id;

    // Get storage bucket name
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName) {
      throw new Error('FIREBASE_STORAGE_BUCKET environment variable is required');
    }

    // Parse reportDate from ISO string to Firestore Timestamp
    const reportDateTimestamp = admin.firestore.Timestamp.fromDate(new Date(reportDate));
    const uploadDateTimestamp = admin.firestore.FieldValue.serverTimestamp();
    const createdAtTimestamp = admin.firestore.FieldValue.serverTimestamp();

    // Create report document
    const reportData = {
      reportId,
      userId,
      fileKey,
      fileName,
      fileType: fileType.toLowerCase(),
      title,
      reportDate: reportDateTimestamp,
      category: category || 'General',
      doctorName: doctorName || null,
      clinicName: clinicName || null,
      uploadDate: uploadDateTimestamp,
      extractedText: null,
      storageUrl: `https://storage.googleapis.com/${bucketName}/${fileKey}`,
      createdAt: createdAtTimestamp
    };

    await reportRef.set(reportData);

    // Process OCR asynchronously (don't wait for it)
    processDocumentAsync(reportId, fileKey).catch(err => {
      console.error(`Error processing OCR for report ${reportId}:`, err);
    });

    res.status(201).json({
      success: true,
      message: 'Report submitted successfully',
      data: reportData
    });
  } catch (error) {
    console.error('Error submitting report:', error);
    throw error;
  }
}));

/**
 * Get User Reports
 * GET /v1/reports
 */
router.get('/', authenticateToken, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('category').optional().trim(),
  query('fileType').optional().trim(),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('search').optional().trim()
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid query parameters',
        details: errors.array()
      }
    });
  }

  const userId = req.user.uid;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const { category, fileType, startDate, endDate, search } = req.query;

  try {
    let query = db.collection('reports').where('userId', '==', userId);

    // Apply filters
    if (category) {
      query = query.where('category', '==', category);
    }
    if (fileType) {
      query = query.where('fileType', '==', fileType.toLowerCase());
    }
    if (startDate) {
      query = query.where('reportDate', '>=', startDate);
    }
    if (endDate) {
      query = query.where('reportDate', '<=', endDate);
    }

    // Get total count (before pagination)
    const allDocs = await query.get();
    const total = allDocs.size;

    // Apply ordering and pagination
    query = query.orderBy('uploadDate', 'desc');

    // Apply offset for pagination
    const offset = (page - 1) * limit;
    if (offset > 0 && allDocs.docs.length > 0) {
      const offsetSnapshot = await query.limit(offset).get();
      if (!offsetSnapshot.empty) {
        const lastDoc = offsetSnapshot.docs[offsetSnapshot.docs.length - 1];
        query = query.startAfter(lastDoc);
      }
    }
    query = query.limit(limit);

    const snapshot = await query.get();
    let reports = snapshot.docs.map(doc => ({ ...doc.data() }));

    // Apply search filter if provided (client-side filtering for text search)
    if (search) {
      const searchLower = search.toLowerCase();
      reports = reports.filter(report => {
        return (
          report.title?.toLowerCase().includes(searchLower) ||
          report.doctorName?.toLowerCase().includes(searchLower) ||
          report.clinicName?.toLowerCase().includes(searchLower) ||
          report.category?.toLowerCase().includes(searchLower)
        );
      });
    }

    res.json({
      success: true,
      data: {
        reports,
        total,
        page,
        limit
      }
    });
  } catch (error) {
    console.error('Error fetching reports:', error);
    throw error;
  }
}));

/**
 * Get Report Details
 * GET /v1/reports/:reportId
 */
router.get('/:reportId', authenticateToken, asyncHandler(async (req, res) => {
  const { reportId } = req.params;
  const userId = req.user.uid;

  try {
    const reportDoc = await db.collection('reports').doc(reportId).get();

    if (!reportDoc.exists) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Report not found',
          details: {}
        }
      });
    }

    const reportData = reportDoc.data();

    // Verify user owns the report
    if (reportData.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
          details: {}
        }
      });
    }

    res.json({
      success: true,
      data: reportData
    });
  } catch (error) {
    console.error('Error fetching report:', error);
    throw error;
  }
}));

/**
 * Get Firebase Storage Download URL
 * GET /v1/reports/:reportId/download-url
 */
router.get('/:reportId/download-url', authenticateToken, asyncHandler(async (req, res) => {
  const { reportId } = req.params;
  const userId = req.user.uid;

  try {
    const reportDoc = await db.collection('reports').doc(reportId).get();

    if (!reportDoc.exists) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Report not found',
          details: {}
        }
      });
    }

    const reportData = reportDoc.data();

    // Verify user owns the report
    if (reportData.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
          details: {}
        }
      });
    }

    // Verify file exists before generating download URL
    try {
      const result = await generateDownloadUrl(reportData.fileKey);
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      console.error(`Error generating download URL for report ${reportId}:`, error);
      if (error.message && error.message.includes('File not found')) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Report file not found in storage. The file may not have been uploaded successfully.',
            details: {
              fileKey: reportData.fileKey
            }
          }
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Error generating download URL:', error);
    throw error;
  }
}));

/**
 * Export Reports
 * POST /v1/reports/export
 */
router.post('/export', authenticateToken, [
  body('reportIds').isArray({ min: 1 }),
  body('reportIds.*').isString(),
  body('format').optional().equals('zip')
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

  const { reportIds, format } = req.body;
  const userId = req.user.uid;

  try {
    const result = await exportReports(reportIds, userId);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error exporting reports:', error);
    
    if (error.message === 'No valid reports found for export') {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: error.message,
          details: {}
        }
      });
    }

    throw error;
  }
}));

/**
 * Generate QR Code for Reports
 * POST /v1/reports/qr/generate
 */
router.post('/qr/generate', authenticateToken, [
  body('reportIds').isArray({ min: 1 }),
  body('reportIds.*').isString(),
  body('expiresIn').optional().isInt({ min: 60, max: 86400 })
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

  const { reportIds, expiresIn = 3600 } = req.body;
  const userId = req.user.uid;

  try {
    // Verify user owns all reports
    for (const reportId of reportIds) {
      const reportDoc = await db.collection('reports').doc(reportId).get();
      if (!reportDoc.exists || reportDoc.data().userId !== userId) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: `Access denied to report ${reportId}`,
            details: {}
          }
        });
      }
    }

    // Generate QR token
    const { qrToken, expiresAt } = await generateQRToken(reportIds, expiresIn, userId);

    // Generate AI summary for selected reports (async, don't block QR generation)
    let aiSummary = null;
    try {
      const summaryResult = await generateSummaryForReports(reportIds);
      aiSummary = summaryResult.summary;
      
      // Store summary in QR token document
      await db.collection('qrTokens').doc(qrToken).update({
        aiSummary: aiSummary,
        summaryGeneratedAt: summaryResult.generatedAt
      });
    } catch (error) {
      console.error('Error generating AI summary for QR code:', error);
      // Continue without summary - QR code generation should not fail if summary fails
    }

    // Generate QR code image
    const qrCode = await generateQRCodeImage(qrToken);

    res.json({
      success: true,
      data: {
        qrToken,
        qrCode,
        expiresAt,
        aiSummary: aiSummary // Include summary in response if available
      }
    });
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw error;
  }
}));

/**
 * Validate QR Code Token
 * POST /v1/reports/qr/validate
 */
router.post('/qr/validate', authenticateToken, [
  body('qrToken').trim().notEmpty()
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

  const { qrToken } = req.body;

  try {
    const validation = await validateQRToken(qrToken);

    res.json({
      success: true,
      data: validation
    });
  } catch (error) {
    console.error('Error validating QR token:', error);
    throw error;
  }
}));

/**
 * Get Reports via QR Token (Doctor Access)
 * GET /v1/reports/qr/:qrToken
 */
router.get('/qr/:qrToken', authenticateToken, asyncHandler(async (req, res) => {
  const { qrToken } = req.params;

  try {
    // Verify user is a doctor
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'doctor') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Doctor access required',
          details: {}
        }
      });
    }

    const result = await getReportsByQRToken(qrToken);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error getting reports by QR token:', error);

    if (error.message === 'Invalid or expired QR token') {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: error.message,
          details: {}
        }
      });
    }

    throw error;
  }
}));

module.exports = router;

