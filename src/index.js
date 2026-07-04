const memory = globalThis.__LIVEWALK_STATE__ ??= {
  users: new Map(),
  sessionsByTokenHash: new Map(),
  requests: new Map(),
  liveSessions: new Map(),
  messages: new Map(),
};

let PgClient;
let schemaReady = false;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
});
const notFound = (message = 'Not found') => json({ ok: false, error: message }, 404);
const bad = (message) => json({ ok: false, error: message }, 400);
const forbidden = (message = 'Not authorized') => json({ ok: false, error: message }, 403);
const unauth = (message = 'Login required') => json({ ok: false, error: message }, 401);
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 10)}`;
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const cleanList = (value) => Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 12) : [];
const route = (request) => `${request.origin} → ${request.destination}`;
const publicUser = (user) => user ? { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt } : null;
const publicRequest = (request) => request ? { ...request, route: route(request), travelerId: undefined, guideId: undefined } : null;
const publicSession = (session) => session ? { ...session } : null;
const newestFirst = (items) => [...items].sort((a, b) => String(b.createdAt || b.updatedAt).localeCompare(String(a.createdAt || a.updatedAt)));
const TOKEN_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBase64(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

async function hashPassword(password, salt = randomBase64(16)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: base64ToBytes(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return { salt, hash: bytesToBase64(new Uint8Array(bits)) };
}

async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  return hash === expectedHash;
}

function bearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

async function body(request) {
  if (request.method === 'GET') return {};
  try { return await request.json(); } catch { return {}; }
}

function makeRequest(payload, user) {
  const createdAt = now();
  return {
    id: id('req'),
    travelerId: user.id,
    guideId: null,
    travelerName: String(payload.travelerName || user.name || 'Traveler'),
    origin: String(payload.origin || payload.start || 'Shibuya Station, Tokyo'),
    destination: String(payload.destination || 'Meiji Shrine forest entrance'),
    scheduledTime: String(payload.scheduledTime || payload.dateTime || 'Tomorrow, 10:30 AM'),
    duration: String(payload.duration || '45 min'),
    language: String(payload.language || 'English'),
    interests: cleanList(payload.interests),
    status: 'pending',
    guide: null,
    sessionId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeMessage(sessionId, payload, user) {
  const text = String(payload.text || '').trim();
  if (!text) throw new Error('Message text is required');
  return {
    id: id('msg'),
    sessionId,
    senderRole: user.role,
    senderName: user.name || (user.role === 'guide' ? 'Guide' : 'Traveler'),
    text: text.slice(0, 1000),
    createdAt: now(),
  };
}

function makeGuide(user) {
  return { id: user.id, name: user.name || 'Guide', avatar: (user.name || 'GD').slice(0, 2).toUpperCase() };
}

function canReadRequest(user, request) {
  if (!user || !request) return false;
  if (user.role === 'traveler') return request.travelerId === user.id;
  if (user.role === 'guide') return !request.guideId || request.guideId === user.id;
  return false;
}

function canUseSession(user, request) {
  if (!user || !request) return false;
  return (user.role === 'traveler' && request.travelerId === user.id) || (user.role === 'guide' && request.guideId === user.id);
}

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
    async reset() { memory.users.clear(); memory.sessionsByTokenHash.clear(); memory.requests.clear(); memory.liveSessions.clear(); memory.messages.clear(); },
    async registerUser(payload) {
      const email = normalizeEmail(payload.email);
      const password = String(payload.password || '');
      const role = payload.role === 'guide' ? 'guide' : 'traveler';
      const name = String(payload.name || payload.displayName || (role === 'guide' ? 'Yuki Tanaka' : 'Sofia R.')).trim();
      if (!email.includes('@')) throw new Error('Valid email is required');
      if (password.length < 6) throw new Error('Password must be at least 6 characters');
      if ([...memory.users.values()].some((u) => u.email === email)) throw new Error('Email already registered');
      const { salt, hash } = await hashPassword(password);
      const user = { id: id('usr'), email, role, name, passwordSalt: salt, passwordHash: hash, createdAt: now(), updatedAt: now() };
      memory.users.set(user.id, user);
      const token = await createAuthSession(user);
      return { user: publicUser(user), token };
    },
    async loginUser(payload) {
      const email = normalizeEmail(payload.email);
      const password = String(payload.password || '');
      const user = [...memory.users.values()].find((u) => u.email === email);
      if (!user || !(await verifyPassword(password, user.passwordSalt, user.passwordHash))) throw new Error('Invalid email or password');
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
        if (user.role === 'guide') return !item.guideId || item.guideId === user.id;
        return false;
      });
      return newestFirst(rows).map(publicRequest);
    },
    async getRequest(requestId, user) {
      const request = memory.requests.get(requestId);
      if (!canReadRequest(user, request)) return null;
      return { request: publicRequest(request), session: request.sessionId ? publicSession(memory.liveSessions.get(request.sessionId)) : null };
    },
    async acceptRequest(requestId, user) {
      const request = memory.requests.get(requestId);
      if (!request || user.role !== 'guide' || (request.guideId && request.guideId !== user.id)) return null;
      const sessionId = request.sessionId || id('sess');
      request.status = 'accepted'; request.guideId = user.id; request.guide = makeGuide(user); request.sessionId = sessionId; request.updatedAt = now();
      memory.liveSessions.set(sessionId, memory.liveSessions.get(sessionId) ?? { id: sessionId, requestId, status: 'ready', startedAt: null, location: null, createdAt: now(), updatedAt: now() });
      await this.addMessage(sessionId, { text: `${request.guide.name} accepted the walk.` }, { ...user, role: 'system', name: 'LiveWalk' }, true);
      return { request: publicRequest(request), session: publicSession(memory.liveSessions.get(sessionId)) };
    },
    async declineRequest(requestId, user) {
      const request = memory.requests.get(requestId);
      if (!request || user.role !== 'guide') return null;
      request.status = 'declined'; request.guideId = user.id; request.guide = makeGuide(user); request.updatedAt = now();
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
      if (!session || !canUseSession(user, request)) return null;
      session.status = 'live'; session.startedAt ||= now(); session.updatedAt = now();
      request.status = 'live'; request.updatedAt = now();
      await this.addMessage(sessionId, { text: 'The live walk session started.' }, { ...user, role: 'system', name: 'LiveWalk' }, true);
      return this.getSession(sessionId, user);
    },
    async addMessage(sessionId, payload, user, system = false) {
      const session = memory.liveSessions.get(sessionId);
      const request = session ? memory.requests.get(session.requestId) : null;
      if (!session || (!system && !canUseSession(user, request))) return null;
      const message = system ? { id: id('msg'), sessionId, senderRole: 'system', senderName: 'LiveWalk', text: String(payload.text || '').slice(0, 1000), createdAt: now() } : makeMessage(sessionId, payload, user);
      const list = memory.messages.get(sessionId) ?? []; list.push(message); memory.messages.set(sessionId, list); return message;
    },
    async setLocation(sessionId, payload, user) {
      const session = memory.liveSessions.get(sessionId);
      const request = session ? memory.requests.get(session.requestId) : null;
      if (!session || !canUseSession(user, request)) return null;
      session.location = { lat: Number(payload.lat ?? payload.latitude ?? 35.6595), lng: Number(payload.lng ?? payload.longitude ?? 139.7005), label: String(payload.label || 'Guide near Shibuya side street'), progress: Number(payload.progress ?? 48), updatedAt: now() };
      session.updatedAt = now(); return publicSession(session);
    },
  };
}

function rowToUser(row) { return row ? { id: row.id, email: row.email, role: row.role, name: row.name, passwordSalt: row.password_salt, passwordHash: row.password_hash, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function rowToRequest(row) { return row ? { id: row.id, travelerId: row.traveler_id, guideId: row.guide_id, travelerName: row.traveler_name, origin: row.origin, destination: row.destination, scheduledTime: row.scheduled_time, duration: row.duration, language: row.language, interests: Array.isArray(row.interests) ? row.interests : [], status: row.status, guide: row.guide || null, sessionId: row.session_id || null, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function rowToSession(row) { return row ? { id: row.id, requestId: row.request_id, status: row.status, startedAt: row.started_at, location: row.location || null, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
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
        origin TEXT NOT NULL,
        destination TEXT NOT NULL,
        scheduled_time TEXT NOT NULL,
        duration TEXT NOT NULL,
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
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS traveler_id TEXT;
      ALTER TABLE livewalk_requests ADD COLUMN IF NOT EXISTS guide_id TEXT;
      CREATE INDEX IF NOT EXISTS livewalk_requests_status_created_idx ON livewalk_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS livewalk_messages_session_created_idx ON livewalk_messages(session_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS livewalk_sessions_user_idx ON livewalk_auth_sessions(user_id);
    `);
    schemaReady = true;
  }
  return client;
}
async function withDb(env, fn) { const client = await connectDb(env); try { return await fn(client); } finally { await client.end().catch(() => {}); } }

