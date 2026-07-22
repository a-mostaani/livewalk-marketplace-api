import assert from 'node:assert/strict';
import app from '../src/index.js';

async function call(path, options = {}, token = '') {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }));
  const body = await response.json();
  assert.equal(body.ok, true, `${path} failed: ${JSON.stringify(body)}`);
  return { response, body };
}

const travelerPassword = crypto.randomUUID();
const guidePassword = crypto.randomUUID();

await call('/api/demo/reset', { method: 'POST' });

const traveler = await call('/api/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    role: 'traveler',
    name: 'Propagation Traveler',
    email: `propagation-traveler-${crypto.randomUUID()}@example.test`,
    password: travelerPassword,
  }),
});
const guide = await call('/api/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    role: 'guide',
    name: 'Propagation Guide',
    city: 'other',
    email: `propagation-guide-${crypto.randomUUID()}@example.test`,
    password: guidePassword,
  }),
});

const travelerLogin = await call('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: traveler.body.user.email, password: travelerPassword }),
});
const guideLogin = await call('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: guide.body.user.email, password: guidePassword, city: 'London' }),
});

assert.equal(travelerLogin.body.user.role, 'traveler');
assert.equal(guideLogin.body.user.role, 'guide');
assert.equal(guideLogin.body.user.city, 'London');

const created = await call('/api/requests', {
  method: 'POST',
  body: JSON.stringify({
    origin: { label: 'Trafalgar Square', lat: 51.5074, lng: -0.1278 },
    destination: { label: 'Covent Garden', lat: 51.5117, lng: -0.124 },
    scheduledStart: '2026-07-24T14:00:00Z',
    durationMinutes: 45,
    language: 'English',
    interests: ['Architecture'],
  }),
}, travelerLogin.body.token);
const requestId = created.body.request.id;

const guidePending = await call('/api/requests?status=pending', {}, guideLogin.body.token);
assert.deepEqual(guidePending.body.requests.map((request) => request.id), [requestId]);
assert.equal(guidePending.body.requests[0].status, 'pending');

const accepted = await call(`/api/requests/${requestId}/accept`, { method: 'POST' }, guideLogin.body.token);
assert.equal(accepted.body.request.status, 'accepted');
assert.ok(accepted.body.session?.id);

const travelerRead = await call(`/api/requests/${requestId}`, {}, travelerLogin.body.token);
assert.equal(travelerRead.body.request.status, 'accepted');
assert.equal(travelerRead.body.request.sessionId, accepted.body.session.id);
assert.equal(travelerRead.body.request.guide?.id, guideLogin.body.user.id);

console.log('Request visibility and acceptance propagation verified:', { requestId, guidePendingCount: guidePending.body.requests.length, travelerStatus: travelerRead.body.request.status });
