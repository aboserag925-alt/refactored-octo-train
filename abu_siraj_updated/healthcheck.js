'use strict';

const http = require('node:http');
const port = Number(process.env.PORT || 3000);

const request = http.get({
  host: '127.0.0.1',
  port,
  path: '/api/health',
  timeout: 2500,
  headers: { Accept: 'application/json' },
}, (response) => {
  response.resume();
  process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1);
});

request.on('timeout', () => { request.destroy(); process.exit(1); });
request.on('error', () => process.exit(1));
