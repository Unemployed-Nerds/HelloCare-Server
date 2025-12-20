# HelloCare Server

Backend API server for HelloCare - A comprehensive healthcare management platform.

## Overview

Production-ready Node.js API server built with Express.js that provides authentication, medical reports management, appointment booking, AI-powered health insights, and more.

## Features

- **Authentication**: Patient and doctor signup/login with Firebase Auth
- **Reports Management**: Upload, download, and manage medical reports with OCR text extraction
- **AI Features**: Health summaries and personalized suggestions using Google Gemini AI
- **QR Code Sharing**: Secure QR code generation for sharing medical reports
- **Appointments**: Book and manage appointments with time slot availability
- **Doctor Management**: Doctor profiles, availability, and scheduling
- **Payment Processing**: Mock payment integration (ready for real gateway)
- **File Storage**: AWS S3 integration for secure file storage
- **OCR Processing**: Google Cloud Vision API for text extraction from medical documents

## Prerequisites

- Node.js >= 18.0.0
- Firebase project with Firestore enabled
- AWS account with S3 access
- Google Cloud account with Vision API and Gemini API access (same project as Firebase)

## Setup Instructions

### 1. Firebase Setup

1. **Create Firebase Project**:
   - Go to [Firebase Console](https://console.firebase.google.com/)
   - Create a new project or use existing one

2. **Enable Authentication**:
   - Go to Authentication > Sign-in method
   - Enable "Email/Password" provider

3. **Create Firestore Database**:
   - Go to Firestore Database
   - Create database (start in production mode or test mode for development)
   - Choose a location for your database

4. **Generate Service Account Key**:
   - Go to Project Settings > Service Accounts
   - Click "Generate New Private Key"
   - Save the JSON file as `firebase-service-account.json` in the project root
   - **OR** copy the JSON content to set as environment variable

5. **Set Firestore Security Rules** (for development):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

### 2. AWS Setup

#### Create S3 Bucket

1. **Create S3 Bucket**:
   - Go to [AWS S3 Console](https://console.aws.amazon.com/s3/)
   - Click "Create bucket"
   - Choose a unique bucket name (e.g., `hellocare-reports`)
   - Select region (e.g., `us-east-1`)
   - Uncheck "Block all public access" if you need public URLs, or keep private and use presigned URLs (recommended)
   - Click "Create bucket"

2. **Configure CORS** (if needed):
   - Go to bucket > Permissions > CORS
   - Add CORS configuration:
   ```json
   [
     {
       "AllowedHeaders": ["*"],
       "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
       "AllowedOrigins": ["*"],
       "ExposeHeaders": []
     }
   ]
   ```

#### Create IAM User

1. **Create IAM User**:
   - Go to [IAM Console](https://console.aws.amazon.com/iam/)
   - Click "Users" > "Add users"
   - Choose a username (e.g., `hellocare-server`)
   - Select "Access key - Programmatic access"

2. **Attach Policies**:
   - Click "Attach existing policies directly"
   - Attach the following policy:
     - `AmazonS3FullAccess` (or create custom policy with only needed permissions)
   - Click "Next" and complete user creation

3. **Save Credentials**:
   - Copy the Access Key ID and Secret Access Key
   - Save them securely - you'll need them for environment variables

### 3. Google Cloud Vision API Setup

1. **Enable Cloud Vision API**:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Select your Firebase project (same project ID)
   - Navigate to "APIs & Services" > "Library"
   - Search for "Cloud Vision API"
   - Click "Enable"

2. **Verify Service Account Permissions**:
   - Go to "IAM & Admin" > "Service Accounts"
   - Find your Firebase service account (usually `firebase-adminsdk-xxxxx@project-id.iam.gserviceaccount.com`)
   - Ensure it has "Cloud Vision API User" role (or "Editor" role which includes it)
   - If not, click "Edit" and add the "Cloud Vision API User" role

**Note**: The same Firebase service account credentials used for Firebase Admin SDK will be used for Google Cloud Vision API. No additional API keys or credentials are needed.

### 4. Google Gemini API Setup

1. **Get API Key**:
   - Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Sign in with your Google account
   - Click "Create API Key"
   - Copy the API key
   - **Note**: API keys are free to use with usage limits. For production, consider setting up billing.

### 5. Environment Configuration

1. **Copy Environment Template**:
   ```bash
   cp .env.example .env
   ```

2. **Update `.env` file** with your credentials:
   ```env
   # Server Configuration
   PORT=3000
   NODE_ENV=development

   # Firebase Admin SDK
   # Option 1: Path to service account JSON file
   FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
   
   # Option 2: Direct JSON (alternative to file path)
   # FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}

   # AWS Configuration
   AWS_ACCESS_KEY_ID=your_aws_access_key_id
   AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
   AWS_REGION=us-east-1

   # S3 Configuration
   S3_BUCKET_NAME=hellocare-reports

   # Google Gemini API
   GEMINI_API_KEY=your_gemini_api_key

   # CORS Configuration
   CORS_ORIGIN=http://localhost:3000,https://yourdomain.com
   ```

3. **Place Firebase Service Account JSON**:
   - If using `FIREBASE_SERVICE_ACCOUNT_PATH`, place `firebase-service-account.json` in the project root
   - Ensure the file is in `.gitignore` (it should be by default)

## Installation

1. **Clone the repository** (if not already cloned)

2. **Install dependencies**:
   ```bash
   cd HelloCare-Server
   npm install
   ```

3. **Configure environment variables** (see above)

## Running the Server

### Development Mode

```bash
npm start
# or
npm run dev
```

The server will start on `http://localhost:3000`

### Production Mode

```bash
NODE_ENV=production npm start
```

### Using Docker

```bash
# Build image
docker build -t hellocare-server .

# Run container
docker run -p 3000:3000 --env-file .env hellocare-server
```

### Using Docker Compose

```bash
docker-compose up --build
```

**Note**: Update `docker-compose.yml` to include environment variables or use an `.env` file.

## API Endpoints

Base URL: `https://hellocare.p1ng.me/v1` (production) or `http://localhost:3000/v1` (development)

### Authentication
- `POST /v1/auth/patient/signup` - Patient signup
- `POST /v1/auth/patient/login` - Patient login
- `POST /v1/auth/doctor/signup` - Doctor signup
- `POST /v1/auth/doctor/login` - Doctor login

### Reports
- `POST /v1/reports/upload-url` - Get S3 upload URL
- `POST /v1/reports` - Submit report metadata
- `GET /v1/reports` - Get user reports (with filters)
- `GET /v1/reports/:reportId` - Get report details
- `GET /v1/reports/:reportId/download-url` - Get download URL
- `POST /v1/reports/export` - Export reports as ZIP
- `POST /v1/reports/qr/generate` - Generate QR code for reports
- `POST /v1/reports/qr/validate` - Validate QR token
- `GET /v1/reports/qr/:qrToken` - Get reports via QR token (doctor access)

### AI Features
- `GET /v1/ai/summary` - Get AI health summary
- `GET /v1/ai/suggestions` - Get AI suggestions (optionally for specific report)

### Doctors
- `GET /v1/doctors` - Get all doctors (with filters)
- `GET /v1/doctors/:doctorId` - Get doctor details
- `PUT /v1/doctors/:doctorId/availability` - Update doctor availability
- `GET /v1/doctors/:doctorId/slots` - Get available time slots

### Appointments
- `POST /v1/appointments` - Book appointment
- `GET /v1/appointments/patient` - Get patient appointments
- `GET /v1/appointments/doctor` - Get doctor appointments
- `GET /v1/appointments/:appointmentId` - Get appointment details
- `PUT /v1/appointments/:appointmentId/status` - Update appointment status
- `PUT /v1/appointments/:appointmentId/notes` - Add doctor notes
- `DELETE /v1/appointments/:appointmentId` - Cancel appointment

### Payment
- `POST /v1/payment/process` - Process payment (mock)

### Health Check
- `GET /health` - Server health check

For detailed API documentation, see `API_DOCUMENTATION.md` in the project root.

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PORT` | Server port | No | `3000` |
| `NODE_ENV` | Environment mode | No | `development` |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Path to Firebase service account JSON | Yes* | - |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase service account JSON string | Yes* | - |
| `AWS_ACCESS_KEY_ID` | AWS access key ID | Yes | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret access key | Yes | - |
| `AWS_REGION` | AWS region | Yes | - |
| `S3_BUCKET_NAME` | S3 bucket name | Yes | - |
| `GEMINI_API_KEY` | Google Gemini API key | Yes | - |
| `CORS_ORIGIN` | CORS allowed origins (comma-separated) | No | `*` |

*Either `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_SERVICE_ACCOUNT_JSON` is required.

## Project Structure

```
HelloCare-Server/
├── config/
│   └── firebase.js           # Firebase Admin SDK configuration
├── middleware/
│   ├── auth.js               # Authentication middleware
│   └── errorHandler.js       # Error handling middleware
├── routes/
│   ├── auth.js               # Authentication routes
│   ├── reports.js            # Report routes
│   ├── ai.js                 # AI feature routes
│   ├── doctors.js            # Doctor routes
│   ├── appointments.js       # Appointment routes
│   └── payment.js            # Payment routes
├── services/
│   ├── firebase.js           # Firestore helper functions
│   ├── s3.js                 # S3 file operations
│   ├── ocr.js                # OCR text extraction
│   ├── ai.js                 # AI summary/suggestions
│   └── qr.js                 # QR code generation/validation
├── utils/                    # Utility functions
├── server.js                 # Main server file
├── package.json
├── .env.example              # Environment variables template
└── README.md
```

## Troubleshooting

### Firebase Issues
- Ensure service account JSON has correct permissions
- Verify Firestore is enabled in Firebase Console
- Check that authentication is enabled

### AWS Issues
- Verify IAM user has correct permissions (S3)
- Check that S3 bucket exists and is accessible
- Ensure AWS region is correct

### Google Cloud Vision API Issues
- Ensure Cloud Vision API is enabled in Google Cloud Console
- Verify Firebase service account has "Cloud Vision API User" role
- Check that you're using the same Google Cloud project as Firebase
- Verify billing is enabled (required for Vision API usage)

### Gemini API Issues
- Verify API key is correct
- Check API quota/limits in Google AI Studio
- Ensure API key has access to Gemini Pro model

## Security Notes

- **Never commit** `.env` file or `firebase-service-account.json` to version control
- Use environment variables for all sensitive credentials
- In production, use AWS IAM roles instead of access keys when possible
- Configure CORS appropriately for production
- Use HTTPS in production
- Implement rate limiting for production (not included in this version)

## License

ISC
