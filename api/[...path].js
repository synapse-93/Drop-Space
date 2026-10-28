'use strict';

const app = require('../server');

module.exports = app;

// Keep the request as a stream so Busboy can process multipart uploads.
module.exports.config = { api: { bodyParser: false } };
