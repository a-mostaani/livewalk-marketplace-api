const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const cleanList = (value) => Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 12) : [];
const route = (request) => `${request.origin?.label || 'Start'} → ${request.destination?.label || 'Destination'}`;
const normalizeCity = (value) => {
  const city = String(value || '').trim().toLowerCase();
  if (city === 'london') return 'London';
  if (city === 'toronto') return 'Toronto';
  return 'other';
};
const cityForPoint = (point) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'other';
  if (lat >= 51.28 && lat <= 51.7 && lng >= -0.55 && lng <= 0.33) return 'London';
  if (lat >= 43.55 && lat <= 43.85 && lng >= -79.65 && lng <= -79.1) return 'Toronto';
  return 'other';
};
const publicUser = (user) => user ? { id: user.id, email: user.email, name: user.name, role: user.role, city: normalizeCity(user.city), createdAt: user.createdAt } : null;
const displayName = (value, fallback) => String(value || '').trim() || fallback;
const publicRequest = (request) => request ? { ...request, travelerName: displayName(request.travelerName, 'Traveler'), route: route(request), travelerId: undefined, guideId: undefined } : null;
const coarsePoint = (point) => point ? { ...point, lat: Number(Number(point.lat).toFixed(2)), lng: Number(Number(point.lng).toFixed(2)) } : point;
const coarseTravelerName = (value) => {
  const parts = displayName(value, 'Traveler').split(/\s+/);
  const initial = Array.from(parts.slice(1).join('')).find((character) => /[\p{L}\p{N}]/u.test(character));
  return initial ? `${parts[0]} ${initial.toUpperCase()}.` : parts[0];
};
const coarseRequest = (request) => {
  const response = publicRequest(request);
  return response ? { ...response, travelerName: coarseTravelerName(response.travelerName), origin: coarsePoint(response.origin), destination: coarsePoint(response.destination) } : null;
};
const publicRequestForUser = (request, user) => user?.role === 'guide' && request?.guideId !== user.id ? coarseRequest(request) : publicRequest(request);
const publicSession = (session) => session ? { ...session } : null;
const newestFirst = (items) => [...items].sort((a, b) => String(b.createdAt || b.updatedAt).localeCompare(String(a.createdAt || a.updatedAt)));
const TOKEN_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;
const DEMO_TRAVELER = {
  role: 'traveler',
  name: 'Sofia Ramirez',
  email: 'demo.traveler@livewalk.test',
};
const DEMO_GUIDE = {
  role: 'guide',
  name: 'Yuki Tanaka',
  email: 'demo.guide@livewalk.test',
};
const DEMO_REQUEST = {
  origin: { label: 'Shibuya Station Hachiko Gate', lat: 35.6591, lng: 139.7005 },
  destination: { label: 'Meiji Shrine forest entrance', lat: 35.6764, lng: 139.6993 },
  scheduledStart: '2026-07-10T10:30:00+09:00',
  durationMinutes: 45,
  language: 'English',
  interests: ['Hidden corners', 'Food stops', 'Photo moments'],
};

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

function productionStorage(env) {
  return Boolean(env?.HYPERDRIVE?.connectionString);
}

function demoSeedPassword(env) {
  const password = String(env?.DEMO_SEED_PASSWORD || '').trim();
  return password || null;
}

const LIVEKIT_TOKEN_TTL_SECONDS = 600;

function livekitConfig(env) {
  const apiKey = String(env?.LIVEKIT_API_KEY || '').trim();
  const apiSecret = String(env?.LIVEKIT_API_SECRET || '').trim();
  const wsUrl = String(env?.LIVEKIT_URL || env?.LIVEKIT_WS_URL || '').trim();
  if (!apiKey || !apiSecret || !wsUrl) return null;
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== 'wss:') return null;
  } catch {
    return null;
  }
  return { apiKey, apiSecret, wsUrl };
}

