const { admin, storage } = require('../config/firebase');
const archiver = require('archiver');
const { Readable } = require('stream');

const DEFAULT_EXPIRY = 3600; // 1 hour

/**
 * Generate presigned URL for file upload
 * @param {string} fileKey - Storage object path
 * @param {string} contentType - MIME type of the file
 * @param {number} expiresIn - Expiration time in seconds (default: 3600)
 * @returns {Promise<{uploadUrl: string, fileKey: string, expiresIn: number}>}
 */
async function generateUploadUrl(fileKey, contentType, expiresIn = DEFAULT_EXPIRY) {
  try {
    // Get bucket - must be specified via env or initialized in Firebase config
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName) {
      throw new Error('FIREBASE_STORAGE_BUCKET environment variable is required');
    }
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileKey);
    
    const [uploadUrl] = await file.getSignedUrl({
      action: 'write',
      expires: new Date(Date.now() + expiresIn * 1000),
      contentType: contentType,
      version: 'v4'
    });

    return {
      uploadUrl,
      fileKey,
      expiresIn
    };
  } catch (error) {
    console.error('Error generating upload URL:', error);
    throw new Error('Failed to generate upload URL');
  }
}

/**
 * Generate presigned URL for file download
 * @param {string} fileKey - Storage object path
 * @param {number} expiresIn - Expiration time in seconds (default: 3600)
 * @returns {Promise<{downloadUrl: string, expiresIn: number}>}
 */
async function generateDownloadUrl(fileKey, expiresIn = DEFAULT_EXPIRY) {
  try {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName) {
      throw new Error('FIREBASE_STORAGE_BUCKET environment variable is required');
    }
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileKey);
    
    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      console.error(`File does not exist: ${fileKey} in bucket: ${bucketName}`);
      throw new Error(`File not found: ${fileKey}`);
    }
    
    const [downloadUrl] = await file.getSignedUrl({
      action: 'read',
      expires: new Date(Date.now() + expiresIn * 1000),
      version: 'v4'
    });

    return {
      downloadUrl,
      expiresIn
    };
  } catch (error) {
    console.error('Error generating download URL:', error);
    if (error.message && error.message.includes('File not found')) {
      throw error;
    }
    throw new Error('Failed to generate download URL');
  }
}

/**
 * Get file from Storage as a stream
 * @param {string} fileKey - Storage object path
 * @returns {Promise<Readable>}
 */
async function getFileStream(fileKey) {
  try {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName) {
      throw new Error('FIREBASE_STORAGE_BUCKET environment variable is required');
    }
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileKey);
    
    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      const error = new Error('File not found');
      error.Code = 'NoSuchKey';
      error.code = 404; // Firebase uses code 404 for not found
      throw error;
    }

    return file.createReadStream();
  } catch (error) {
    // Check if it's a Firebase Storage "not found" error
    if (error.code === 404 || error.code === 'ENOENT' || 
        (error.message && (error.message.includes('does not exist') || error.message.includes('No such object')))) {
      const notFoundError = new Error('File not found');
      notFoundError.Code = 'NoSuchKey';
      notFoundError.code = 404;
      throw notFoundError;
    }
    
    console.error('Error getting file from Storage:', error);
    // Preserve the original error so retry logic can check error codes
    throw error;
  }
}

/**
 * Upload file buffer to Storage
 * @param {string} fileKey - Storage object path
 * @param {Buffer} fileBuffer - File content as buffer
 * @param {string} contentType - MIME type of the file
 * @returns {Promise<string>} - Storage URL of the uploaded file
 */
async function uploadFile(fileKey, fileBuffer, contentType) {
  try {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName) {
      throw new Error('FIREBASE_STORAGE_BUCKET environment variable is required');
    }
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileKey);
    
    await file.save(fileBuffer, {
      metadata: {
        contentType: contentType
      }
    });

    // Note: Files are private by default. Use signed URLs for access.
    // If you need public access, uncomment: await file.makePublic();

    return `https://storage.googleapis.com/${bucket.name}/${fileKey}`;
  } catch (error) {
    console.error('Error uploading file to Storage:', error);
    throw new Error('Failed to upload file to Storage');
  }
}

/**
 * Export multiple reports as a ZIP file
 * @param {Array<string>} reportIds - Array of report IDs
 * @param {string} userId - User ID requesting the export
 * @returns {Promise<{exportUrl: string, expiresIn: number}>}
 */
function exportReports(reportIds, userId) {
  return new Promise(async (resolve, reject) => {
    try {
      const { db } = require('../config/firebase');
      
      // Fetch report documents from Firestore
      const reports = [];
      for (const reportId of reportIds) {
        const reportDoc = await db.collection('reports').doc(reportId).get();
        if (reportDoc.exists) {
          const reportData = reportDoc.data();
          // Verify user owns the report
          if (reportData.userId === userId) {
            reports.push({ id: reportId, ...reportData });
          }
        }
      }

      if (reports.length === 0) {
        return reject(new Error('No valid reports found for export'));
      }

      // Create ZIP archive in memory
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks = [];

      archive.on('data', (chunk) => {
        chunks.push(chunk);
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.on('end', async () => {
        try {
          // Combine all chunks into a single buffer
          const zipBuffer = Buffer.concat(chunks);

          // Generate export file key
          const timestamp = Date.now();
          const exportKey = `exports/${userId}/export_${timestamp}.zip`;

          // Upload ZIP to Storage
          await uploadFile(exportKey, zipBuffer, 'application/zip');

          // Generate presigned download URL
          const { downloadUrl, expiresIn } = await generateDownloadUrl(exportKey);

          resolve({
            exportUrl: downloadUrl,
            expiresIn
          });
        } catch (error) {
          reject(error);
        }
      });

      // Add each report file to the archive
      for (const report of reports) {
        try {
          const fileStream = await getFileStream(report.fileKey);
          const fileName = report.fileName || `report_${report.id}.${report.fileType || 'pdf'}`;
          archive.append(fileStream, { name: fileName });
        } catch (error) {
          console.error(`Error adding report ${report.id} to archive:`, error);
          // Continue with other reports even if one fails
        }
      }

      // Finalize the archive
      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  generateUploadUrl,
  generateDownloadUrl,
  getFileStream,
  uploadFile,
  exportReports
};

