const memory = globalThis.__LIVEWALK_STATE__ ??= {
  users: new Map(),
  sessionsByTokenHash: new Map(),
  requests: new Map(),
  liveSessions: new Map(),
  messages: new Map(),
};
memory.declines ??= new Set();

let PgClient;
let schemaReady = false;

import { TOKEN_DAYS, now, id, normalizeEmail, normalizeCity, cityForPoint, publicUser, displayName, publicRequest, publicRequestForUser, publicSession, newestFirst, randomBase64, sha256, hashPassword, verifyPassword, bearerToken, parsePoint, parseDurationMinutes, parseScheduledStart, computeEstimate, makeRequest, makeMessage, makeGuide, canReadRequest, canUseSession, sessionLocation } from './domain.js';

const declineKey = (requestId, guideId) => `${requestId}:${guideId}`;
function declineConflict() { const error = new Error('Only pending requests can be declined'); error.code = 'REQUEST_NOT_PENDING'; return error; }

function makeMemoryStore() {
  async function createAuthSession(user) {
    const token = randomBase64(32);
    const tokenHash = await sha256(token);
    const expiresAt = new Date(Date.now() + TOKEN_DAYS * 86400000).toISOString();
    memory.sessionsByTokenHash.set(tokenHash, { tokenHash, userId: user.id, expiresAt, createdAt: now() });
    return token;
  }

  return {
    async health() { return { backend: 'edge-memory-demo', users: memory.users.size, requests: memory.requests.size, sessions: memory.liveSessions.size }; },
    async reset() { memory.users.clear(); memory.sessionsByTokenHash.clear(); memory.requests.clear(); memory.liveSessions.clear(); memory.messages.clear(); memory.declines.clear(); },
    async registerUser(payload) {
      const email = normalizeEmail(payload.email);
      const password = String(payload.password || '');
      const role = payload.role === 'guide' ? 'guide' : 'traveler';
      const name = String(payload.name || payload.displayName || (role === 'guide' ? 'Yuki Tanaka' : 'Sofia R.')).trim();
      if (!email.includes('@')) throw new Error('Valid email is required');
      if (password.length < 6) throw new Error('Password must be at least 6 characters');
      if ([...memory.users.values()].some((u) => u.email === email)) throw new Error('Email already registered');
      const { salt, hash } = await hashPassword(password);
      const city = role === 'guide' ? normalizeCity(payload.city) : 'other';
      const user = { id: id('usr'), email, role, name, city, passwordSalt: salt, passwordHash: hash, createdAt: now(), updatedAt: now() };
      memory.users.set(user.id, user);
      const token = await createAuthSession(user);
      return { user: publicUser(user), token };
    },
    async loginUser(payload) {
      const email = normalizeEmail(payload.email);
      const password = String(payload.password || '');
      const user = [...memory.users.values()].find((u) => u.email === email);
      if (!user || !(await verifyPassword(password, user.passwordSalt, user.passwordHash))) throw new Error('Invalid email or password');
      const displayName = String(payload.name || payload.displayName || '').trim();
      if (displayName) { user.name = displayName; user.updatedAt = now(); }
      const token = await createAuthSession(user);
      return { user: publicUser(user), token };
    },
    async userForToken(token) {
      if (!token) return null;
      const session = memory.sessionsByTokenHash.get(await sha256(token));
      if (!session || Date.parse(session.expiresAt) < Date.now()) return null;
      return memory.users.get(session.userId) || null;
    },
    async logout(token) { if (token) memory.sessionsByTokenHash.delete(await sha256(token)); },
    async createRequest(payload, user) { const request = makeRequest(payload, user); memory.requests.set(request.id, request); return publicRequest(request); },
    async listRequests(status, user) {
      const rows = [...memory.requests.values()].filter((item) => {
        if (status && item.status !== status) return false;
        if (user.role === 'traveler') return item.travelerId === user.id;
        if (user.role === 'guide') return canReadRequest(user, item) && !memory.declines.has(declineKey(item.id, user.id));
        return false;
      });
      return newestFirst(rows).map((item) => publicRequestForUser(item, user));
    },
    async getRequest(requestId, user) {
      const request = memory.requests.get(requestId);
      if (!canReadRequest(user, request)) return null;
      return { request: publicRequestForUser(request, user), session: request.sessionId ? publicSession(memory.liveSessions.get(request.sessionId)) : null };
    },
    async acceptRequest(requestId, user) {
      const request = memory.requests.get(requestId);
      if (!request || user.role !== 'guide' || !canReadRequest(user, request) || (request.guideId && request.guideId !== user.id)) return null;
      const sessionId = request.sessionId || id('sess');
      request.status = 'accepted'; request.guideId = user.id; request.guide = makeGuide(user); request.sessionId = sessionId; request.updatedAt = now();
      memory.liveSessions.set(sessionId, memory.liveSessions.get(sessionId) ?? { id: sessionId, requestId, status: 'ready', startedAt: null, location: null, createdAt: now(), updatedAt: now() });
      await this.addMessage(sessionId, { text: `${request.guide.name} accepted the walk.` }, { ...user, role: 'system', name: 'LiveWalk' }, true);
      return { request: publicRequest(request), session: publicSession(memory.liveSessions.get(sessionId)) };
    },
    async declineRequest(requestId, user) {
      const request = memory.requests.get(requestId);
      if (!request || user.role !== 'guide') return null;
      if (request.status !== 'pending' || request.guideId) throw declineConflict();
      memory.declines.add(declineKey(requestId, user.id));
      return publicRequest(request);
    },
    async getSession(sessionId, user) {
      const session = memory.liveSessions.get(sessionId);
      const request = session ? memory.requests.get(session.requestId) : null;
      if (!session || !canUseSession(user, request)) return null;
      return { session: publicSession(session), messages: memory.messages.get(sessionId) ?? [] };
    },
    async startSession(sessionId, user) {
      const session = memory.liveSessions.get(sessionId);
      const request = session ? memory.requests.get(session.requestId) : null;
      if (!session || !canUseSession(user, request) || user.role !== 'guide' || request.guideId !== user.id) return null;
      session.status = 'live'; session.startedAt ||= now(); session.updatedAt = now();
      request.status = 'live'; request.updatedAt = now();
      await this.addMessage(sessionId, { text: 'The live walk session started.' }, { ...user, role: 'system', name: 'LiveWalk' }, true);
      return this.getSession(sessionId, user);
    },
    async endSession(sessionId, user) {
      const session = memory.liveSessions.get(sessionId);
      const request = session ? memory.requests.get(session.requestId) : null;
      if (!session || !canUseSession(user, request)) return null;
      if (session.status === 'ended') return this.getSession(sessionId, user);
      const endedAt = now();
      session.status = 'ended'; session.endedAt = endedAt; session.updatedAt = endedAt;
      request.status = 'completed'; request.updatedAt = endedAt;
      await this.addMessage(sessionId, { text: 'The live walk session ended.' }, { ...user, role: 'system', name: 'LiveWalk' }, true);
      return this.getSession(sessionId, user);
    },
    async addMessage(sessionId, payload, user, system = false) {
      const session = memory.liveSessions.get(sessionId);
      const request = session ? memory.requests.get(session.requestId) : null;
      if (!session || (!system && !canUseSession(user, request))) return null;
      if (!system && session.status !== 'live') throw new Error('Live session has not started yet');
      const message = system ? { id: id('msg'), sessionId, senderRole: 'system', senderName: 'LiveWalk', text: String(payload.text || '').slice(0, 1000), createdAt: now() } : makeMessage(sessionId, payload, user);
      const list = memory.messages.get(sessionId) ?? []; list.push(message); memory.messages.set(sessionId, list); return message;
    },
    async setLocation(sessionId, payload, user) {
      const session = memory.liveSessions.get(sessionId);
      const request = session ? memory.requests.get(session.requestId) : null;
      if (!session || !canUseSession(user, request) || user.role !== 'guide') return null;
      if (session.status !== 'live') throw new Error('Live session has not started yet');
      session.location = sessionLocation(payload);
      session.updatedAt = now(); return publicSession(session);
    },
  };
}

