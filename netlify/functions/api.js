// netlify/functions/api.js
// This file wraps the Express app as a Netlify serverless function.

const serverless = require('serverless-http');
const app = require('../../server');

module.exports.handler = serverless(app);