function makeDbStore(env) {
  return {
    async health() { return withDb(env, async (client) => { const users = await client.query('SELECT COUNT(*)::int AS count FROM livewalk_users'); const requests = await client.query('SELECT COUNT(*)::int AS count FROM livewalk_requests'); const sessions = await client.query('SELECT COUNT(*)::int AS count FROM livewalk_sessions'); return { backend: 'postgres-auth-demo', users: users.rows[0].count, requests: requests.rows[0].count, sessions: sessions.rows[0].count }; }); },
    async reset() { return withDb(env, async (client) => { await client.query('TRUNCATE livewalk_messages, livewalk_sessions, livewalk_requests, livewalk_auth_sessions, livewalk_users'); }); },
    async registerUser(payload) { return withDb(env, async (client) => { const email = normalizeEmail(payload.email); const password = String(payload.password || ''); const role = payload.role === 'guide' ? 'guide' : 'traveler'; const name = String(payload.name || payload.displayName || (role === 'guide' ? 'Yuki Tanaka' : 'Sofia R.')).trim(); if (!email.includes('@')) throw new Error('Valid email is required'); if (password.length < 6) throw new Error('Password must be at least 6 characters'); const { salt, hash } = await hashPassword(password); const user = { id: id('usr'), email, role, name, passwordSalt: salt, passwordHash: hash, createdAt: now(), updatedAt: now() }; try { await client.query('INSERT INTO livewalk_users (id,email,role,name,password_salt,password_hash,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [user.id, user.email, user.role, user.name, user.passwordSalt, user.passwordHash, user.createdAt, user.updatedAt]); } catch (error) { if (String(error.message).includes('duplicate') || error.code === '23505') throw new Error('Email already registered'); throw error; } const token = randomBase64(32); await client.query('INSERT INTO livewalk_auth_sessions (token_hash,user_id,expires_at,created_at) VALUES ($1,$2,$3,$4)', [await sha256(token), user.id, new Date(Date.now() + TOKEN_DAYS * 86400000).toISOString(), now()]); return { user: publicUser(user), token }; }); },
    async loginUser(payload) { return withDb(env, async (client) => { const result = await client.query('SELECT * FROM livewalk_users WHERE email=$1', [normalizeEmail(payload.email)]); const user = rowToUser(result.rows[0]); if (!user || !(await verifyPassword(String(payload.password || ''), user.passwordSalt, user.passwordHash))) throw new Error('Invalid email or password'); const token = randomBase64(32); await client.query('INSERT INTO livewalk_auth_sessions (token_hash,user_id,expires_at,created_at) VALUES ($1,$2,$3,$4)', [await sha256(token), user.id, new Date(Date.now() + TOKEN_DAYS * 86400000).toISOString(), now()]); return { user: publicUser(user), token }; }); },
    async userForToken(token) { if (!token) return null; return withDb(env, async (client) => { const result = await client.query('SELECT u.* FROM livewalk_auth_sessions s JOIN livewalk_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2', [await sha256(token), now()]); return rowToUser(result.rows[0]); }); },
    async logout(token) { if (!token) return; return withDb(env, async (client) => { await client.query('DELETE FROM livewalk_auth_sessions WHERE token_hash=$1', [await sha256(token)]); }); },
    async createRequest(payload, user) { const request = makeRequest(payload, user); await withDb(env, async (client) => { await client.query(`INSERT INTO livewalk_requests (id, traveler_id, guide_id, traveler_name, origin, destination, scheduled_time, duration, language, interests, status, guide, session_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15)`, [request.id, request.travelerId, null, request.travelerName, request.origin, request.destination, request.scheduledTime, request.duration, request.language, JSON.stringify(request.interests), request.status, null, null, request.createdAt, request.updatedAt]); }); return publicRequest(request); },
    async listRequests(status, user) { return withDb(env, async (client) => { let result; if (user.role === 'traveler') result = status ? await client.query('SELECT * FROM livewalk_requests WHERE traveler_id=$1 AND status=$2 ORDER BY created_at DESC', [user.id, status]) : await client.query('SELECT * FROM livewalk_requests WHERE traveler_id=$1 ORDER BY created_at DESC', [user.id]); else result = status ? await client.query('SELECT * FROM livewalk_requests WHERE status=$1 AND (guide_id IS NULL OR guide_id=$2) ORDER BY created_at DESC', [status, user.id]) : await client.query('SELECT * FROM livewalk_requests WHERE guide_id IS NULL OR guide_id=$1 ORDER BY created_at DESC', [user.id]); return result.rows.map(rowToRequest).map(publicRequest); }); },
    async getRequest(requestId, user) { return withDb(env, async (client) => { const req = rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1', [requestId])).rows[0]); if (!canReadRequest(user, req)) return null; let session = null; if (req.sessionId) session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [req.sessionId])).rows[0]); return { request: publicRequest(req), session: publicSession(session) }; }); },
    async acceptRequest(requestId, user) { if (user.role !== 'guide') return null; return withDb(env, async (client) => { await client.query('BEGIN'); try { const req = rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0]); if (!req || (req.guideId && req.guideId !== user.id)) { await client.query('ROLLBACK'); return null; } const guide = makeGuide(user); const sessionId = req.sessionId || id('sess'); const updatedAt = now(); await client.query('UPDATE livewalk_requests SET status=$1, guide_id=$2, guide=$3::jsonb, session_id=$4, updated_at=$5 WHERE id=$6', ['accepted', user.id, JSON.stringify(guide), sessionId, updatedAt, requestId]); await client.query(`INSERT INTO livewalk_sessions (id, request_id, status, started_at, location, created_at, updated_at) VALUES ($1,$2,'ready',NULL,NULL,$3,$3) ON CONFLICT (id) DO NOTHING`, [sessionId, requestId, updatedAt]); const msgId = id('msg'); await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [msgId, sessionId, 'system', 'LiveWalk', `${guide.name} accepted the walk.`, now()]); await client.query('COMMIT'); return this.getRequest(requestId, user); } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } }); },
    async declineRequest(requestId, user) { if (user.role !== 'guide') return null; return withDb(env, async (client) => { const guide = makeGuide(user); const result = await client.query('UPDATE livewalk_requests SET status=$1, guide_id=$2, guide=$3::jsonb, updated_at=$4 WHERE id=$5 RETURNING *', ['declined', user.id, JSON.stringify(guide), now(), requestId]); return publicRequest(rowToRequest(result.rows[0])); }); },
    async getSession(sessionId, user) { return withDb(env, async (client) => { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1', [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req)) return null; const messages = await client.query('SELECT * FROM livewalk_messages WHERE session_id=$1 ORDER BY created_at ASC', [sessionId]); return { session: publicSession(session), messages: messages.rows.map(rowToMessage) }; }); },
    async startSession(sessionId, user) { return withDb(env, async (client) => { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1', [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req)) return null; const updatedAt = now(); await client.query('UPDATE livewalk_sessions SET status=$1, started_at=COALESCE(started_at,$2), updated_at=$2 WHERE id=$3', ['live', updatedAt, sessionId]); await client.query('UPDATE livewalk_requests SET status=$1, updated_at=$2 WHERE id=$3', ['live', updatedAt, session.requestId]); await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id('msg'), sessionId, 'system', 'LiveWalk', 'The live walk session started.', now()]); return this.getSession(sessionId, user); }); },
    async addMessage(sessionId, payload, user) { return withDb(env, async (client) => { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1', [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req)) return null; const message = makeMessage(sessionId, payload, user); await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [message.id, message.sessionId, message.senderRole, message.senderName, message.text, message.createdAt]); return message; }); },
    async setLocation(sessionId, payload, user) { return withDb(env, async (client) => { const session = rowToSession((await client.query('SELECT * FROM livewalk_sessions WHERE id=$1', [sessionId])).rows[0]); const req = session ? rowToRequest((await client.query('SELECT * FROM livewalk_requests WHERE id=$1', [session.requestId])).rows[0]) : null; if (!session || !canUseSession(user, req)) return null; const location = { lat: Number(payload.lat ?? payload.latitude ?? 35.6595), lng: Number(payload.lng ?? payload.longitude ?? 139.7005), label: String(payload.label || 'Guide near Shibuya side street'), progress: Number(payload.progress ?? 48), updatedAt: now() }; const result = await client.query('UPDATE livewalk_sessions SET location=$1::jsonb, updated_at=$2 WHERE id=$3 RETURNING *', [JSON.stringify(location), now(), sessionId]); return publicSession(rowToSession(result.rows[0])); }); },
  };
}

const store = (env) => env?.HYPERDRIVE?.connectionString ? makeDbStore(env) : makeMemoryStore();
async function requireUser(request, storage) { const token = bearerToken(request); const user = await storage.userForToken(token); return { token, user }; }

async function handle(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  const storage = store(env);
  try {
    if (path === '/') return json({ ok: true, service: 'LiveWalk marketplace API', storage: env?.HYPERDRIVE?.connectionString ? 'postgres-auth-demo' : 'edge-memory-demo' });
    if (path === '/api/health') return json({ ok: true, ...(await storage.health()), time: now() });
    if (path === '/api/auth/register' && request.method === 'POST') { try { const result = await storage.registerUser(await body(request)); return json({ ok: true, ...result }, 201); } catch (e) { return bad(e.message); } }
    if (path === '/api/auth/login' && request.method === 'POST') { try { const result = await storage.loginUser(await body(request)); return json({ ok: true, ...result }); } catch (e) { return unauth(e.message); } }
    if (path === '/api/auth/me' && request.method === 'GET') { const { user } = await requireUser(request, storage); if (!user) return unauth(); return json({ ok: true, user: publicUser(user) }); }
    if (path === '/api/auth/logout' && request.method === 'POST') { const { token } = await requireUser(request, storage); await storage.logout(token); return json({ ok: true, loggedOut: true }); }
    if (path === '/api/demo/reset' && request.method === 'POST') { if (env?.HYPERDRIVE?.connectionString && env.ALLOW_DEMO_RESET !== 'true') return json({ ok: false, error: 'Demo reset disabled' }, 403); await storage.reset(); return json({ ok: true, reset: true }); }

    const { user } = await requireUser(request, storage);
    if (!user) return unauth();

    if (path === '/api/requests' && request.method === 'POST') { if (user.role !== 'traveler') return forbidden('Only travelers can create requests'); return json({ ok: true, request: await storage.createRequest(await body(request), user) }, 201); }
    if (path === '/api/requests' && request.method === 'GET') return json({ ok: true, requests: await storage.listRequests(url.searchParams.get('status'), user) });
    if (segments[0] === 'api' && (segments[1] === 'requests' || segments[1] === 'bookings') && segments[2] && request.method === 'GET' && !segments[3]) { const found = await storage.getRequest(segments[2], user); if (!found) return notFound(segments[1] === 'bookings' ? 'Booking not found' : 'Request not found'); return segments[1] === 'bookings' ? json({ ok: true, booking: found.request, session: found.session }) : json({ ok: true, request: found.request, session: found.session }); }
    if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'accept' && request.method === 'POST') { const accepted = await storage.acceptRequest(segments[2], user); if (!accepted) return notFound('Request not found'); return json({ ok: true, request: accepted.request, session: accepted.session }); }
    if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'decline' && request.method === 'POST') { const declined = await storage.declineRequest(segments[2], user); if (!declined) return notFound('Request not found'); return json({ ok: true, request: declined }); }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'start' && request.method === 'POST') { const started = await storage.startSession(segments[2], user); if (!started) return notFound('Session not found'); return json({ ok: true, session: started.session, messages: started.messages }); }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'status' && request.method === 'GET') { const session = await storage.getSession(segments[2], user); if (!session) return notFound('Session not found'); return json({ ok: true, session: session.session, messages: session.messages }); }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'messages') { const session = await storage.getSession(segments[2], user); if (!session) return notFound('Session not found'); if (request.method === 'GET') return json({ ok: true, messages: session.messages }); if (request.method === 'POST') { try { return json({ ok: true, message: await storage.addMessage(segments[2], await body(request), user) }, 201); } catch (error) { return bad(error.message); } } }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'location' && request.method === 'POST') { const session = await storage.setLocation(segments[2], await body(request), user); if (!session) return notFound('Session not found'); return json({ ok: true, session }); }
    return notFound();
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Backend error' }, 500);
  }
}

export default { fetch: handle };
export { handle };