function rowToUser(row) { return row ? { id: row.id, email: row.email, role: row.role, name: row.name, city: normalizeCity(row.city), passwordSalt: row.password_salt, passwordHash: row.password_hash, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function rowToRequest(row) {
  if (!row) return null;
  const origin = parsePoint(row.origin_point ?? row.origin);
  const destination = parsePoint(row.destination_point ?? row.destination);
  if (!origin || !destination) return null;
  const durationMinutes = Number(row.duration_minutes) || parseDurationMinutes({ duration: row.duration });
  return {
    id: row.id,
    travelerId: row.traveler_id,
    guideId: row.guide_id,
    travelerName: displayName(row.traveler_display_name, displayName(row.traveler_name, 'Traveler')),
    city: row.city ? normalizeCity(row.city) : cityForPoint(origin),
    origin,
    destination,
    scheduledStart: parseScheduledStart({ scheduledStart: row.scheduled_start, scheduledTime: row.scheduled_time }),
    durationMinutes,
    language: row.language,
    interests: Array.isArray(row.interests) ? row.interests : [],
    estimate: row.estimate || computeEstimate(origin, destination, durationMinutes),
    status: row.status,
    guide: row.guide || null,
    sessionId: row.session_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function rowToSession(row) { return row ? { id: row.id, requestId: row.request_id, status: row.status, startedAt: row.started_at, endedAt: row.ended_at || null, location: row.location || null, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function rowToMessage(row) { return { id: row.id, sessionId: row.session_id, senderRole: row.sender_role, senderName: row.sender_name, text: row.text, createdAt: row.created_at }; }

async function connectDb(env) {
  if (!PgClient) ({ Client: PgClient } = await import('pg'));
  const client = new PgClient({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  if (!schemaReady) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS livewalk_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('traveler','guide')),
        name TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT 'other',
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS livewalk_auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES livewalk_users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS livewalk_requests (
        id TEXT PRIMARY KEY,
        traveler_id TEXT,
        guide_id TEXT,
        traveler_name TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT 'other',
        origin TEXT NOT NULL,
        destination TEXT NOT NULL,
        scheduled_time TEXT NOT NULL,
        duration TEXT NOT NULL,
        origin_point JSONB,
        destination_point JSONB,
        scheduled_start TEXT,
        duration_minutes INTEGER,
        estimate JSONB,
        language TEXT NOT NULL,
        interests JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL,
        guide JSONB,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS livewalk_sessions (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES livewalk_requests(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        location JSONB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS livewalk_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES livewalk_sessions(id) ON DELETE CASCADE,
        sender_role TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS livewalk_declines (
        request_id TEXT NOT NULL REFERENCES livewalk_requests(id) ON DELETE CASCADE,
        guide_id TEXT NOT NULL REFERENCES livewalk_users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (request_id, guide_id)
      );
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS traveler_id TEXT;
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS guide_id TEXT;
      ALTER TABLE livewalk_users ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS origin_point JSONB;
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS destination_point JSONB;
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS scheduled_start TEXT;
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS estimate JSONB;
      ALTER TABLE livewalk_sessions ADD COLUMN IF NOT EXISTS ended_at TEXT;
      UPDATE livewalk_requests SET city = CASE
        WHEN origin_point IS NOT NULL
          AND origin_point->>'lat' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND origin_point->>'lng' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND (origin_point->>'lat')::numeric BETWEEN 51.28 AND 51.70
          AND (origin_point->>'lng')::numeric BETWEEN -0.55 AND 0.33 THEN 'London'
        WHEN origin_point IS NOT NULL
          AND origin_point->>'lat' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND origin_point->>'lng' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND (origin_point->>'lat')::numeric BETWEEN 43.55 AND 43.85
          AND (origin_point->>'lng')::numeric BETWEEN -79.65 AND -79.10 THEN 'Toronto'
        ELSE 'other'
      END;
      CREATE INDEX IF NOT EXISTS livewalk_requests_status_created_idx ON livewalk_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS livewalk_requests_city_status_created_idx ON livewalk_requests(city, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS livewalk_declines_guide_request_idx ON livewalk_declines(guide_id, request_id);
      CREATE INDEX IF NOT EXISTS livewalk_messages_session_created_idx ON livewalk_messages(session_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS livewalk_sessions_user_idx ON livewalk_auth_sessions(user_id);
    `);
    schemaReady = true;
  }
  return client;
}
async function withDb(env, fn) { const client = await connectDb(env); try { return await fn(client); } finally { await client.end().catch(() => {}); } }

function requestSelect(whereClause = '', orderClause = '') {
  return `SELECT r.*, u.name AS traveler_display_name FROM livewalk_requests r LEFT JOIN livewalk_users u ON u.id=r.traveler_id ${whereClause} ${orderClause}`.trim();
}

function makeDbStore(env) {
  return {
    async health() { return withDb(env, async (client) => { const users = await client.query('SELECT COUNT(*)::int AS count FROM livewalk_users'); const requests = await client.query('SELECT COUNT(*)::int AS count FROM livewalk_requests'); const sessions = await client.query('SELECT COUNT(*)::int AS count FROM livewalk_sessions'); return { backend: 'postgres-auth-demo', users: users.rows[0].count, requests: requests.rows[0].count, sessions: sessions.rows[0].count }; }); },
    async reset() { return withDb(env, async (client) => { await client.query('TRUNCATE livewalk_messages, livewalk_sessions, livewalk_declines, livewalk_requests, livewalk_auth_sessions, livewalk_users'); }); },
    async registerUser(payload) { return withDb(env, async (client) => { const email = normalizeEmail(payload.email); const password = String(payload.password || ''); const role = payload.role === 'guide' ? 'guide' : 'traveler'; const name = String(payload.name || payload.displayName || (role === 'guide' ? 'Yuki Tanaka' : 'Sofia R.')).trim(); const city = role === 'guide' ? normalizeCity(payload.city) : 'other'; if (!email.includes('@')) throw new Error('Valid email is required'); if (password.length < 6) throw new Error('Password must be at least 6 characters'); const { salt, hash } = await hashPassword(password); const user = { id: id('usr'), email, role, name, city, passwordSalt: salt, passwordHash: hash, createdAt: now(), updatedAt: now() }; try { await client.query('INSERT INTO livewalk_users (id,email,role,name,city,password_salt,password_hash,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [user.id, user.email, user.role, user.name, user.city, user.passwordSalt, user.passwordHash, user.createdAt, user.updatedAt]); } catch (error) { if (String(error.message).includes('duplicate') || error.code === '23505') throw new Error('Email already registered'); throw error; } const token = randomBase64(32); await client.query('INSERT INTO livewalk_auth_sessions (token_hash,user_id,expires_at,created_at) VALUES ($1,$2,$3,$4)', [await sha256(token), user.id, new Date(Date.now() + TOKEN_DAYS * 86400000).toISOString(), now()]); return { user: publicUser(user), token }; }); },
    async loginUser(payload) { return withDb(env, async (client) => { const result = await client.query('SELECT * FROM livewalk_users WHERE email=$1', [normalizeEmail(payload.email)]); const user = rowToUser(result.rows[0]); if (!user || !(await verifyPassword(String(payload.password || ''), user.passwordSalt, user.passwordHash))) throw new Error('Invalid email or password'); const displayName = String(payload.name || payload.displayName || '').trim(); if (displayName && displayName !== user.name) { const updatedAt = now(); await client.query('UPDATE livewalk_users SET name=$1, updated_at=$2 WHERE id=$3', [displayName, updatedAt, user.id]); user.name = displayName; user.updatedAt = updatedAt; } const token = randomBase64(32); await client.query('INSERT INTO livewalk_auth_sessions (token_hash,user_id,expires_at,created_at) VALUES ($1,$2,$3,$4)', [await sha256(token), user.id, new Date(Date.now() + TOKEN_DAYS * 86400000).toISOString(), now()]); return { user: publicUser(user), token }; }); },
    async userForToken(token) { if (!token) return null; return withDb(env, async (client) => { const result = await client.query('SELECT u.* FROM livewalk_auth_sessions s JOIN livewalk_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2', [await sha256(token), now()]); return rowToUser(result.rows[0]); }); },
    async logout(token) { if (!token) return; return withDb(env, async (client) => { await client.query('DELETE FROM livewalk_auth_sessions WHERE token_hash=$1', [await sha256(token)]); }); },
    async createRequest(payload, user) { const request = makeRequest(payload, user); await withDb(env, async (client) => { await client.query(`INSERT INTO livewalk_requests (id, traveler_id, guide_id, traveler_name, city, origin, destination, scheduled_time, duration, origin_point, destination_point, scheduled_start, duration_minutes, estimate, language, interests, status, guide, session_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb,$15,$16::jsonb,$17,$18::jsonb,$19,$20,$21)`, [request.id, request.travelerId, null, request.travelerName, request.city, request.origin.label, request.destination.label, request.scheduledStart, `${request.durationMinutes} min`, JSON.stringify(request.origin), JSON.stringify(request.destination), request.scheduledStart, request.durationMinutes, JSON.stringify(request.estimate), request.language, JSON.stringify(request.interests), request.status, null, null, request.createdAt, request.updatedAt]); }); return publicRequest(request); },
    async listRequests(status, user) { return withDb(env, async (client) => { let result; if (user.role === 'traveler') result = status ? await client.query(requestSelect('WHERE r.traveler_id=$1 AND r.status=$2', 'ORDER BY r.created_at DESC'), [user.id, status]) : await client.query(requestSelect('WHERE r.traveler_id=$1', 'ORDER BY r.created_at DESC'), [user.id]); else { const city = normalizeCity(user.city); result = status ? await client.query(requestSelect('WHERE r.status=$1 AND (r.guide_id=$2 OR (r.guide_id IS NULL AND r.city=$3)) AND NOT EXISTS (SELECT 1 FROM livewalk_declines d WHERE d.request_id=r.id AND d.guide_id=$2)', 'ORDER BY r.created_at DESC'), [status, user.id, city]) : await client.query(requestSelect('WHERE (r.guide_id=$1 OR (r.guide_id IS NULL AND r.city=$2)) AND NOT EXISTS (SELECT 1 FROM livewalk_declines d WHERE d.request_id=r.id AND d.guide_id=$1)', 'ORDER BY r.created_at DESC'), [user.id, city]); } return result.rows.map(rowToRequest).filter(Boolean).map((item) => publicRequestForUser(item, user)); }); },
    async getRequest(requestId, user) { return withDb(env, async (client) => { const req = rowToRequest((await client.query(requestSelect('WHERE r.id=$1'), [requestId])).rows[0]); if (!canReadRequest(user, req)) return null; let session = null; if (req.sessionId) session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [req.sessionId])).rows[0]); return { request: publicRequestForUser(req, user), session: publicSession(session) }; }); },
    async acceptRequest(requestId, user) { if (user.role !== 'guide') return null; return withDb(env, async (client) => { await client.query('BEGIN'); try { const req = rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0]); if (!req || !canReadRequest(user, req) || (req.guideId && req.guideId !== user.id)) { await client.query('ROLLBACK'); return null; } const guide = makeGuide(user); const sessionId = req.sessionId || id('sess'); const updatedAt = now(); await client.query('UPDATE livewalk_requests SET status=$1, guide_id=$2, guide=$3::jsonb, session_id=$4, updated_at=$5 WHERE id=$6', ['accepted', user.id, JSON.stringify(guide), sessionId, updatedAt, requestId]); await client.query(`INSERT INTO livewalk_sessions (id, request_id, status, started_at, location, created_at, updated_at) VALUES ($1,$2,'ready',NULL,NULL,$3,$3) ON CONFLICT (id) DO NOTHING`, [sessionId, requestId, updatedAt]); const msgId = id('msg'); await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [msgId, sessionId, 'system', 'LiveWalk', `${guide.name} accepted the walk.`, now()]); await client.query('COMMIT'); return this.getRequest(requestId, user); } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } }); },
    async declineRequest(requestId, user) { if (user.role !== 'guide') return null; return withDb(env, async (client) => { await client.query('BEGIN'); try { const req = rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0]); if (!req) { await client.query('ROLLBACK'); return null; } if (req.status !== 'pending' || req.guideId) throw declineConflict(); await client.query('INSERT INTO livewalk_declines (request_id, guide_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (request_id, guide_id) DO NOTHING', [requestId, user.id, now()]); await client.query('COMMIT'); return publicRequest(req); } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } }); },
    async getSession(sessionId, user) { return withDb(env, async (client) => { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query(requestSelect('WHERE r.id=$1'), [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req)) return null; const messages = await client.query('SELECT * FROM livewalk_messages WHERE session_id=$1 ORDER BY created_at ASC', [sessionId]); return { session: publicSession(session), messages: messages.rows.map(rowToMessage) }; }); },
    async startSession(sessionId, user) { return withDb(env, async (client) => { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query(requestSelect('WHERE r.id=$1'), [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req) || user.role !== 'guide' || req.guideId !== user.id) return null; const updatedAt = now(); await client.query('UPDATE livewalk_sessions SET status=$1, started_at=COALESCE(started_at,$2), updated_at=$2 WHERE id=$3', ['live', updatedAt, sessionId]); await client.query('UPDATE livewalk_requests SET status=$1, updated_at=$2 WHERE id=$3', ['live', updatedAt, session.requestId]); await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id('msg'), sessionId, 'system', 'LiveWalk', 'The live walk session started.', now()]); return this.getSession(sessionId, user); }); },
    async endSession(sessionId, user) { return withDb(env, async (client) => { await client.query('BEGIN'); try { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1 FOR UPDATE', [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req)) { await client.query('ROLLBACK'); return null; } if (session.status === 'ended') { await client.query('COMMIT'); return this.getSession(sessionId, user); } const endedAt = now(); await client.query('UPDATE livewalk_sessions SET status=$1, ended_at=COALESCE(ended_at,$2), updated_at=$2 WHERE id=$3', ['ended', endedAt, sessionId]); await client.query('UPDATE livewalk_requests SET status=$1, updated_at=$2 WHERE id=$3', ['completed', endedAt, session.requestId]); await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id('msg'), sessionId, 'system', 'LiveWalk', 'The live walk session ended.', endedAt]); await client.query('COMMIT'); return this.getSession(sessionId, user); } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } }); },
    async addMessage(sessionId, payload, user) { return withDb(env, async (client) => { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query(requestSelect('WHERE r.id=$1'), [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req)) return null; if (session.status !== 'live') throw new Error('Live session has not started yet'); const message = makeMessage(sessionId, payload, user); await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [message.id, message.sessionId, message.senderRole, message.senderName, message.text, message.createdAt]); return message; }); },
    async setLocation(sessionId, payload, user) { return withDb(env, async (client) => { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query(requestSelect('WHERE r.id=$1'), [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req) || user.role !== 'guide') return null; if (session.status !== 'live') throw new Error('Live session has not started yet'); const location = sessionLocation(payload); const result = await client.query('UPDATE livewalk_sessions SET location=$1::jsonb, updated_at=$2 WHERE id=$3 RETURNING *', [JSON.stringify(location), now(), sessionId]); return publicSession(rowToSession(result.rows[0])); }); },
  };
}

const store = (env) => env?.HYPERDRIVE?.connectionString ? makeDbStore(env) : makeMemoryStore();
async function requireUser(request, storage) { const token = bearerToken(request); const user = await storage.userForToken(token); return { token, user }; }

export { store, requireUser, rowToRequest };
