import assert from 'node:assert/strict';
import app from '../src/index.js';

async function call(path, options = {}, token = '') {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  }));
  const body = await response.json();
  assert.equal(body.ok, true, `${path} failed: ${JSON.stringify(body)}`);
  return { response, body };
}

async function register(payload) {
  return call('/api/auth/register', { method: 'POST', body: JSON.stringify({ ...payload, password: crypto.randomUUID() }) });
}

await call('/api/demo/reset', { method: 'POST' });

const traveler = await register({ role: 'traveler', name: 'Sofia Ramirez', email: `privacy-traveler-${crypto.randomUUID()}@example.test` });
const guide = await register({ role: 'guide', name: 'Assigned Guide', city: 'London', email: `privacy-guide-${crypto.randomUUID()}@example.test` });
const otherGuide = await register({ role: 'guide', name: 'Other Guide', city: 'London', email: `privacy-other-guide-${crypto.randomUUID()}@example.test` });

const origin = { label: 'Trafalgar Square', lat: 51.507432, lng: -0.127812 };
const destination = { label: 'Covent Garden', lat: 51.511743, lng: -0.123976 };
const created = await call('/api/requests', {
  method: 'POST',
  body: JSON.stringify({ origin, destination, scheduledStart: '2026-07-22T14:00:00Z', durationMinutes: 45 }),
}, traveler.body.token);

assert.equal(created.body.request.travelerName, 'Sofia Ramirez');
assert.deepEqual(created.body.request.origin, origin);
assert.deepEqual(created.body.request.destination, destination);

const requestId = created.body.request.id;
const guideList = await call('/api/requests?status=pending', {}, guide.body.token);
const guideGet = await call(`/api/requests/${requestId}`, {}, guide.body.token);
const otherGuideGet = await call(`/api/requests/${requestId}`, {}, otherGuide.body.token);

for (const request of [guideList.body.requests[0], guideGet.body.request, otherGuideGet.body.request]) {
  assert.equal(request.travelerName, 'Sofia R.');
  assert.deepEqual(request.origin, { ...origin, lat: 51.51, lng: -0.13 });
  assert.deepEqual(request.destination, { ...destination, lat: 51.51, lng: -0.12 });
}

const accepted = await call(`/api/requests/${requestId}/accept`, { method: 'POST' }, guide.body.token);
assert.equal(accepted.body.request.travelerName, 'Sofia Ramirez');
assert.deepEqual(accepted.body.request.origin, origin);
assert.deepEqual(accepted.body.request.destination, destination);

const assignedGet = await call(`/api/requests/${requestId}`, {}, guide.body.token);
assert.equal(assignedGet.body.request.travelerName, 'Sofia Ramirez');
assert.deepEqual(assignedGet.body.request.origin, origin);
assert.deepEqual(assignedGet.body.request.destination, destination);

const travelerGet = await call(`/api/requests/${requestId}`, {}, traveler.body.token);
assert.equal(travelerGet.body.request.travelerName, 'Sofia Ramirez');
assert.deepEqual(travelerGet.body.request.origin, origin);
assert.deepEqual(travelerGet.body.request.destination, destination);

console.log('Privacy shaping verified:', { requestId, assignedGuide: guide.body.user.id, otherGuide: otherGuide.body.user.id });
