import assert from 'node:assert/strict';
import app from '../src/index.js';

const subtleProto = Object.getPrototypeOf(globalThis.crypto.subtle);
const originalDeriveBits = subtleProto.deriveBits;
let highestPbkdf2Iterations = 0;
subtleProto.deriveBits = function patchedDeriveBits(algorithm, ...args) {
  if (algorithm?.name === 'PBKDF2') {
    highestPbkdf2Iterations = Math.max(highestPbkdf2Iterations, Number(algorithm.iterations || 0));
    if (algorithm.iterations > 100000) {
      throw new Error(`Pbkdf2 failed: iteration counts above 100000 are not supported (requested ${algorithm.iterations})`);
    }
  }
  return originalDeriveBits.call(this, algorithm, ...args);
};

async function call(path, options = {}, token = '') {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  }));
  const body = await response.json();
  assert.equal(body.ok, true, `${path} failed: ${JSON.stringify(body)}`);
  return { response, body };
}

await call('/api/demo/reset', { method: 'POST' });
const travelerAuth = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ role: 'traveler', name: 'Sofia R.', email: 'sofia@example.test', password: 'secret123' }) });
const guideAuth = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ role: 'guide', name: 'Yuki Tanaka', email: 'yuki@example.test', password: 'secret123' }) });
const travelerLogin = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'sofia@example.test', password: 'secret123' }) });
assert.equal(travelerLogin.body.user.id, travelerAuth.body.user.id);
assert.equal(highestPbkdf2Iterations, 100000);
const travelerToken = travelerLogin.body.token;
const guideToken = guideAuth.body.token;

const created = await call('/api/requests', {
  method: 'POST',
  body: JSON.stringify({
    travelerName: 'Sofia R.',
    origin: 'Shibuya Station, Tokyo',
    destination: 'Meiji Shrine forest entrance',
    scheduledTime: 'Tomorrow, 10:30 AM',
    duration: '45 min',
    language: 'English',
    interests: ['Hidden corners', 'Food stops'],
  }),
}, travelerToken);
assert.equal(created.response.status, 201);
const requestId = created.body.request.id;

const pending = await call('/api/requests?status=pending', {}, guideToken);
assert.equal(pending.body.requests.length, 1);
assert.equal(pending.body.requests[0].id, requestId);

const accepted = await call(`/api/requests/${requestId}/accept`, { method: 'POST' }, guideToken);
assert.equal(accepted.body.request.status, 'accepted');
assert.ok(accepted.body.request.sessionId);

const travelerView = await call(`/api/requests/${requestId}`, {}, travelerToken);
assert.equal(travelerView.body.request.status, 'accepted');
assert.equal(travelerView.body.request.guide.name, 'Yuki Tanaka');

const sessionId = travelerView.body.request.sessionId;
const started = await call(`/api/sessions/${sessionId}/start`, { method: 'POST' }, guideToken);
assert.equal(started.body.session.status, 'live');

await call(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Please slow down near the market.' }) }, travelerToken);
const messages = await call(`/api/sessions/${sessionId}/messages`, {}, guideToken);
assert.ok(messages.body.messages.some((message) => message.text.includes('slow down')));
assert.ok(messages.body.messages.some((message) => message.senderRole === 'traveler'));

console.log('Auth API cycle verified:', { requestId, sessionId });
