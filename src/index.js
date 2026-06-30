const state = globalThis.__LIVEWALK_STATE__ ??= {
  requests: new Map(),
  sessions: new Map(),
  messages: new Map(),
};

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

async function body(request) {
  if (request.method === 'GET') return {};
  try { return await request.json(); } catch { return {}; }
}

function publicRequest(request) {
  return { ...request, route: route(request) };
}

function newestFirst(items) {
  return [...items].sort((a, b) => String(b.createdAt || b.updatedAt).localeCompare(String(a.createdAt || a.updatedAt)));
}

function createRequest(payload) {
  const request = {
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
    createdAt: now(),
    updatedAt: now(),
  };
  state.requests.set(request.id, request);
  return publicRequest(request);
}

function addMessage(sessionId, payload) {
  const text = String(payload.text || '').trim();
  if (!text) throw new Error('Message text is required');
  const message = {
    id: id('msg'),
    sessionId,
    senderRole: String(payload.senderRole || payload.role || 'traveler'),
    senderName: String(payload.senderName || payload.name || 'Traveler'),
    text: text.slice(0, 1000),
    createdAt: now(),
  };
  const list = state.messages.get(sessionId) ?? [];
  list.push(message);
  state.messages.set(sessionId, list);
  return message;
}

function acceptRequest(requestId, payload) {
  const request = state.requests.get(requestId);
  if (!request) return null;
  const sessionId = request.sessionId || id('sess');
  request.status = 'accepted';
  request.guide = {
    id: String(payload.guideId || 'guide_yuki'),
    name: String(payload.guideName || 'Yuki Tanaka'),
    avatar: String(payload.guideAvatar || 'YT'),
  };
  request.sessionId = sessionId;
  request.updatedAt = now();
  state.sessions.set(sessionId, state.sessions.get(sessionId) ?? {
    id: sessionId,
    requestId,
    status: 'ready',
    startedAt: null,
    location: null,
    createdAt: now(),
    updatedAt: now(),
  });
  addMessage(sessionId, { senderRole: 'system', senderName: 'LiveWalk', text: `${request.guide.name} accepted the walk.` });
  return publicRequest(request);
}

function declineRequest(requestId, payload) {
  const request = state.requests.get(requestId);
  if (!request) return null;
  request.status = 'declined';
  request.guide = {
    id: String(payload.guideId || 'guide_yuki'),
    name: String(payload.guideName || 'Yuki Tanaka'),
    avatar: String(payload.guideAvatar || 'YT'),
  };
  request.updatedAt = now();
  return publicRequest(request);
}

function startSession(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) return null;
  session.status = 'live';
  session.startedAt ||= now();
  session.updatedAt = now();
  const request = state.requests.get(session.requestId);
  if (request) {
    request.status = 'live';
    request.updatedAt = now();
  }
  addMessage(sessionId, { senderRole: 'system', senderName: 'LiveWalk', text: 'The live walk session started.' });
  return session;
}

function setLocation(sessionId, payload) {
  const session = state.sessions.get(sessionId);
  if (!session) return null;
  session.location = {
    lat: Number(payload.lat ?? payload.latitude ?? 35.6595),
    lng: Number(payload.lng ?? payload.longitude ?? 139.7005),
    label: String(payload.label || 'Guide near Shibuya side street'),
    progress: Number(payload.progress ?? 48),
    updatedAt: now(),
  };
  session.updatedAt = now();
  return session;
}

async function handle(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const segments = path.split('/').filter(Boolean);

  if (path === '/') return json({ ok: true, service: 'LiveWalk marketplace API', storage: 'edge-memory-demo', endpoints: ['/api/health', '/api/requests'] });
  if (path === '/api/health') return json({ ok: true, backend: 'edge-memory-demo', requests: state.requests.size, sessions: state.sessions.size, time: now() });
  if (path === '/api/demo/reset' && request.method === 'POST') {
    state.requests.clear(); state.sessions.clear(); state.messages.clear();
    return json({ ok: true, reset: true });
  }
  if (path === '/api/requests' && request.method === 'POST') {
    return json({ ok: true, request: createRequest(await body(request)) }, 201);
  }
  if (path === '/api/requests' && request.method === 'GET') {
    const status = url.searchParams.get('status');
    const requests = newestFirst([...state.requests.values()].filter((item) => !status || item.status === status)).map(publicRequest);
    return json({ ok: true, requests });
  }
  if (segments[0] === 'api' && (segments[1] === 'requests' || segments[1] === 'bookings') && segments[2] && request.method === 'GET') {
    const walkRequest = state.requests.get(segments[2]);
    if (!walkRequest) return notFound(segments[1] === 'bookings' ? 'Booking not found' : 'Request not found');
    const session = walkRequest.sessionId ? state.sessions.get(walkRequest.sessionId) : null;
    return segments[1] === 'bookings'
      ? json({ ok: true, booking: publicRequest(walkRequest), session })
      : json({ ok: true, request: publicRequest(walkRequest), session });
  }
  if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'accept' && request.method === 'POST') {
    const walkRequest = acceptRequest(segments[2], await body(request));
    if (!walkRequest) return notFound('Request not found');
    return json({ ok: true, request: walkRequest, session: state.sessions.get(walkRequest.sessionId) });
  }
  if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'decline' && request.method === 'POST') {
    const walkRequest = declineRequest(segments[2], await body(request));
    if (!walkRequest) return notFound('Request not found');
    return json({ ok: true, request: walkRequest });
  }
  if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'start' && request.method === 'POST') {
    const session = startSession(segments[2]);
    if (!session) return notFound('Session not found');
    return json({ ok: true, session, messages: state.messages.get(session.id) ?? [] });
  }
  if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'status' && request.method === 'GET') {
    const session = state.sessions.get(segments[2]);
    if (!session) return notFound('Session not found');
    return json({ ok: true, session, messages: state.messages.get(session.id) ?? [] });
  }
  if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'messages') {
    const session = state.sessions.get(segments[2]);
    if (!session) return notFound('Session not found');
    if (request.method === 'GET') return json({ ok: true, messages: state.messages.get(session.id) ?? [] });
    if (request.method === 'POST') {
      try { return json({ ok: true, message: addMessage(session.id, await body(request)) }, 201); }
      catch (error) { return bad(error.message); }
    }
  }
  if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'location' && request.method === 'POST') {
    const session = setLocation(segments[2], await body(request));
    if (!session) return notFound('Session not found');
    return json({ ok: true, session });
  }
  return notFound();
}

export default { fetch: handle };
export { handle };
