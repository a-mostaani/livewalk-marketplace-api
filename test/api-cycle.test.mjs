import assert from 'node:assert/strict';
import app from '../src/index.js';
import { rowToRequest } from '../src/store.js';

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

const demoSeedPassword = crypto.randomUUID();
const demoAdminKey = crypto.randomUUID();
const productionDemoEnv = {
  HYPERDRIVE: { connectionString: 'postgres://demo.test/livewalk' },
  DEMO_ADMIN_KEY: demoAdminKey,
  DEMO_SEED_PASSWORD: demoSeedPassword,
};

const deniedProdReset = await raw('/api/demo/reset', { method: 'POST', headers: { 'x-demo-key': demoAdminKey } }, productionDemoEnv);
assert.equal(deniedProdReset.response.status, 403);
assert.equal(deniedProdReset.body.ok, false);

const deniedProdSeed = await raw('/api/demo/seed', { method: 'POST', headers: { 'x-demo-key': demoAdminKey } }, productionDemoEnv);
assert.equal(deniedProdSeed.response.status, 403);
assert.equal(deniedProdSeed.body.ok, false);

const unconfiguredSeed = await raw('/api/demo/seed', { method: 'POST' });
assert.equal(unconfiguredSeed.response.status, 400);
assert.equal(unconfiguredSeed.body.ok, false);
assert.match(unconfiguredSeed.body.error, /not configured/i);

const seeded = await raw('/api/demo/seed', { method: 'POST' }, { DEMO_SEED_PASSWORD: demoSeedPassword });
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

const seededLogin = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo.traveler@livewalk.test', password: demoSeedPassword }) });
assert.equal(seededLogin.body.user.email, 'demo.traveler@livewalk.test');

await call('/api/demo/reset', { method: 'POST' });
const travelerPassword = crypto.randomUUID();
const declineGuidePassword = crypto.randomUUID();
const guidePassword = crypto.randomUUID();
const travelerAuth = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ role: 'traveler', name: 'Sofia R.', email: 'sofia@example.test', password: travelerPassword }) });
const declineGuideAuth = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ role: 'guide', name: 'Guide A', email: 'guide.a@example.test', password: declineGuidePassword }) });
const guideAuth = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ role: 'guide', name: 'Yuki Tanaka', email: 'yuki@example.test', password: guidePassword }) });
const travelerLogin = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'sofia@example.test', password: travelerPassword }) });
assert.equal(travelerLogin.body.user.id, travelerAuth.body.user.id);
assert.equal(highestPbkdf2Iterations, 100000);
assert.match(travelerAuth.body.user.id, /^usr_[0-9a-f]{32}$/);
assert.match(declineGuideAuth.body.user.id, /^usr_[0-9a-f]{32}$/);
assert.match(guideAuth.body.user.id, /^usr_[0-9a-f]{32}$/);
const travelerToken = travelerLogin.body.token;
const declineGuideToken = declineGuideAuth.body.token;
const guideToken = guideAuth.body.token;

const beforeEstimate = await call('/api/requests', {}, travelerToken);
assert.equal(beforeEstimate.body.requests.length, 0);

const firstQuote = await call('/api/requests/estimate', {
  method: 'POST',
  body: JSON.stringify({
    origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    scheduledStart: '2026-07-10T10:30:00+09:00',
    durationMinutes: 45,
  }),
}, travelerToken);
assert.equal(firstQuote.response.status, 200);
assert.equal(firstQuote.body.estimate.total, 38);
assert.equal(firstQuote.body.estimate.distanceKm, 1.9);

const secondQuote = await call('/api/requests/estimate', {
  method: 'POST',
  body: JSON.stringify({
    origin: { label: 'Tokyo Station', lat: 35.6812, lng: 139.7671 },
    destination: { label: 'Senso-ji Temple', lat: 35.7148, lng: 139.7967 },
    scheduledStart: '2026-07-10T10:30:00+09:00',
    durationMinutes: 45,
  }),
}, travelerToken);
assert.ok(secondQuote.body.estimate.distanceKm > firstQuote.body.estimate.distanceKm);
assert.ok(secondQuote.body.estimate.walkingMinutes > firstQuote.body.estimate.walkingMinutes);

