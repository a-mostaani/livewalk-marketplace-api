import assert from 'node:assert/strict';
import app from '../src/index.js';

async function call(path, options = {}) {
  const response = await app.fetch(new Request(`https://local.test${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  }));
  const body = await response.json();
  assert.equal(body.ok, true, `${path} failed: ${JSON.stringify(body)}`);
  return { response, body };
}

await call('/api/demo/reset', { method: 'POST' });
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
});
assert.equal(created.response.status, 201);
const requestId = created.body.request.id;

const pending = await call('/api/requests?status=pending');
assert.equal(pending.body.requests.length, 1);
assert.equal(pending.body.requests[0].id, requestId);

const accepted = await call(`/api/requests/${requestId}/accept`, {
  method: 'POST',
  body: JSON.stringify({ guideId: 'guide_yuki', guideName: 'Yuki Tanaka' }),
});
assert.equal(accepted.body.request.status, 'accepted');
assert.ok(accepted.body.request.sessionId);

const travelerView = await call(`/api/requests/${requestId}`);
assert.equal(travelerView.body.request.status, 'accepted');
assert.equal(travelerView.body.request.guide.name, 'Yuki Tanaka');

const sessionId = travelerView.body.request.sessionId;
const started = await call(`/api/sessions/${sessionId}/start`, { method: 'POST' });
assert.equal(started.body.session.status, 'live');

await call(`/api/sessions/${sessionId}/messages`, {
  method: 'POST',
  body: JSON.stringify({ senderRole: 'traveler', senderName: 'Sofia', text: 'Please slow down near the market.' }),
});
const messages = await call(`/api/sessions/${sessionId}/messages`);
assert.ok(messages.body.messages.some((message) => message.text.includes('slow down')));

console.log('API cycle verified:', { requestId, sessionId });
