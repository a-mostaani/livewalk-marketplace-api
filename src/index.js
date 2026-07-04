const memory = globalThis.__LIVEWALK_STATE__ ??= {
  requests: new Map(),
  sessions: new Map(),
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
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const cleanList = (value) => Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 12) : [];
const route = (request) => `${request.origin} → ${request.destination}`;
const publicRequest = (request) => request ? { ...request, route: route(request) } : null;
const publicSession = (session) => session ? { ...session } : null;
const newestFirst = (items) => [...items].sort((a, b) => String(b.createdAt || b.updatedAt).localeCompare(String(a.createdAt || a.updatedAt)));

async function body(request) {
  if (request.method === 'GET') return {};
  try { return await request.json(); } catch { return {}; }
}

function makeRequest(payload) {
  const createdAt = now();
  return {
    id: id('req'),
    travelerName: String(payload.travelerName || 'Sofia R.'),
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

function makeMessage(sessionId, payload) {
  const text = String(payload.text || '').trim();
  if (!text) throw new Error('Message text is required');
  return {
    id: id('msg'),
    sessionId,
    senderRole: String(payload.senderRole || payload.role || 'traveler'),
    senderName: String(payload.senderName || payload.name || 'Traveler'),
    text: text.slice(0, 1000),
    createdAt: now(),
  };
}

function makeGuide(payload) {
  return {
    id: String(payload.guideId || 'guide_yuki'),
    name: String(payload.guideName || 'Yuki Tanaka'),
    avatar: String(payload.guideAvatar || 'YT'),
  };
}

function memoryStore() {
  return {
    async health() { return { backend: 'edge-memory-demo', requests: memory.requests.size, sessions: memory.sessions.size }; },
    async reset() { memory.requests.clear(); memory.sessions.clear(); memory.messages.clear(); },
    async createRequest(payload) {
      const request = makeRequest(payload);
      memory.requests.set(request.id, request);
      return publicRequest(request);
    },
    async listRequests(status) {
      return newestFirst([...memory.requests.values()].filter((item) => !status || item.status === status)).map(publicRequest);
    },
    async getRequest(requestId) {
      const request = memory.requests.get(requestId);
      if (!request) return null;
      return { request: publicRequest(request), session: request.sessionId ? publicSession(memory.sessions.get(request.sessionId)) : null };
    },
    async acceptRequest(requestId, payload) {
      const request = memory.requests.get(requestId);
      if (!request) return null;
      const sessionId = request.sessionId || id('sess');
      request.status = 'accepted';
      request.guide = makeGuide(payload);
      request.sessionId = sessionId;
      request.updatedAt = now();
      memory.sessions.set(sessionId, memory.sessions.get(sessionId) ?? { id: sessionId, requestId, status: 'ready', startedAt: null, location: null, createdAt: now(), updatedAt: now() });
      await this.addMessage(sessionId, { senderRole: 'system', senderName: 'LiveWalk', text: `${request.guide.name} accepted the walk.` });
      return { request: publicRequest(request), session: publicSession(memory.sessions.get(sessionId)) };
    },
    async declineRequest(requestId, payload) {
      const request = memory.requests.get(requestId);
      if (!request) return null;
      request.status = 'declined';
      request.guide = makeGuide(payload);
      request.updatedAt = now();
      return publicRequest(request);
    },
    async getSession(sessionId) {
      const session = memory.sessions.get(sessionId);
      if (!session) return null;
      return { session: publicSession(session), messages: memory.messages.get(sessionId) ?? [] };
    },
    async startSession(sessionId) {
      const session = memory.sessions.get(sessionId);
      if (!session) return null;
      session.status = 'live';
      session.startedAt ||= now();
      session.updatedAt = now();
      const request = memory.requests.get(session.requestId);
      if (request) { request.status = 'live'; request.updatedAt = now(); }
      await this.addMessage(sessionId, { senderRole: 'system', senderName: 'LiveWalk', text: 'The live walk session started.' });
      return { session: publicSession(session), messages: memory.messages.get(sessionId) ?? [] };
    },
    async addMessage(sessionId, payload) {
      if (!memory.sessions.has(sessionId)) return null;
      const message = makeMessage(sessionId, payload);
      const list = memory.messages.get(sessionId) ?? [];
      list.push(message);
      memory.messages.set(sessionId, list);
      return message;
    },
    async setLocation(sessionId, payload) {
      const session = memory.sessions.get(sessionId);
      if (!session) return null;
      session.location = { lat: Number(payload.lat ?? payload.latitude ?? 35.6595), lng: Number(payload.lng ?? payload.longitude ?? 139.7005), label: String(payload.label || 'Guide near Shibuya side street'), progress: Number(payload.progress ?? 48), updatedAt: now() };
      session.updatedAt = now();
      return publicSession(session);
    },
  };
}

function rowToRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    travelerName: row.traveler_name,
    origin: row.origin,
    destination: row.destination,
    scheduledTime: row.scheduled_time,
    duration: row.duration,
    language: row.language,
    interests: Array.isArray(row.interests) ? row.interests : [],
    status: row.status,
    guide: row.guide || null,
    sessionId: row.session_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row) {
  if (!row) return null;
  return { id: row.id, requestId: row.request_id, status: row.status, startedAt: row.started_at, location: row.location || null, createdAt: row.created_at, updatedAt: row.updated_at };
}

function rowToMessage(row) {
  return { id: row.id, sessionId: row.session_id, senderRole: row.sender_role, senderName: row.sender_name, text: row.text, createdAt: row.created_at };
}

async function connectDb(env) {
  if (!PgClient) ({ Client: PgClient } = await import('pg'));
  const client = new PgClient({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  if (!schemaReady) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS livewalk_requests (
        id TEXT PRIMARY KEY,
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
      CREATE INDEX IF NOT EXISTS livewalk_requests_status_created_idx ON livewalk_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS livewalk_messages_session_created_idx ON livewalk_messages(session_id, created_at ASC);
    `);
    schemaReady = true;
  }
  return client;
}

async function withDb(env, fn) {
  const client = await connectDb(env);
  try { return await fn(client); }
  finally { await client.end().catch(() => {}); }
}

function dbStore(env) {
  return {
    async health() {
      return withDb(env, async (client) => {
        const requests = await client.query('SELECT COUNT(*)::int AS count FROM livewalk_requests');
        const sessions = await client.query('SELECT COUNT(*)::int AS count FROM livewalk_sessions');
        return { backend: 'postgres-shared-demo', requests: requests.rows[0].count, sessions: sessions.rows[0].count };
      });
    },
    async reset() {
      return withDb(env, async (client) => { await client.query('TRUNCATE livewalk_messages, livewalk_sessions, livewalk_requests'); });
    },
    async createRequest(payload) {
      const request = makeRequest(payload);
      await withDb(env, async (client) => {
        await client.query(
          `INSERT INTO livewalk_requests (id, traveler_name, origin, destination, scheduled_time, duration, language, interests, status, guide, session_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13)`,
          [request.id, request.travelerName, request.origin, request.destination, request.scheduledTime, request.duration, request.language, JSON.stringify(request.interests), request.status, null, null, request.createdAt, request.updatedAt]
        );
      });
      return publicRequest(request);
    },
    async listRequests(status) {
      return withDb(env, async (client) => {
        const result = status
          ? await client.query('SELECT * FROM livewalk_requests WHERE status = $1 ORDER BY created_at DESC', [status])
          : await client.query('SELECT * FROM livewalk_requests ORDER BY created_at DESC');
        return result.rows.map(rowToRequest).map(publicRequest);
      });
    },
    async getRequest(requestId) {
      return withDb(env, async (client) => {
        const result = await client.query('SELECT * FROM livewalk_requests WHERE id = $1', [requestId]);
        const request = rowToRequest(result.rows[0]);
        if (!request) return null;
        let session = null;
        if (request.sessionId) {
          const sessionResult = await client.query('SELECT * FROM livewalk_sessions WHERE id = $1', [request.sessionId]);
          session = rowToSession(sessionResult.rows[0]);
        }
        return { request: publicRequest(request), session: publicSession(session) };
      });
    },
    async acceptRequest(requestId, payload) {
      return withDb(env, async (client) => {
        await client.query('BEGIN');
        try {
          const found = await client.query('SELECT * FROM livewalk_requests WHERE id = $1 FOR UPDATE', [requestId]);
          const request = rowToRequest(found.rows[0]);
          if (!request) { await client.query('ROLLBACK'); return null; }
          const guide = makeGuide(payload);
          const sessionId = request.sessionId || id('sess');
          const updatedAt = now();
          await client.query('UPDATE livewalk_requests SET status=$1, guide=$2::jsonb, session_id=$3, updated_at=$4 WHERE id=$5', ['accepted', JSON.stringify(guide), sessionId, updatedAt, requestId]);
          await client.query(
            `INSERT INTO livewalk_sessions (id, request_id, status, started_at, location, created_at, updated_at)
             VALUES ($1,$2,'ready',NULL,NULL,$3,$3)
             ON CONFLICT (id) DO NOTHING`,
            [sessionId, requestId, updatedAt]
          );
          const message = makeMessage(sessionId, { senderRole: 'system', senderName: 'LiveWalk', text: `${guide.name} accepted the walk.` });
          await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [message.id, message.sessionId, message.senderRole, message.senderName, message.text, message.createdAt]);
          await client.query('COMMIT');
          const updated = await this.getRequest(requestId);
          return updated;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
    },
    async declineRequest(requestId, payload) {
      return withDb(env, async (client) => {
        const guide = makeGuide(payload);
        const result = await client.query('UPDATE livewalk_requests SET status=$1, guide=$2::jsonb, updated_at=$3 WHERE id=$4 RETURNING *', ['declined', JSON.stringify(guide), now(), requestId]);
        return publicRequest(rowToRequest(result.rows[0]));
      });
    },
    async getSession(sessionId) {
      return withDb(env, async (client) => {
        const sessionResult = await client.query('SELECT * FROM livewalk_sessions WHERE id = $1', [sessionId]);
        const session = rowToSession(sessionResult.rows[0]);
        if (!session) return null;
        const messageResult = await client.query('SELECT * FROM livewalk_messages WHERE session_id = $1 ORDER BY created_at ASC', [sessionId]);
        return { session: publicSession(session), messages: messageResult.rows.map(rowToMessage) };
      });
    },
    async startSession(sessionId) {
      return withDb(env, async (client) => {
        await client.query('BEGIN');
        try {
          const sessionResult = await client.query('SELECT * FROM livewalk_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
          const session = rowToSession(sessionResult.rows[0]);
          if (!session) { await client.query('ROLLBACK'); return null; }
          const updatedAt = now();
          await client.query('UPDATE livewalk_sessions SET status=$1, started_at=COALESCE(started_at,$2), updated_at=$2 WHERE id=$3', ['live', updatedAt, sessionId]);
          await client.query('UPDATE livewalk_requests SET status=$1, updated_at=$2 WHERE id=$3', ['live', updatedAt, session.requestId]);
          const message = makeMessage(sessionId, { senderRole: 'system', senderName: 'LiveWalk', text: 'The live walk session started.' });
          await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [message.id, message.sessionId, message.senderRole, message.senderName, message.text, message.createdAt]);
          await client.query('COMMIT');
          return this.getSession(sessionId);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
    },
    async addMessage(sessionId, payload) {
      return withDb(env, async (client) => {
        const session = await client.query('SELECT id FROM livewalk_sessions WHERE id = $1', [sessionId]);
        if (!session.rows[0]) return null;
        const message = makeMessage(sessionId, payload);
        await client.query('INSERT INTO livewalk_messages (id, session_id, sender_role, sender_name, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [message.id, message.sessionId, message.senderRole, message.senderName, message.text, message.createdAt]);
        return message;
      });
    },
    async setLocation(sessionId, payload) {
      return withDb(env, async (client) => {
        const location = { lat: Number(payload.lat ?? payload.latitude ?? 35.6595), lng: Number(payload.lng ?? payload.longitude ?? 139.7005), label: String(payload.label || 'Guide near Shibuya side street'), progress: Number(payload.progress ?? 48), updatedAt: now() };
        const result = await client.query('UPDATE livewalk_sessions SET location=$1::jsonb, updated_at=$2 WHERE id=$3 RETURNING *', [JSON.stringify(location), now(), sessionId]);
        return publicSession(rowToSession(result.rows[0]));
      });
    },
  };
}

function store(env) {
  return env?.HYPERDRIVE?.connectionString ? dbStore(env) : memoryStore();
}

async function handle(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  const storage = store(env);

  try {
    if (path === '/') return json({ ok: true, service: 'LiveWalk marketplace API', storage: env?.HYPERDRIVE?.connectionString ? 'postgres-shared-demo' : 'edge-memory-demo', endpoints: ['/api/health', '/api/requests'] });
    if (path === '/api/health') return json({ ok: true, ...(await storage.health()), time: now() });
    if (path === '/api/demo/reset' && request.method === 'POST') { await storage.reset(); return json({ ok: true, reset: true }); }
    if (path === '/api/requests' && request.method === 'POST') return json({ ok: true, request: await storage.createRequest(await body(request)) }, 201);
    if (path === '/api/requests' && request.method === 'GET') return json({ ok: true, requests: await storage.listRequests(url.searchParams.get('status')) });
    if (segments[0] === 'api' && (segments[1] === 'requests' || segments[1] === 'bookings') && segments[2] && request.method === 'GET' && !segments[3]) {
      const found = await storage.getRequest(segments[2]);
      if (!found) return notFound(segments[1] === 'bookings' ? 'Booking not found' : 'Request not found');
      return segments[1] === 'bookings' ? json({ ok: true, booking: found.request, session: found.session }) : json({ ok: true, request: found.request, session: found.session });
    }
    if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'accept' && request.method === 'POST') {
      const accepted = await storage.acceptRequest(segments[2], await body(request));
      if (!accepted) return notFound('Request not found');
      return json({ ok: true, request: accepted.request, session: accepted.session });
    }
    if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'decline' && request.method === 'POST') {
      const declined = await storage.declineRequest(segments[2], await body(request));
      if (!declined) return notFound('Request not found');
      return json({ ok: true, request: declined });
    }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'start' && request.method === 'POST') {
      const started = await storage.startSession(segments[2]);
      if (!started) return notFound('Session not found');
      return json({ ok: true, session: started.session, messages: started.messages });
    }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'status' && request.method === 'GET') {
      const session = await storage.getSession(segments[2]);
      if (!session) return notFound('Session not found');
      return json({ ok: true, session: session.session, messages: session.messages });
    }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'messages') {
      const session = await storage.getSession(segments[2]);
      if (!session) return notFound('Session not found');
      if (request.method === 'GET') return json({ ok: true, messages: session.messages });
      if (request.method === 'POST') {
        try { return json({ ok: true, message: await storage.addMessage(segments[2], await body(request)) }, 201); }
        catch (error) { return bad(error.message); }
      }
    }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'location' && request.method === 'POST') {
      const session = await storage.setLocation(segments[2], await body(request));
      if (!session) return notFound('Session not found');
      return json({ ok: true, session });
    }
    return notFound();
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Backend error' }, 500);
  }
}

export default { fetch: handle };
export { handle };
