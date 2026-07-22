import assert from 'node:assert/strict';
import app from '../src/index.js';

const livekitEnv = { LIVEKIT_API_KEY: 'lk_test_key', LIVEKIT_API_SECRET: 'lk_test_secret_at_least_32_bytes_long' };

async function call(path, options = {}, token = '', env = livekitEnv) {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  }), env);
  const body = await response.json();
  assert.equal(body.ok, true, `${path} failed: ${JSON.stringify(body)}`);
  return { response, body };
}

async function raw(path, options = {}, token = '', env = livekitEnv) {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  }), env);
  return { response, body: await response.json() };
}

async function register(payload) {
  return call('/api/auth/register', { method: 'POST', body: JSON.stringify({ ...payload, password: crypto.randomUUID() }) });
}

function decodeLivekitToken(token) {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

await call('/api/demo/reset', { method: 'POST' });

const traveler = await register({ role: 'traveler', name: 'Token Traveler', email: `token-traveler-${crypto.randomUUID()}@example.test` });
const guide = await register({ role: 'guide', name: 'Token Guide', city: 'London', email: `token-guide-${crypto.randomUUID()}@example.test` });
const otherGuide = await register({ role: 'guide', name: 'Other Guide', city: 'London', email: `token-other-guide-${crypto.randomUUID()}@example.test` });
const otherTraveler = await register({ role: 'traveler', name: 'Other Traveler', email: `token-other-traveler-${crypto.randomUUID()}@example.test` });

const created = await call('/api/requests', {
  method: 'POST',
  body: JSON.stringify({
    origin: { label: 'Trafalgar Square', lat: 51.507432, lng: -0.127812 },
    destination: { label: 'Covent Garden', lat: 51.511743, lng: -0.123976 },
    scheduledStart: '2026-07-22T14:00:00Z',
    durationMinutes: 45,
  }),
}, traveler.body.token);

const accepted = await call(`/api/requests/${created.body.request.id}/accept`, { method: 'POST' }, guide.body.token);
const sessionId = accepted.body.session.id;
assert.equal(accepted.body.session.status, 'ready');

// LiveKit not configured
const unconfigured = await raw(`/api/sessions/${sessionId}/livekit-token`, { method: 'POST' }, guide.body.token, {});
assert.equal(unconfigured.response.status, 400);
assert.equal(unconfigured.body.ok, false);
assert.match(unconfigured.body.error, /not configured/i);

// Session not live yet
const tooEarly = await raw(`/api/sessions/${sessionId}/livekit-token`, { method: 'POST' }, guide.body.token);
assert.equal(tooEarly.response.status, 400);
assert.equal(tooEarly.body.ok, false);
assert.match(tooEarly.body.error, /not started/i);

// Neither an unrelated guide nor an unrelated traveler can mint for a session they're not part of
const unrelatedGuideAttempt = await raw(`/api/sessions/${sessionId}/livekit-token`, { method: 'POST' }, otherGuide.body.token);
assert.equal(unrelatedGuideAttempt.response.status, 403);
assert.equal(unrelatedGuideAttempt.body.ok, false);

const unrelatedTravelerAttempt = await raw(`/api/sessions/${sessionId}/livekit-token`, { method: 'POST' }, otherTraveler.body.token);
assert.equal(unrelatedTravelerAttempt.response.status, 403);
assert.equal(unrelatedTravelerAttempt.body.ok, false);

await call(`/api/sessions/${sessionId}/start`, { method: 'POST' }, guide.body.token);

// Guide mints a publish-capable token
const guideToken = await call(`/api/sessions/${sessionId}/livekit-token`, { method: 'POST' }, guide.body.token);
assert.equal(guideToken.body.room, sessionId);
assert.equal(guideToken.body.identity, guide.body.user.id);
assert.equal(guideToken.body.canPublish, true);
assert.equal(guideToken.body.expiresIn, 600);
const guidePayload = decodeLivekitToken(guideToken.body.token);
assert.equal(guidePayload.iss, livekitEnv.LIVEKIT_API_KEY);
assert.equal(guidePayload.sub, guide.body.user.id);
assert.equal(guidePayload.video.room, sessionId);
assert.equal(guidePayload.video.roomJoin, true);
assert.equal(guidePayload.video.canPublish, true);
assert.equal(guidePayload.video.canSubscribe, true);
assert.deepEqual(guidePayload.video.canPublishSources, ['camera', 'microphone']);
assert.equal(guidePayload.exp - guidePayload.nbf, 610);

// Traveler mints a subscribe-only token for the same room
const travelerToken = await call(`/api/sessions/${sessionId}/livekit-token`, { method: 'POST' }, traveler.body.token);
assert.equal(travelerToken.body.room, sessionId);
assert.equal(travelerToken.body.identity, traveler.body.user.id);
assert.equal(travelerToken.body.canPublish, false);
const travelerPayload = decodeLivekitToken(travelerToken.body.token);
assert.equal(travelerPayload.sub, traveler.body.user.id);
assert.equal(travelerPayload.video.room, sessionId);
assert.equal(travelerPayload.video.canPublish, false);
assert.equal(travelerPayload.video.canSubscribe, true);
assert.equal(travelerPayload.video.canPublishSources, undefined);

// Cancelled session/request rejects minting with the shared conflict shape
const cancellable = await call('/api/requests', {
  method: 'POST',
  body: JSON.stringify({
    origin: { label: 'Trafalgar Square', lat: 51.507432, lng: -0.127812 },
    destination: { label: 'Covent Garden', lat: 51.511743, lng: -0.123976 },
    scheduledStart: '2026-07-23T14:00:00Z',
    durationMinutes: 45,
  }),
}, traveler.body.token);
const cancelledAccepted = await call(`/api/requests/${cancellable.body.request.id}/accept`, { method: 'POST' }, guide.body.token);
const cancelledSessionId = cancelledAccepted.body.session.id;
await call(`/api/requests/${cancellable.body.request.id}/cancel`, { method: 'POST' }, traveler.body.token);

const cancelledAttempt = await raw(`/api/sessions/${cancelledSessionId}/livekit-token`, { method: 'POST' }, guide.body.token);
assert.equal(cancelledAttempt.response.status, 409);
assert.deepEqual(cancelledAttempt.body, {
  ok: false,
  error: 'Traveler cancelled this walk. No session can start.',
  code: 'request_cancelled',
});

console.log('LiveKit token minting verified:', { sessionId, guide: guide.body.user.id, traveler: traveler.body.user.id });
