const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const archiver = require('archiver');
const { Readable } = require('stream');
const { db } = require('../config/firebase');

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN })
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'hellocare-reports';
const DEFAULT_EXPIRY = 3600; // 1 hour

/**
 * Generate presigned URL for file upload
 * @param {string} fileKey - S3 object key
 * @param {string} contentType - MIME type of the file
 * @param {number} expiresIn - Expiration time in seconds (default: 3600)
 * @returns {Promise<{uploadUrl: string, fileKey: string, expiresIn: number}>}
 */
async function generateUploadUrl(fileKey, contentType, expiresIn = DEFAULT_EXPIRY) {
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      ContentType: contentType
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });

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
 * @param {string} fileKey - S3 object key
 * @param {number} expiresIn - Expiration time in seconds (default: 3600)
 * @returns {Promise<{downloadUrl: string, expiresIn: number}>}
 */
async function generateDownloadUrl(fileKey, expiresIn = DEFAULT_EXPIRY) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey
    });

    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn });

    return {
      downloadUrl,
      expiresIn
    };
  } catch (error) {
    console.error('Error generating download URL:', error);
    throw new Error('Failed to generate download URL');
  }
}

/**
 * Get file from S3 as a stream
 * @param {string} fileKey - S3 object key
 * @returns {Promise<Readable>}
 */
async function getFileStream(fileKey) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey
    });

    const response = await s3Client.send(command);
    return response.Body;
  } catch (error) {
    console.error('Error getting file from S3:', error);
    // Preserve the original error so retry logic can check error codes
    throw error;
  }
}

/**
 * Upload file buffer to S3
 * @param {string} fileKey - S3 object key
 * @param {Buffer} fileBuffer - File content as buffer
 * @param {string} contentType - MIME type of the file
 * @returns {Promise<string>} - S3 URL of the uploaded file
 */
async function uploadFile(fileKey, fileBuffer, contentType) {
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      Body: fileBuffer,
      ContentType: contentType
    });

    await s3Client.send(command);

    return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${fileKey}`;
  } catch (error) {
    console.error('Error uploading file to S3:', error);
    throw new Error('Failed to upload file to S3');
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

          // Upload ZIP to S3
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
  exportReports,
  BUCKET_NAME
};

