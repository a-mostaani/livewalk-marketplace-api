import { now, publicUser, productionStorage, demoSeedPassword, body, seedDemo, computeRequestEstimate } from './domain.js';
import { store, requireUser } from './store.js';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-demo-key',
  'access-control-max-age': '86400',
};

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
});
const notFound = (message = 'Not found') => json({ ok: false, error: message }, 404);
const bad = (message) => json({ ok: false, error: message }, 400);
const forbidden = (message = 'Not authorized') => json({ ok: false, error: message }, 403);
const conflict = (message) => json({ ok: false, error: message }, 409);
const unauth = (message = 'Login required') => json({ ok: false, error: message }, 401);

function parseRoute(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  return { url, path, segments: path.split('/').filter(Boolean) };
}

async function handlePublicRoutes(request, env, storage, path) {
  if (path === '/') return json({ ok: true, service: 'LiveWalk marketplace API', storage: env?.HYPERDRIVE?.connectionString ? 'postgres-auth-demo' : 'edge-memory-demo' });
  if (path === '/api/health') return json({ ok: true, ...(await storage.health()), time: now() });
  if (path === '/api/auth/register' && request.method === 'POST') {
    try { return json({ ok: true, ...(await storage.registerUser(await body(request))) }, 201); }
    catch (error) { return bad(error.message); }
  }
  if (path === '/api/auth/login' && request.method === 'POST') {
    try { return json({ ok: true, ...(await storage.loginUser(await body(request))) }); }
    catch (error) { return unauth(error.message); }
  }
  return null;
}

async function handleDemoRoutes(request, env, storage, path) {
  if (path === '/api/demo/reset' && request.method === 'POST') {
    if (productionStorage(env)) return forbidden('Demo reset disabled');
    const payload = await body(request);
    if (payload.seed === true) {
      const password = demoSeedPassword(env);
      if (!password) return bad('Demo seed password is not configured');
      return json({ ok: true, reset: true, demo: await seedDemo(storage, password) });
    }
    await storage.reset();
    return json({ ok: true, reset: true });
  }
  if (path === '/api/demo/seed' && request.method === 'POST') {
    if (productionStorage(env)) return forbidden('Demo seed disabled');
    const password = demoSeedPassword(env);
    if (!password) return bad('Demo seed password is not configured');
    return json({ ok: true, reset: true, demo: await seedDemo(storage, password) });
  }
  return null;
}

function logUnexpectedError(correlationId, error) {
  const detail = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
  console.error('LiveWalk backend error', { correlationId, detail });
}

async function handleAuthRoutes(request, storage, path) {
  if (path === '/api/auth/me' && request.method === 'GET') {
    const { user } = await requireUser(request, storage);
    if (!user) return unauth();
    return json({ ok: true, user: publicUser(user) });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const { token } = await requireUser(request, storage);
    await storage.logout(token);
    return json({ ok: true, loggedOut: true });
  }
  return null;
}

async function handleRequestRoutes(request, storage, url, path, segments, user) {
  if (path === '/api/requests/estimate' && request.method === 'POST') {
    if (user.role !== 'traveler') return forbidden('Only travelers can estimate requests');
    try { return json({ ok: true, estimate: computeRequestEstimate(await body(request)) }); }
    catch (error) { return bad(error.message); }
  }
  if (path === '/api/requests' && request.method === 'POST') {
    if (user.role !== 'traveler') return forbidden('Only travelers can create requests');
    try { return json({ ok: true, request: await storage.createRequest(await body(request), user) }, 201); }
    catch (error) { return bad(error.message); }
  }
  if (path === '/api/requests' && request.method === 'GET') {
    return json({ ok: true, requests: await storage.listRequests(url.searchParams.get('status'), user) });
  }
  if (segments[0] === 'api' && (segments[1] === 'requests' || segments[1] === 'bookings') && segments[2] && request.method === 'GET' && !segments[3]) {
    const found = await storage.getRequest(segments[2], user);
    if (!found) return notFound(segments[1] === 'bookings' ? 'Booking not found' : 'Request not found');
    return segments[1] === 'bookings' ? json({ ok: true, booking: found.request, session: found.session }) : json({ ok: true, request: found.request, session: found.session });
  }
  if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'accept' && request.method === 'POST') {
    const accepted = await storage.acceptRequest(segments[2], user);
    if (!accepted) return notFound('Request not found');
    return json({ ok: true, request: accepted.request, session: accepted.session });
  }
  if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'decline' && request.method === 'POST') {
    try {
      const declined = await storage.declineRequest(segments[2], user);
      if (!declined) return notFound('Request not found');
      return json({ ok: true, request: declined });
    } catch (error) {
      if (error?.code === 'REQUEST_NOT_PENDING') return conflict(error.message);
      throw error;
    }
  }
  return null;
}

async function handleSessionRoutes(request, storage, segments, user) {
  if (segments[0] !== 'api' || segments[1] !== 'sessions' || !segments[2]) return null;
  const sessionId = segments[2];
  if (segments[3] === 'start' && request.method === 'POST') {
    if (user.role !== 'guide') return forbidden('Only the guide can start the live session');
    const started = await storage.startSession(sessionId, user);
    if (!started) return notFound('Session not found');
    return json({ ok: true, session: started.session, messages: started.messages });
  }
  if (segments[3] === 'end' && request.method === 'POST') {
    const ended = await storage.endSession(sessionId, user);
    if (!ended) return notFound('Session not found');
    return json({ ok: true, session: ended.session, messages: ended.messages });
  }
  if (segments[3] === 'status' && request.method === 'GET') {
    const session = await storage.getSession(sessionId, user);
    if (!session) return notFound('Session not found');
    return json({ ok: true, session: session.session, messages: session.messages });
  }
  if (segments[3] === 'messages') {
    const session = await storage.getSession(sessionId, user);
    if (!session) return notFound('Session not found');
    if (request.method === 'GET') return json({ ok: true, messages: session.messages });
    if (request.method === 'POST') {
      try { return json({ ok: true, message: await storage.addMessage(sessionId, await body(request), user) }, 201); }
      catch (error) { return bad(error.message); }
    }
  }
  if (segments[3] === 'location' && request.method === 'POST') {
    try {
      const session = await storage.setLocation(sessionId, await body(request), user);
      if (!session) return notFound('Session not found');
      return json({ ok: true, session });
    } catch (error) { return bad(error.message); }
  }
  return null;
}

async function handleApiRequest(request, env = {}) {
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { url, path, segments } = parseRoute(request);
    const storage = store(env);
    const publicResponse = await handlePublicRoutes(request, env, storage, path);
    if (publicResponse) return publicResponse;
    const demoResponse = await handleDemoRoutes(request, env, storage, path);
    if (demoResponse) return demoResponse;
    const authResponse = await handleAuthRoutes(request, storage, path);
    if (authResponse) return authResponse;

    const { user } = await requireUser(request, storage);
    if (!user) return unauth();

    const requestResponse = await handleRequestRoutes(request, storage, url, path, segments, user);
    if (requestResponse) return requestResponse;
    const sessionResponse = await handleSessionRoutes(request, storage, segments, user);
    if (sessionResponse) return sessionResponse;
    return notFound();
  } catch (error) {
    const correlationId = crypto.randomUUID();
    logUnexpectedError(correlationId, error);
    return json({ ok: false, error: 'Backend error', correlationId }, 500);
  }
}

export { cors, handleApiRequest };
