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

async function denied(path, options = {}, token = '') {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(options.headers || {}) },
  }));
  const body = await response.json();
  assert.equal(response.status, 404, `${path} unexpectedly accessible: ${JSON.stringify(body)}`);
  assert.equal(body.ok, false);
}

async function register(payload) {
  return call('/api/auth/register', { method: 'POST', body: JSON.stringify({ ...payload, password: crypto.randomUUID() }) });
}

async function createRequest(token, origin, destination) {
  return call('/api/requests', {
    method: 'POST',
    body: JSON.stringify({ origin, destination, scheduledStart: '2026-07-20T14:00:00Z', durationMinutes: 45 }),
  }, token);
}

await call('/api/demo/reset', { method: 'POST' });

const traveler = await register({ role: 'traveler', name: 'City Traveler', email: `traveler.${crypto.randomUUID()}@example.test` });
const londonGuide = await register({ role: 'guide', name: 'London Guide', city: 'lOnDoN', email: `london.${crypto.randomUUID()}@example.test` });
const torontoGuide = await register({ role: 'guide', name: 'Toronto Guide', city: 'Toronto', email: `toronto.${crypto.randomUUID()}@example.test` });

assert.equal(londonGuide.body.user.city, 'London');
assert.equal(torontoGuide.body.user.city, 'Toronto');

const london = await createRequest(traveler.body.token,
  { label: 'Trafalgar Square', lat: 51.5074, lng: -0.1278 },
  { label: 'Covent Garden', lat: 51.5117, lng: -0.124 });
const toronto = await createRequest(traveler.body.token,
  { label: 'CN Tower', lat: 43.6426, lng: -79.3871 },
  { label: 'St Lawrence Market', lat: 43.6487, lng: -79.3716 });
const other = await createRequest(traveler.body.token,
  { label: 'Shibuya Crossing', lat: 35.6595, lng: 139.7005 },
  { label: 'Meiji Shrine', lat: 35.6764, lng: 139.6993 });

assert.equal(london.body.request.city, 'London');
assert.equal(toronto.body.request.city, 'Toronto');
assert.equal(other.body.request.city, 'other');

const londonRequests = await call('/api/requests?status=pending', {}, londonGuide.body.token);
assert.deepEqual(londonRequests.body.requests.map((request) => request.id), [london.body.request.id]);
assert.equal(londonRequests.body.requests[0].city, 'London');

const torontoRequests = await call('/api/requests?status=pending', {}, torontoGuide.body.token);
assert.deepEqual(torontoRequests.body.requests.map((request) => request.id), [toronto.body.request.id]);
assert.equal(torontoRequests.body.requests[0].city, 'Toronto');

const travelerRequests = await call('/api/requests?status=pending', {}, traveler.body.token);
assert.deepEqual(new Set(travelerRequests.body.requests.map((request) => request.id)), new Set([london.body.request.id, toronto.body.request.id, other.body.request.id]));

await denied(`/api/requests/${other.body.request.id}`, {}, londonGuide.body.token);
await denied(`/api/requests/${other.body.request.id}`, {}, torontoGuide.body.token);
await denied(`/api/requests/${toronto.body.request.id}/accept`, { method: 'POST' }, londonGuide.body.token);

console.log('City scoping verified:', { londonRequest: london.body.request.id, torontoRequest: toronto.body.request.id, otherRequest: other.body.request.id });
