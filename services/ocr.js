const { TextractClient, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
const { getFileStream } = require('./s3');

// Initialize Textract client
const textractClient = new TextractClient({
  region: process.env.TEXTRACT_REGION || process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN })
  }
});

/**
 * Get file from S3 with retry logic (handles race condition where file might not be uploaded yet)
 * @param {string} fileKey - S3 object key
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} initialDelay - Initial delay in milliseconds
 * @returns {Promise<Readable>} - File stream
 */
async function getFileStreamWithRetry(fileKey, maxRetries = 5, initialDelay = 1000) {
  const { getFileStream } = require('./s3');
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await getFileStream(fileKey);
    } catch (error) {
      // Only retry on NoSuchKey errors (file doesn't exist yet)
      // AWS SDK v3 error structure: error.Code === 'NoSuchKey' (from the error log)
      const isNoSuchKey = error.Code === 'NoSuchKey' || 
                         (error.message && error.message.includes('does not exist')) ||
                         (error.message && error.message.includes('NoSuchKey'));
      
      if (isNoSuchKey && attempt < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, attempt); // Exponential backoff
        console.log(`File ${fileKey} not found, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      // For other errors or final attempt, throw
      throw error;
    }
  }
}

/**
 * Extract text from a document using AWS Textract
 * @param {string} fileKey - S3 object key of the document
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromDocument(fileKey) {
  try {
    // Get file from S3 with retry logic
    const fileStream = await getFileStreamWithRetry(fileKey);

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    // Detect document text using Textract
    const command = new DetectDocumentTextCommand({
      Document: {
        Bytes: fileBuffer
      }
    });

    const response = await textractClient.send(command);

    // Extract text from blocks
    let extractedText = '';
    if (response.Blocks) {
      // Filter only LINE and WORD blocks with text
      const lines = response.Blocks
        .filter(block => block.BlockType === 'LINE' && block.Text)
        .map(block => block.Text);

      extractedText = lines.join('\n');
    }

    return extractedText || 'No text could be extracted from the document.';
  } catch (error) {
    console.error('Error extracting text with Textract:', error);

    // Return error message instead of throwing to allow report creation to continue
    return `Error extracting text: ${error.message}`;
  }
}

/**
 * Process document asynchronously (for background jobs)
 * Updates the report document in Firestore with extracted text
 * @param {string} reportId - Report document ID
 * @param {string} fileKey - S3 object key
 */
async function processDocumentAsync(reportId, fileKey) {
  try {
    const extractedText = await extractTextFromDocument(fileKey);

    // Update report document in Firestore
    const { db } = require('../config/firebase');
    await db.collection('reports').doc(reportId).update({
      extractedText,
      processedAt: new Date().toISOString()
    });

    console.log(`Successfully processed document for report ${reportId}`);
  } catch (error) {
    console.error(`Error processing document for report ${reportId}:`, error);

    // Update report with error message
    try {
      const { db } = require('../config/firebase');
      await db.collection('reports').doc(reportId).update({
        extractedText: `Error processing document: ${error.message}`,
        processedAt: new Date().toISOString(),
        processingError: true
      });
    } catch (updateError) {
      console.error('Error updating report with error status:', updateError);
    }
  }
}

module.exports = {
  extractTextFromDocument,
  processDocumentAsync
};

