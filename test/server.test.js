'use strict';

// Smoke tests for the HTTP layer. The server module exports a plain
// (req, res) handler when VERCEL is set, which lets us run it in-process
// without binding the production port or calling the Groq API.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.VERCEL = '1';
const requestHandler = require('../server.js');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(requestHandler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function request(pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, options);
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

test('GET /health reports the service as healthy', async () => {
  const res = await request('/health');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);

  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptimeSec, 'number');
  assert.match(body.apiKey, /^(set|MISSING)$/);
});

test('responses include the CORS header', async () => {
  const res = await request('/health');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('GET / serves the math solver UI', async () => {
  const res = await request('/');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.body, /<html/i);
});

test('GET /notes.html serves the notes page', async () => {
  const res = await request('/notes.html');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('unknown API routes return a structured 404', async () => {
  const res = await request('/api/does-not-exist');

  assert.equal(res.status, 404);
  const body = JSON.parse(res.body);
  assert.match(body.error.message, /Unknown API route/);
});

test('POST /api/chat rejects malformed JSON', async () => {
  const res = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"model": "llama"',
  });

  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.message, 'Invalid JSON body');
});

test('POST /api/chat rejects a payload without model/messages', async () => {
  const res = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '2 + 2' }),
  });

  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error.message, /Invalid payload/);
});

test('OPTIONS preflight is answered with 204', async () => {
  const res = await request('/api/chat', { method: 'OPTIONS' });

  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});

test('static serving does not escape the project root', async () => {
  // Encoded separators must never resolve to files outside STATIC_ROOT.
  for (const pathname of ['/..%2fpackage.json', '/..%5cpackage.json']) {
    const res = await request(pathname);
    assert.notEqual(res.status, 200, `${pathname} should not be served`);
    assert.doesNotMatch(res.body, /math-solver-ai/, `${pathname} leaked package.json`);
  }
});

test('missing static files return 404', async () => {
  const res = await request('/definitely-not-here.html');

  assert.equal(res.status, 404);
  assert.match(JSON.parse(res.body).error.message, /Not found/);
});