const afterEstimate = await call('/api/requests', {}, travelerToken);
assert.equal(afterEstimate.body.requests.length, 0);

const missingScheduledStart = await app.fetch(new Request('https://local.test/api/requests/estimate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${travelerToken}` },
  body: JSON.stringify({
    origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    durationMinutes: 45,
  }),
}));
const missingScheduledStartBody = await missingScheduledStart.json();
assert.equal(missingScheduledStart.status, 400);
assert.match(missingScheduledStartBody.error, /scheduledStart.*ISO-8601/i);

const invalidScheduledStart = await app.fetch(new Request('https://local.test/api/requests/estimate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${travelerToken}` },
  body: JSON.stringify({
    origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    scheduledStart: 'tomorrow afternoon',
    durationMinutes: 45,
  }),
}));
const invalidScheduledStartBody = await invalidScheduledStart.json();
assert.equal(invalidScheduledStart.status, 400);
assert.match(invalidScheduledStartBody.error, /scheduledStart.*ISO-8601/i);

const missingDuration = await app.fetch(new Request('https://local.test/api/requests/estimate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${travelerToken}` },
  body: JSON.stringify({
    origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    scheduledStart: '2026-07-10T10:30:00+09:00',
  }),
}));
const missingDurationBody = await missingDuration.json();
assert.equal(missingDuration.status, 400);
assert.match(missingDurationBody.error, /durationMinutes is required/i);

const invalidQuote = await app.fetch(new Request('https://local.test/api/requests/estimate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${travelerToken}` },
  body: JSON.stringify({
    origin: { label: 'No coordinates' },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    durationMinutes: 45,
  }),
}));
const invalidQuoteBody = await invalidQuote.json();
assert.equal(invalidQuote.status, 400);
assert.equal(invalidQuoteBody.ok, false);
assert.match(invalidQuoteBody.error, /numeric latitude/i);

const guideEstimateAttempt = await app.fetch(new Request('https://local.test/api/requests/estimate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${guideToken}` },
  body: JSON.stringify({
    origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    durationMinutes: 45,
  }),
}));
assert.equal(guideEstimateAttempt.status, 403);

const created = await call('/api/requests', {
  method: 'POST',
  body: JSON.stringify({
    travelerName: 'Spoofed Payload Name',
    origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    scheduledStart: '2026-07-10T10:30:00+09:00',
    durationMinutes: 45,
    estimate: { currency: 'USD', distanceKm: 0, walkingMinutes: 0, guideFee: 0, platformFee: 0, total: 1 },
    language: 'English',
    interests: ['Hidden corners', 'Food stops'],
  }),
}, travelerToken);
assert.equal(created.response.status, 201);
const requestId = created.body.request.id;
assert.match(requestId, /^req_[0-9a-f]{32}$/);
assert.equal(created.body.request.travelerName, 'Sofia R.');
assert.deepEqual(created.body.request.origin, { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 });
assert.deepEqual(created.body.request.destination, { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 });
assert.equal(created.body.request.route, 'Shibuya Station Hachiko Gate → Meiji Shrine forest entrance');
assert.equal(created.body.request.scheduledStart, '2026-07-10T01:30:00.000Z');
assert.equal(created.body.request.durationMinutes, 45);
assert.equal(created.body.request.estimate.guideFee, 32);
assert.equal(created.body.request.estimate.platformFee, 6);
assert.equal(created.body.request.estimate.total, 38);
assert.deepEqual(created.body.request.estimate, firstQuote.body.estimate);

const pendingForDecliningGuide = await call('/api/requests?status=pending', {}, declineGuideToken);
assert.equal(pendingForDecliningGuide.body.requests.length, 1);
assert.equal(pendingForDecliningGuide.body.requests[0].id, requestId);

