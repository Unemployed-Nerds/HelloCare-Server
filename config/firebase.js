const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Initialize Firebase Admin SDK
let initialized = false;

function initializeFirebase() {
  if (initialized) {
    return admin;
  }

  try {
    // Check if service account JSON is provided as environment variable
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } 
    // Check if service account path is provided
    else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      } else {
        throw new Error(`Firebase service account file not found at: ${serviceAccountPath}`);
      }
    }
    // Try default location
    else {
      const defaultPath = path.resolve(__dirname, '../firebase-service-account.json');
      if (fs.existsSync(defaultPath)) {
        const serviceAccount = require(defaultPath);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      } else {
        throw new Error('Firebase service account not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON environment variable.');
      }
    }

    initialized = true;
    console.log('Firebase Admin SDK initialized successfully');
    return admin;
  } catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error.message);
    throw error;
  }
}

// Initialize on module load
const firebaseAdmin = initializeFirebase();

module.exports = {
  admin: firebaseAdmin,
  auth: firebaseAdmin.auth(),
  db: firebaseAdmin.firestore()
};