function base64UrlFromBytes(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlFromString(value) {
  return base64UrlFromBytes(new TextEncoder().encode(value));
}

async function signLivekitToken(apiSecret, payload) {
  const encodedHeader = base64UrlFromString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encodedPayload = base64UrlFromString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64UrlFromBytes(signature)}`;
}

async function makeLivekitToken({ apiKey, apiSecret, sessionId, roomName, identity, name, role, canPublishSources }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    iss: apiKey,
    sub: identity,
    name,
    jti: crypto.randomUUID(),
    metadata: JSON.stringify({ sessionId, role }),
    iat: issuedAt,
    nbf: issuedAt - 10,
    exp: issuedAt + LIVEKIT_TOKEN_TTL_SECONDS,
    video: {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishSources,
    },
  };
  return signLivekitToken(apiSecret, payload);
}

async function body(request) {
  if (request.method === 'GET') return {};
  try { return await request.json(); } catch { return {}; }
}

function parsePoint(value) {
  if (!value || typeof value !== 'object') return null;
  const label = displayName(value.label || value.name || value.address, '');
  const lat = Number(value.lat ?? value.latitude);
  const lng = Number(value.lng ?? value.longitude);
  if (!label || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  return { label, lat, lng };
}

const ISO_SCHEDULED_START = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function parseDurationMinutes(payload = {}) {
  const value = payload.durationMinutes ?? payload.duration_minutes;
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error('durationMinutes is required');
  }
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new Error('durationMinutes must be a positive whole number');
  }
  return minutes;
}

function parseScheduledStart(payload = {}) {
  const value = String(payload.scheduledStart ?? payload.scheduled_start ?? '').trim();
  const match = value.match(ISO_SCHEDULED_START);
  if (!match) throw new Error('scheduledStart must be an ISO-8601 timestamp with a timezone');

  const [, year, month, day, hour, minute, second = '0', fraction = '0'] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0'))));
  if (
    calendar.getUTCFullYear() !== Number(year)
    || calendar.getUTCMonth() !== Number(month) - 1
    || calendar.getUTCDate() !== Number(day)
    || calendar.getUTCHours() !== Number(hour)
    || calendar.getUTCMinutes() !== Number(minute)
    || calendar.getUTCSeconds() !== Number(second)
  ) {
    throw new Error('scheduledStart must be a valid ISO-8601 timestamp');
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('scheduledStart must be a valid ISO-8601 timestamp');
  return new Date(parsed).toISOString();
}

function requiredPoint(value, field) {
  if (!value || typeof value !== 'object') throw new Error(`${field} with a label and numeric coordinates is required`);
  const label = displayName(value.label || value.name || value.address, '');
  const lat = Number(value.lat ?? value.latitude);
  const lng = Number(value.lng ?? value.longitude);
  if (!label) throw new Error(`${field} label is required`);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error(`${field} must include valid numeric latitude and longitude`);
  }
  return { label, lat, lng };
}

function sessionLocation(payload = {}) {
  const point = requiredPoint({
    label: payload.label ?? payload.name ?? payload.address ?? 'Guide location',
    lat: payload.lat ?? payload.latitude,
    lng: payload.lng ?? payload.longitude,
  }, 'Session location');
  const progress = Number(payload.progress ?? 48);
  return { ...point, progress: Number.isFinite(progress) ? progress : 48, updatedAt: now() };
}

function structuredRequestInput(payload = {}) {
  return {
    origin: requiredPoint(payload.origin ?? payload.start, 'Origin'),
    destination: requiredPoint(payload.destination, 'Destination'),
    scheduledStart: parseScheduledStart(payload),
    durationMinutes: parseDurationMinutes(payload),
  };
}

function distanceKm(origin, destination) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(destination.lat - origin.lat);
  const dLng = toRad(destination.lng - origin.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(origin.lat)) * Math.cos(toRad(destination.lat)) * Math.sin(dLng / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeEstimate(origin, destination, durationMinutes) {
  const km = Math.max(0.6, distanceKm(origin, destination));
  const walkingMinutes = Math.max(8, Math.round((km / 4.6) * 60));
  const guideFee = Math.max(18, Math.round(durationMinutes * 0.72));
  const platformFee = Math.round(guideFee * 0.18);
  return {
    currency: 'USD',
    distanceKm: Number(km.toFixed(1)),
    walkingMinutes,
    guideFee,
    platformFee,
    total: guideFee + platformFee,
  };
}

function computeRequestEstimate(payload) {
  const { origin, destination, durationMinutes } = structuredRequestInput(payload);
  return computeEstimate(origin, destination, durationMinutes);
}

function makeRequest(payload, user) {
  const createdAt = now();
  const { origin, destination, durationMinutes, scheduledStart } = structuredRequestInput(payload);
  return {
    id: id('req'),
    travelerId: user.id,
    guideId: null,
    travelerName: displayName(user.name, 'Traveler'),
    city: cityForPoint(origin),
    origin,
    destination,
    scheduledStart,
    durationMinutes,
    language: String(payload.language || 'English'),
    interests: cleanList(payload.interests),
    estimate: computeEstimate(origin, destination, durationMinutes),
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
    senderName: displayName(user.name, user.role === 'guide' ? 'Guide' : 'Traveler'),
    text: text.slice(0, 1000),
    createdAt: now(),
  };
}

function makeGuide(user) {
  const name = displayName(user.name, 'Guide'); return { id: user.id, name, avatar: name.slice(0, 2).toUpperCase() };
}

async function seedDemo(storage, password) {
  if (!password) throw new Error('Demo seed password is not configured');
  await storage.reset();
  const traveler = await storage.registerUser({ ...DEMO_TRAVELER, password });
  await storage.registerUser({ ...DEMO_GUIDE, password });
  const request = await storage.createRequest(DEMO_REQUEST, traveler.user);
  return {
    accounts: {
      traveler: { name: DEMO_TRAVELER.name, email: DEMO_TRAVELER.email },
      guide: { name: DEMO_GUIDE.name, email: DEMO_GUIDE.email },
    },
    request,
    seededAt: now(),
  };
}

function canReadRequest(user, request) {
  if (!user || !request) return false;
  if (user.role === 'traveler') return request.travelerId === user.id;
  if (user.role === 'guide') return request.guideId === user.id || (!request.guideId && normalizeCity(request.city) === normalizeCity(user.city));
  return false;
}

function canUseSession(user, request) {
  if (!user || !request) return false;
  return (user.role === 'traveler' && request.travelerId === user.id) || (user.role === 'guide' && request.guideId === user.id);
}

export {
  TOKEN_DAYS,
  DEMO_TRAVELER,
  DEMO_GUIDE,
  DEMO_REQUEST,
  now,
  id,
  normalizeEmail,
  cleanList,
  route,
  normalizeCity,
  cityForPoint,
  publicUser,
  displayName,
  publicRequest,
  coarseRequest,
  publicRequestForUser,
  publicSession,
  newestFirst,
  bytesToBase64,
  base64ToBytes,
  randomBase64,
  sha256,
  hashPassword,
  verifyPassword,
  bearerToken,
  productionStorage,
  demoSeedPassword,
  LIVEKIT_TOKEN_TTL_SECONDS,
  livekitConfig,
  makeLivekitToken,
  body,
  parsePoint,
  parseDurationMinutes,
  parseScheduledStart,
  requiredPoint,
  sessionLocation,
  structuredRequestInput,
  distanceKm,
  computeEstimate,
  computeRequestEstimate,
  makeRequest,
  makeMessage,
  makeGuide,
  seedDemo,
  canReadRequest,
  canUseSession,
};