const declined = await call(`/api/requests/${requestId}/decline`, { method: 'POST' }, declineGuideToken);
assert.equal(declined.response.status, 200);
assert.equal(declined.body.request.status, 'pending');
assert.equal(declined.body.request.guide, null);
assert.equal(globalThis.__LIVEWALK_STATE__.requests.get(requestId).guideId, null);
assert.equal(globalThis.__LIVEWALK_STATE__.requests.get(requestId).status, 'pending');

const hiddenFromDecliningGuide = await call('/api/requests?status=pending', {}, declineGuideToken);
assert.equal(hiddenFromDecliningGuide.body.requests.length, 0);

const pending = await call('/api/requests?status=pending', {}, guideToken);
assert.equal(pending.body.requests.length, 1);
assert.equal(pending.body.requests[0].id, requestId);
assert.equal(pending.body.requests[0].travelerName, 'Sofia R.');

const accepted = await call(`/api/requests/${requestId}/accept`, { method: 'POST' }, guideToken);
assert.equal(accepted.body.request.status, 'accepted');
assert.equal(accepted.body.request.travelerName, 'Sofia R.');
assert.ok(accepted.body.request.sessionId);

const declinedAccepted = await app.fetch(new Request(`https://local.test/api/requests/${requestId}/decline`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${declineGuideToken}` },
}));
const declinedAcceptedBody = await declinedAccepted.json();
assert.equal(declinedAccepted.status, 409);
assert.equal(declinedAcceptedBody.ok, false);
assert.match(declinedAcceptedBody.error, /only pending/i);

const travelerView = await call(`/api/requests/${requestId}`, {}, travelerToken);
assert.equal(travelerView.body.request.status, 'accepted');
assert.equal(travelerView.body.request.guide.name, 'Yuki Tanaka');
assert.equal(travelerView.body.request.sessionId, accepted.body.request.sessionId);

const sessionId = travelerView.body.request.sessionId;
assert.match(sessionId, /^sess_[0-9a-f]{32}$/);
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

const invalidLocationAttempt = await app.fetch(new Request(`https://local.test/api/sessions/${sessionId}/location`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${guideToken}` },
  body: JSON.stringify({ label: 'Current guide location' }),
}));
const invalidLocationBody = await invalidLocationAttempt.json();
assert.equal(invalidLocationAttempt.status, 400);
assert.equal(invalidLocationBody.ok, false);
assert.match(invalidLocationBody.error, /valid numeric latitude and longitude/i);

const savedLocation = await call(`/api/sessions/${sessionId}/location`, {
  method: 'POST',
  body: JSON.stringify({ label: 'Current guide location', lat: 40.7128, lng: -74.006, progress: 52 }),
}, guideToken);
assert.deepEqual(savedLocation.body.session.location, {
  label: 'Current guide location',
  lat: 40.7128,
  lng: -74.006,
  progress: 52,
  updatedAt: savedLocation.body.session.location.updatedAt,
});

await call(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ senderName: 'Spoofed Sender', text: 'Please slow down near the market.' }) }, travelerToken);
const messages = await call(`/api/sessions/${sessionId}/messages`, {}, guideToken);
assert.ok(messages.body.messages.some((message) => message.text.includes('slow down')));
assert.ok(messages.body.messages.some((message) => message.senderRole === 'traveler'));
assert.ok(messages.body.messages.some((message) => message.senderRole === 'traveler' && message.senderName === 'Sofia R.'));

const ended = await call(`/api/sessions/${sessionId}/end`, { method: 'POST' }, guideToken);
assert.equal(ended.body.session.status, 'ended');
assert.ok(ended.body.session.endedAt);
assert.ok(ended.body.messages.some((message) => message.senderRole === 'system' && message.text === 'The live walk session ended.'));
const endedRequest = await call(`/api/requests/${requestId}`, {}, travelerToken);
assert.equal(endedRequest.body.request.status, 'completed');

