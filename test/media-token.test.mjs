import assert from 'node:assert/strict';
import app from '../src/index.js';

const livekitEnv = {
  LIVEKIT_API_KEY: 'test_public_key',
  LIVEKIT_API_SECRET: 'test_secret_that_must_never_leak_123456',
  LIVEKIT_URL: 'wss://livewalk-test.livekit.cloud',
};

async function request(path, options = {}, token = '', env = livekitEnv) {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }), env);
  return { response, body: await response.json() };
}

async function ok(path, options = {}, token = '', env = livekitEnv) {
  const result = await request(path, options, token, env);
  assert.ok(result.response.ok, `${path} failed: ${JSON.stringify(result.body)}`);
  return result;
}

async function register(role, name, city) {
  return ok('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      role,
      name,
      city,
      email: `${role}-${crypto.randomUUID()}@example.test`,
      password: crypto.randomUUID(),
    }),
  });
}

function decodeToken(token) {
  const [headerPart, payloadPart] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')),
  };
}

async function verifySignature(token, secret) {
  const [header, payload, signature] = token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`));
}

await ok('/api/demo/reset', { method: 'POST' });

const traveler = await register('traveler', 'Token Traveler');
const guide = await register('guide', 'Token Guide', 'London');
const unrelated = await register('traveler', 'Unrelated Traveler');
const created = await ok('/api/requests', {
  method: 'POST',
  body: JSON.stringify({
    origin: { label: 'Trafalgar Square', lat: 51.507432, lng: -0.127812 },
    destination: { label: 'Covent Garden', lat: 51.511743, lng: -0.123976 },
    scheduledStart: '2026-07-22T14:00:00Z',
    durationMinutes: 45,
  }),
}, traveler.body.token);
const accepted = await ok(`/api/requests/${created.body.request.id}/accept`, { method: 'POST' }, guide.body.token);
const sessionId = accepted.body.session.id;
const endpoint = `/api/sessions/${sessionId}/media-token`;

const unauthenticated = await request(endpoint, { method: 'POST' });
assert.equal(unauthenticated.response.status, 401);

const missingSession = await request('/api/sessions/sess_missing/media-token', { method: 'POST' }, traveler.body.token, {});
assert.equal(missingSession.response.status, 404);

const denied = await request(endpoint, { method: 'POST' }, unrelated.body.token);
assert.equal(denied.response.status, 403);

const missingConfiguration = await request(endpoint, { method: 'POST' }, guide.body.token, {});
assert.equal(missingConfiguration.response.status, 503);
assert.deepEqual(missingConfiguration.body, { ok: false, error: 'Service unavailable' });
assert.doesNotMatch(JSON.stringify(missingConfiguration.body), /LIVEKIT|secret|key/i);

const guideResult = await ok(endpoint, { method: 'POST' }, guide.body.token);
assert.deepEqual(Object.keys(guideResult.body).sort(), ['role', 'room', 'token', 'wsUrl']);
assert.equal(guideResult.body.role, 'guide');
assert.equal(guideResult.body.wsUrl, livekitEnv.LIVEKIT_URL);
assert.equal(guideResult.body.room, `livewalk-session-${sessionId}`);
assert.equal(await verifySignature(guideResult.body.token, livekitEnv.LIVEKIT_API_SECRET), true);
assert.doesNotMatch(JSON.stringify(guideResult.body), new RegExp(livekitEnv.LIVEKIT_API_SECRET));

const guideJwt = decodeToken(guideResult.body.token);
assert.deepEqual(guideJwt.header, { alg: 'HS256', typ: 'JWT' });
assert.equal(guideJwt.payload.iss, livekitEnv.LIVEKIT_API_KEY);
assert.equal(guideJwt.payload.sub, guide.body.user.id);
assert.equal(guideJwt.payload.exp - guideJwt.payload.iat, 600);
assert.equal(guideJwt.payload.nbf, guideJwt.payload.iat - 10);
assert.equal(guideJwt.payload.video.room, guideResult.body.room);
assert.equal(guideJwt.payload.video.roomJoin, true);
assert.equal(guideJwt.payload.video.canPublish, true);
assert.equal(guideJwt.payload.video.canSubscribe, true);
assert.deepEqual(guideJwt.payload.video.canPublishSources, ['camera', 'microphone']);
assert.deepEqual(JSON.parse(guideJwt.payload.metadata), { sessionId, role: 'guide' });

const travelerResult = await ok(endpoint, { method: 'POST' }, traveler.body.token);
assert.deepEqual(Object.keys(travelerResult.body).sort(), ['role', 'room', 'token', 'wsUrl']);
assert.equal(travelerResult.body.role, 'traveler');
assert.equal(travelerResult.body.room, guideResult.body.room);
assert.equal(travelerResult.body.wsUrl, livekitEnv.LIVEKIT_URL);
assert.equal(await verifySignature(travelerResult.body.token, livekitEnv.LIVEKIT_API_SECRET), true);

const travelerJwt = decodeToken(travelerResult.body.token);
assert.equal(travelerJwt.payload.sub, traveler.body.user.id);
assert.equal(travelerJwt.payload.video.room, guideJwt.payload.video.room);
assert.equal(travelerJwt.payload.video.canPublish, true);
assert.equal(travelerJwt.payload.video.canSubscribe, true);
assert.deepEqual(travelerJwt.payload.video.canPublishSources, ['microphone']);
assert.equal(travelerJwt.payload.video.canPublishSources.includes('camera'), false);
assert.deepEqual(JSON.parse(travelerJwt.payload.metadata), { sessionId, role: 'traveler' });

console.log('Session-scoped media token permissions verified:', {
  sessionId,
  room: travelerResult.body.room,
  expirySeconds: travelerJwt.payload.exp - travelerJwt.payload.iat,
});
