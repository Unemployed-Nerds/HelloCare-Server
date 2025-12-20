# HelloCare-Server
Backend for a hackathon project

## Overview
Production-ready Node.js API server built with Express.js.

## Features
- Express.js server with health check endpoint
- Docker and Docker Compose support
- Production-ready configuration
- Graceful shutdown handling
- Request logging
- Error handling middleware

## Quick Start

### Using Docker Compose (Recommended)
```bash
docker-compose up --build
```

The server will be available at `http://localhost:3000`

### Using Docker
```bash
docker build -t hellocare-server .
docker run -p 3000:3000 hellocare-server
```

### Local Development
```bash
# Install dependencies
npm install

# Start the server
npm start
```

## API Endpoints

### Health Check
- **GET** `/health`
  - Returns server status, uptime, and environment information
  - Response:
    ```json
    {
      "status": "ok",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "uptime": 123.456,
      "environment": "production"
    }
    ```

### Root
- **GET** `/`
  - Returns API information and available endpoints

## Environment Variables
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment mode (development/production)

## Docker
The application includes:
- Multi-stage Dockerfile optimized for production
- Health checks configured
- Non-root user for security
- Docker Compose for easy orchestration
