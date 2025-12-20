const vision = require('@google-cloud/vision');
const { getFileStream } = require('./storage');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Initialize Vision client with Firebase service account credentials
let visionClient = null;

function getVisionClient() {
  if (visionClient) {
    return visionClient;
  }

  try {
    let credentials;
    
    // Get credentials using the same logic as Firebase config
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      if (fs.existsSync(serviceAccountPath)) {
        credentials = require(serviceAccountPath);
      } else {
        throw new Error(`Firebase service account file not found at: ${serviceAccountPath}`);
      }
    } else {
      const defaultPath = path.resolve(__dirname, '../firebase-service-account.json');
      if (fs.existsSync(defaultPath)) {
        credentials = require(defaultPath);
      } else {
        throw new Error('Firebase service account not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON environment variable.');
      }
    }

    // Initialize Vision client with credentials
    visionClient = new vision.ImageAnnotatorClient({
      credentials: credentials
    });

    console.log('Google Cloud Vision API client initialized successfully');
    return visionClient;
  } catch (error) {
    console.error('Error initializing Vision client:', error.message);
    throw error;
  }
}

/**
 * Extract text from a document using Google Cloud Vision API
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

    // Get Vision client
    const client = getVisionClient();

    // Detect text using Vision API
    // Use documentTextDetection for better results with documents/PDFs
    const [result] = await client.documentTextDetection({
      image: { content: fileBuffer }
    });

    // Extract text from response
    let extractedText = '';
    if (result.fullTextAnnotation && result.fullTextAnnotation.text) {
      extractedText = result.fullTextAnnotation.text;
    } else if (result.textAnnotations && result.textAnnotations.length > 0) {
      // Fallback to textAnnotations if fullTextAnnotation is not available
      extractedText = result.textAnnotations[0].description || '';
    }

    return extractedText || 'No text could be extracted from the document.';
  } catch (error) {
    console.error('Error extracting text with Google Cloud Vision API:', error);

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
