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

async function raw(path, options = {}, env = {}) {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  }), env);
  return { response, body: await response.json() };
}

const deniedProdReset = await raw('/api/demo/reset', { method: 'POST' }, { HYPERDRIVE: { connectionString: 'postgres://demo.test/livewalk' }, DEMO_ADMIN_KEY: 'demo-key' });
assert.equal(deniedProdReset.response.status, 403);
assert.equal(deniedProdReset.body.ok, false);

const seeded = await raw('/api/demo/seed', { method: 'POST', headers: { 'x-demo-key': 'demo-key' } }, { DEMO_ADMIN_KEY: 'demo-key' });
assert.equal(seeded.response.status, 200);
assert.equal(seeded.body.ok, true);
assert.equal(seeded.body.demo.accounts.traveler.email, 'demo.traveler@livewalk.test');
assert.equal(seeded.body.demo.accounts.guide.email, 'demo.guide@livewalk.test');
assert.equal(seeded.body.demo.request.status, 'pending');
assert.equal(seeded.body.demo.request.travelerName, 'Sofia Ramirez');
assert.deepEqual(seeded.body.demo.request.origin, { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 });
assert.deepEqual(seeded.body.demo.request.destination, { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 });
assert.equal(seeded.body.demo.request.scheduledStart, '2026-07-10T01:30:00.000Z');
assert.equal(seeded.body.demo.request.durationMinutes, 45);
assert.equal(seeded.body.demo.request.estimate.currency, 'USD');
assert.equal(typeof seeded.body.demo.request.estimate.total, 'number');

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
    travelerName: 'Spoofed Payload Name',
    origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    scheduledStart: '2026-07-10T10:30:00+09:00',
    durationMinutes: 45,
    language: 'English',
    interests: ['Hidden corners', 'Food stops'],
  }),
}, travelerToken);
assert.equal(created.response.status, 201);
const requestId = created.body.request.id;
assert.equal(created.body.request.travelerName, 'Sofia R.');
assert.deepEqual(created.body.request.origin, { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 });
assert.deepEqual(created.body.request.destination, { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 });
assert.equal(created.body.request.route, 'Shibuya Station Hachiko Gate → Meiji Shrine forest entrance');
assert.equal(created.body.request.scheduledStart, '2026-07-10T01:30:00.000Z');
assert.equal(created.body.request.durationMinutes, 45);
assert.equal(created.body.request.estimate.guideFee, 32);
assert.equal(created.body.request.estimate.platformFee, 6);
assert.equal(created.body.request.estimate.total, 38);

const pending = await call('/api/requests?status=pending', {}, guideToken);
assert.equal(pending.body.requests.length, 1);
assert.equal(pending.body.requests[0].id, requestId);
assert.equal(pending.body.requests[0].travelerName, 'Sofia R.');

const accepted = await call(`/api/requests/${requestId}/accept`, { method: 'POST' }, guideToken);
assert.equal(accepted.body.request.status, 'accepted');
assert.equal(accepted.body.request.travelerName, 'Sofia R.');
assert.ok(accepted.body.request.sessionId);

const travelerView = await call(`/api/requests/${requestId}`, {}, travelerToken);
assert.equal(travelerView.body.request.status, 'accepted');
assert.equal(travelerView.body.request.guide.name, 'Yuki Tanaka');

const sessionId = travelerView.body.request.sessionId;
const travelerStartAttempt = await app.fetch(new Request(`https://local.test/api/sessions/${sessionId}/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${travelerToken}` },
}));
const travelerStartBody = await travelerStartAttempt.json();
assert.equal(travelerStartAttempt.status, 403);
assert.equal(travelerStartBody.ok, false);

const earlyMessageAttempt = await app.fetch(new Request(`https://local.test/api/sessions/${sessionId}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${travelerToken}` },
  body: JSON.stringify({ text: 'Trying to talk too early.' }),
}));
const earlyMessageBody = await earlyMessageAttempt.json();
assert.equal(earlyMessageAttempt.status, 400);
assert.equal(earlyMessageBody.ok, false);
assert.match(earlyMessageBody.error, /not started/i);

const started = await call(`/api/sessions/${sessionId}/start`, { method: 'POST' }, guideToken);
assert.equal(started.body.session.status, 'live');

await call(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ senderName: 'Spoofed Sender', text: 'Please slow down near the market.' }) }, travelerToken);
const messages = await call(`/api/sessions/${sessionId}/messages`, {}, guideToken);
assert.ok(messages.body.messages.some((message) => message.text.includes('slow down')));
assert.ok(messages.body.messages.some((message) => message.senderRole === 'traveler'));
assert.ok(messages.body.messages.some((message) => message.senderRole === 'traveler' && message.senderName === 'Sofia R.'));

console.log('Auth API cycle verified:', { requestId, sessionId });
