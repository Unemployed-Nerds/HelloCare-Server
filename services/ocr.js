const { TextractClient, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
const { getFileStream } = require('./storage');

// Initialize Textract client
// Uses AWS SDK default credential provider chain
const textractClient = new TextractClient({
  region: process.env.TEXTRACT_REGION || process.env.AWS_REGION || 'us-east-1'
  // If credentials are not provided, SDK will use default credential provider chain
  // To explicitly use credentials, uncomment below:
  // credentials: process.env.AWS_ACCESS_KEY_ID ? {
  //   accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  //   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  //   ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN })
  // } : undefined
});

/**
 * Extract text from a document using AWS Textract
 * @param {string} fileKey - Firebase Storage object path
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromDocument(fileKey) {
  try {
    // Get file from Firebase Storage
    const fileStream = await getFileStream(fileKey);

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
 * @param {string} fileKey - Firebase Storage object path
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

