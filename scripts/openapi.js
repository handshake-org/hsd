const swaggerJsdoc = require('swagger-jsdoc');
const pkg = require('../package.json');
const fs = require('fs');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: pkg.name,
      description: pkg.description,
      version: pkg.version,
      license: {
        name: pkg.license,
      },
    },
    components: {
      securitySchemes: {
        basicAuth: {
          type: 'http',
          scheme: 'basic',
        },
      },
    },
    security: [{ basicAuth: [] }],
    externalDocs: {
      description: 'Handshake Developer Documentation',
      url: 'https://hsd-dev.org/',
    },
  },
  apis: [
    './lib/node/http.js',
    './lib/wallet/http.js'
  ],
};

const openapiSpecification = swaggerJsdoc(options);
fs.writeFileSync(
  './docs/openapi.json',
  JSON.stringify(openapiSpecification, null, 2)
);
