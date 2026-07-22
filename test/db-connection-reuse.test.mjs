import assert from 'node:assert/strict';
import { makeDbStore } from '../src/store.js';

const createdAt = '2026-07-22T10:00:00.000Z';
const traveler = { id: 'usr_traveler', role: 'traveler', name: 'Test Traveler', city: 'other' };
const guide = { id: 'usr_guide', role: 'guide', name: 'Test Guide', city: 'London' };

function createFixture() {
  const state = {
    request: {
      id: 'req_lw28',
      traveler_id: traveler.id,
      guide_id: null,
      traveler_name: traveler.name,
      traveler_display_name: traveler.name,
      city: 'London',
      origin: 'Trafalgar Square',
      destination: 'Covent Garden',
      scheduled_time: '2026-07-23T14:00:00.000Z',
      duration: '45 min',
      origin_point: { label: 'Trafalgar Square', lat: 51.5074, lng: -0.1278 },
      destination_point: { label: 'Covent Garden', lat: 51.5117, lng: -0.124 },
      scheduled_start: '2026-07-23T14:00:00.000Z',
      duration_minutes: 45,
      estimate: { currency: 'USD', total: 38 },
      language: 'English',
      interests: ['Architecture'],
      status: 'pending',
      guide: null,
      session_id: null,
      created_at: createdAt,
      updated_at: createdAt,
    },
    session: null,
    messages: [],
  };

  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [] };

      if (statement.includes('FROM livewalk_requests') && statement.includes('WHERE r.id=$1')) {
        return { rows: state.request.id === params[0] ? [{ ...state.request }] : [] };
      }
      if (statement === 'SELECT * FROM livewalk_requests WHERE id=$1 FOR UPDATE') {
        return { rows: state.request.id === params[0] ? [{ ...state.request }] : [] };
      }
      if (statement === 'SELECT * FROM livewalk_sessions WHERE id=$1' || statement === 'SELECT * FROM livewalk_sessions WHERE id=$1 FOR UPDATE') {
        return { rows: state.session?.id === params[0] ? [{ ...state.session }] : [] };
      }
      if (statement === 'SELECT * FROM livewalk_messages WHERE session_id=$1 ORDER BY created_at ASC') {
        return { rows: state.messages.filter((message) => message.session_id === params[0]).map((message) => ({ ...message })) };
      }
      if (statement.startsWith('UPDATE livewalk_requests SET status=$1, guide_id=$2')) {
        const [status, guideId, guideJson, sessionId, updatedAt, requestId] = params;
        assert.equal(requestId, state.request.id);
        Object.assign(state.request, { status, guide_id: guideId, guide: JSON.parse(guideJson), session_id: sessionId, updated_at: updatedAt });
        return { rows: [] };
      }
      if (statement.startsWith('INSERT INTO livewalk_sessions')) {
        const [sessionId, requestId, timestamp] = params;
        state.session ??= { id: sessionId, request_id: requestId, status: 'ready', started_at: null, ended_at: null, location: null, created_at: timestamp, updated_at: timestamp };
        return { rows: [] };
      }
      if (statement.startsWith('UPDATE livewalk_sessions SET status=$1, started_at=COALESCE')) {
        const [status, timestamp, sessionId] = params;
        assert.equal(sessionId, state.session.id);
        Object.assign(state.session, { status, started_at: state.session.started_at ?? timestamp, updated_at: timestamp });
        return { rows: [] };
      }
      if (statement.startsWith('UPDATE livewalk_sessions SET status=$1, ended_at=COALESCE')) {
        const [status, timestamp, sessionId] = params;
        assert.equal(sessionId, state.session.id);
        Object.assign(state.session, { status, ended_at: state.session.ended_at ?? timestamp, updated_at: timestamp });
        return { rows: [] };
      }
      if (statement === 'UPDATE livewalk_sessions SET status=$1, updated_at=$2 WHERE id=$3') {
        const [status, timestamp, sessionId] = params;
        assert.equal(sessionId, state.session.id);
        Object.assign(state.session, { status, updated_at: timestamp });
        return { rows: [] };
      }
      if (statement === 'UPDATE livewalk_requests SET status=$1, updated_at=$2 WHERE id=$3') {
        const [status, timestamp, requestId] = params;
        assert.equal(requestId, state.request.id);
        Object.assign(state.request, { status, updated_at: timestamp });
        return { rows: [] };
      }
      if (statement.startsWith('INSERT INTO livewalk_messages')) {
        const [messageId, sessionId, senderRole, senderName, text, timestamp] = params;
        state.messages.push({ id: messageId, session_id: sessionId, sender_role: senderRole, sender_name: senderName, text, created_at: timestamp });
        return { rows: [] };
      }
      throw new Error(`Unexpected test query: ${statement}`);
    },
  };

  let connectionCalls = 0;
  let activeConnections = 0;
  let maximumActiveConnections = 0;
  const useDb = async (operation) => {
    connectionCalls += 1;
    activeConnections += 1;
    maximumActiveConnections = Math.max(maximumActiveConnections, activeConnections);
    assert.equal(activeConnections, 1, 'a store operation opened a nested database connection');
    try {
      return await operation(client);
    } finally {
      activeConnections -= 1;
    }
  };
  const store = makeDbStore({}, useDb);

  async function withOneConnection(operation) {
    const before = connectionCalls;
    const result = await operation();
    assert.equal(connectionCalls - before, 1);
    assert.equal(maximumActiveConnections, 1);
    return result;
  }

  return { state, store, withOneConnection };
}