const endMessageCount = ended.body.messages.filter((message) => message.text === 'The live walk session ended.').length;
const endedAgain = await call(`/api/sessions/${sessionId}/end`, { method: 'POST' }, travelerToken);
assert.equal(endedAgain.response.status, 200);
assert.equal(endedAgain.body.session.status, 'ended');
assert.equal(endedAgain.body.session.endedAt, ended.body.session.endedAt);
assert.equal(endedAgain.body.messages.filter((message) => message.text === 'The live walk session ended.').length, endMessageCount);

const cancellable = await call('/api/requests', {
  method: 'POST',
  body: JSON.stringify({
    origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
    destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
    scheduledStart: '2026-07-10T11:30:00+09:00',
    durationMinutes: 45,
    language: 'English',
    interests: ['Hidden corners'],
  }),
}, travelerToken);
const cancelledRequestId = cancellable.body.request.id;
const cancellationAccepted = await call(`/api/requests/${cancelledRequestId}/accept`, { method: 'POST' }, guideToken);
const cancelledSessionId = cancellationAccepted.body.session.id;
assert.equal(cancellationAccepted.body.request.status, 'accepted');
assert.equal(cancellationAccepted.body.session.status, 'ready');

const travellerCancellation = await call(`/api/requests/${cancelledRequestId}/cancel`, { method: 'POST' }, travelerToken);
assert.equal(travellerCancellation.body.request.status, 'cancelled');
assert.equal(travellerCancellation.body.session.status, 'cancelled');

const guideCancelledPoll = await call(`/api/sessions/${cancelledSessionId}/status`, {}, guideToken);
assert.equal(guideCancelledPoll.body.request.status, 'cancelled');
assert.equal(guideCancelledPoll.body.session.status, 'cancelled');

const guideStartCancelled = await raw(`/api/sessions/${cancelledSessionId}/start`, {
  method: 'POST',
  headers: { authorization: `Bearer ${guideToken}` },
});
assert.equal(guideStartCancelled.response.status, 409);
assert.deepEqual(guideStartCancelled.body, {
  ok: false,
  error: 'Traveler cancelled this walk. No session can start.',
  code: 'request_cancelled',
});

const readableLegacyRow = {
  id: 'req_legacy',
  traveler_id: 'usr_legacy',
  traveler_name: 'Legacy traveler',
  origin_point: { label: 'Stored origin', lat: 40.7, lng: -74 },
  destination_point: { label: 'Stored destination', lat: 40.8, lng: -73.9 },
  scheduled_start: '2026-07-10T10:30:00Z',
  duration_minutes: 45,
  language: 'English',
  status: 'pending',
  created_at: '2026-07-10T10:00:00Z',
  updated_at: '2026-07-10T10:00:00Z',
};
assert.equal(rowToRequest(readableLegacyRow).id, 'req_legacy');
assert.equal(rowToRequest({ ...readableLegacyRow, origin_point: { label: 'Broken origin', lat: 'not-a-number', lng: -74 } }), null);

const backendLogs = [];
const originalConsoleError = console.error;
console.error = (...args) => backendLogs.push(args);
try {
  const ordinaryRequest = new Request('https://local.test/api/private');
  const failingRequest = new Proxy(ordinaryRequest, {
    get(target, property) {
      if (property === 'headers') return { get() { throw new Error('intentional backend test failure'); } };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const backendFailure = await app.fetch(failingRequest);
  const backendFailureBody = await backendFailure.json();
  assert.equal(backendFailure.status, 500);
  assert.deepEqual({ ok: backendFailureBody.ok, error: backendFailureBody.error }, { ok: false, error: 'Backend error' });
  assert.match(backendFailureBody.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(backendFailureBody), /intentional backend test failure/);
  assert.equal(backendLogs.length, 1);
  assert.equal(backendLogs[0][0], 'LiveWalk backend error');
  assert.equal(backendLogs[0][1].correlationId, backendFailureBody.correlationId);
  assert.match(backendLogs[0][1].detail.message, /intentional backend test failure/);
} finally {
  console.error = originalConsoleError;
}

console.log('Auth API cycle verified:', { requestId, sessionId });
