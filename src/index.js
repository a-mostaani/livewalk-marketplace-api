import { now, publicUser, validDemoKey, productionStorage, body, seedDemo } from './domain.js';
import { store, requireUser } from './store.js';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-demo-key',
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
    if (path === '/api/demo/reset' && request.method === 'POST') {
      const protectedReset = productionStorage(env);
      if (protectedReset && !validDemoKey(request, env)) return json({ ok: false, error: 'Demo reset disabled' }, 403);
      const payload = await body(request);
      if (payload.seed === true) return json({ ok: true, reset: true, demo: await seedDemo(storage) });
      await storage.reset();
      return json({ ok: true, reset: true });
    }
    if (path === '/api/demo/seed' && request.method === 'POST') {
      if (productionStorage(env) && !validDemoKey(request, env)) return json({ ok: false, error: 'Demo seed disabled' }, 403);
      return json({ ok: true, reset: true, demo: await seedDemo(storage) });
    }

    const { user } = await requireUser(request, storage);
    if (!user) return unauth();

    if (path === '/api/requests' && request.method === 'POST') { if (user.role !== 'traveler') return forbidden('Only travelers can create requests'); return json({ ok: true, request: await storage.createRequest(await body(request), user) }, 201); }
    if (path === '/api/requests' && request.method === 'GET') return json({ ok: true, requests: await storage.listRequests(url.searchParams.get('status'), user) });
    if (segments[0] === 'api' && (segments[1] === 'requests' || segments[1] === 'bookings') && segments[2] && request.method === 'GET' && !segments[3]) { const found = await storage.getRequest(segments[2], user); if (!found) return notFound(segments[1] === 'bookings' ? 'Booking not found' : 'Request not found'); return segments[1] === 'bookings' ? json({ ok: true, booking: found.request, session: found.session }) : json({ ok: true, request: found.request, session: found.session }); }
    if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'accept' && request.method === 'POST') { const accepted = await storage.acceptRequest(segments[2], user); if (!accepted) return notFound('Request not found'); return json({ ok: true, request: accepted.request, session: accepted.session }); }
    if (segments[0] === 'api' && segments[1] === 'requests' && segments[2] && segments[3] === 'decline' && request.method === 'POST') { const declined = await storage.declineRequest(segments[2], user); if (!declined) return notFound('Request not found'); return json({ ok: true, request: declined }); }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'start' && request.method === 'POST') { if (user.role !== 'guide') return forbidden('Only the guide can start the live session'); const started = await storage.startSession(segments[2], user); if (!started) return notFound('Session not found'); return json({ ok: true, session: started.session, messages: started.messages }); }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'status' && request.method === 'GET') { const session = await storage.getSession(segments[2], user); if (!session) return notFound('Session not found'); return json({ ok: true, session: session.session, messages: session.messages }); }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'messages') { const session = await storage.getSession(segments[2], user); if (!session) return notFound('Session not found'); if (request.method === 'GET') return json({ ok: true, messages: session.messages }); if (request.method === 'POST') { try { return json({ ok: true, message: await storage.addMessage(segments[2], await body(request), user) }, 201); } catch (error) { return bad(error.message); } } }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] && segments[3] === 'location' && request.method === 'POST') { try { const session = await storage.setLocation(segments[2], await body(request), user); if (!session) return notFound('Session not found'); return json({ ok: true, session }); } catch (error) { return bad(error.message); } }
    return notFound();
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Backend error' }, 500);
  }
}

export default { fetch: handle };
export { handle };