const lifecycle = createFixture();
const accepted = await lifecycle.withOneConnection(() => lifecycle.store.acceptRequest(lifecycle.state.request.id, guide));
assert.equal(accepted.request.status, 'accepted');
assert.equal(accepted.session.status, 'ready');
assert.equal(lifecycle.state.messages.length, 1);
assert.equal(lifecycle.state.messages[0].text, 'Test Guide accepted the walk.');

const acceptedAgain = await lifecycle.withOneConnection(() => lifecycle.store.acceptRequest(lifecycle.state.request.id, guide));
assert.equal(acceptedAgain.request.status, 'accepted');
assert.equal(acceptedAgain.session.id, accepted.session.id);
assert.equal(lifecycle.state.messages.length, 1);

const readyRead = await lifecycle.withOneConnection(() => lifecycle.store.getSession(accepted.session.id, guide));
assert.equal(readyRead.session.status, 'ready');
assert.equal(readyRead.request.status, 'accepted');
assert.deepEqual(readyRead.messages.map((message) => message.text), ['Test Guide accepted the walk.']);

const unauthorizedRead = await lifecycle.withOneConnection(() => lifecycle.store.getSession(accepted.session.id, { id: 'usr_other', role: 'traveler', name: 'Other' }));
assert.equal(unauthorizedRead, null);

const started = await lifecycle.withOneConnection(() => lifecycle.store.startSession(accepted.session.id, guide));
assert.equal(started.session.status, 'live');
assert.equal(started.request.status, 'live');
assert.equal(started.messages.at(-1).text, 'The live walk session started.');

const ended = await lifecycle.withOneConnection(() => lifecycle.store.endSession(accepted.session.id, guide));
assert.equal(ended.session.status, 'ended');
assert.equal(ended.request.status, 'completed');
assert.ok(ended.session.endedAt);
assert.equal(ended.messages.at(-1).text, 'The live walk session ended.');

const endMessageCount = lifecycle.state.messages.filter((message) => message.text === 'The live walk session ended.').length;
const endedAgain = await lifecycle.withOneConnection(() => lifecycle.store.endSession(accepted.session.id, traveler));
assert.equal(endedAgain.session.endedAt, ended.session.endedAt);
assert.equal(lifecycle.state.messages.filter((message) => message.text === 'The live walk session ended.').length, endMessageCount);

const cancellation = createFixture();
const cancellationAccepted = await cancellation.withOneConnection(() => cancellation.store.acceptRequest(cancellation.state.request.id, guide));
const cancelled = await cancellation.withOneConnection(() => cancellation.store.cancelRequest(cancellation.state.request.id, traveler));
assert.equal(cancelled.request.status, 'cancelled');
assert.equal(cancelled.session.id, cancellationAccepted.session.id);
assert.equal(cancelled.session.status, 'cancelled');
assert.equal(cancelled.request.guide.name, guide.name);

const cancelledAgain = await cancellation.withOneConnection(() => cancellation.store.cancelRequest(cancellation.state.request.id, traveler));
assert.equal(cancelledAgain.request.status, 'cancelled');
assert.equal(cancellation.state.messages.filter((message) => message.text === 'Traveler cancelled this walk.').length, 1);

console.log('Database connection reuse verified for request/session lifecycle paths');
