const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

// Initialize Firebase Admin SDK
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-service-account.json';
const serviceAccount = require(path.resolve(__dirname, '..', serviceAccountPath));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

const createAdmin = async () => {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;

    if (!email || !password) {
        console.error('Error: ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
        process.exit(1);
    }
    try {
        console.log(`Creating admin user with email: ${email}`);

        // Check if user already exists
        let userRecord;
        try {
            userRecord = await auth.getUserByEmail(email);
            console.log('User already exists in Authentication');
        } catch (error) {
            if (error.code === 'auth/user-not-found') {
                // Create new user
                userRecord = await auth.createUser({
                    email,
                    password,
                    displayName: 'Admin User',
                    emailVerified: true
                });
                console.log('User created in Authentication');
            } else {
                throw error;
            }
        }

        // Create or update user document in Firestore
        const userData = {
            userId: userRecord.uid,
            email: userRecord.email,
            name: userRecord.displayName || 'Admin User',
            role: 'admin',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await db.collection('users').doc(userRecord.uid).set(userData, { merge: true });
        console.log('Admin user document created/updated in Firestore');

        console.log('Admin setup completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('Error creating admin:', error);
        process.exit(1);
    }
};

createAdmin();
