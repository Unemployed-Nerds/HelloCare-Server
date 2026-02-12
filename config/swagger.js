const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'HelloCare Server API',
            version: '1.0.0',
            description: 'API documentation for the HelloCare Server backend',
            contact: {
                name: 'API Support',
                email: 'support@hellocare.com',
            },
        },
        servers: [
            {
                url: 'http://localhost:3000/v1',
                description: 'Local development server',
            },
            // Add production server here when available
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
    },
    apis: ['./routes/*.js', './server.js'], // Path to the API docs
};

const specs = swaggerJsdoc(options);

module.exports = specs;
