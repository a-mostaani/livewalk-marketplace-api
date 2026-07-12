const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 10)}`;
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const cleanList = (value) => Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 12) : [];
const route = (request) => `${request.origin?.label || 'Start'} → ${request.destination?.label || 'Destination'}`;
const publicUser = (user) => user ? { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt } : null;
const displayName = (value, fallback) => String(value || '').trim() || fallback;
const publicRequest = (request) => request ? { ...request, travelerName: displayName(request.travelerName, 'Traveler'), route: route(request), travelerId: undefined, guideId: undefined } : null;
const publicSession = (session) => session ? { ...session } : null;
const newestFirst = (items) => [...items].sort((a, b) => String(b.createdAt || b.updatedAt).localeCompare(String(a.createdAt || a.updatedAt)));
const TOKEN_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;
const DEMO_PASSWORD = 'LiveWalkDemo1!';
const DEMO_TRAVELER = {
  role: 'traveler',
  name: 'Sofia Ramirez',
  email: 'demo.traveler@livewalk.test',
  password: DEMO_PASSWORD,
};
const DEMO_GUIDE = {
  role: 'guide',
  name: 'Yuki Tanaka',
  email: 'demo.guide@livewalk.test',
  password: DEMO_PASSWORD,
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

function validDemoKey(request, env) {
  const expected = String(env?.DEMO_ADMIN_KEY || '').trim();
  return Boolean(expected) && request.headers.get('x-demo-key') === expected;
}

function productionStorage(env) {
  return Boolean(env?.HYPERDRIVE?.connectionString);
}

async function body(request) {
  if (request.method === 'GET') return {};
  try { return await request.json(); } catch { return {}; }
}

function parsePoint(value, fallback) {
  if (value && typeof value === 'object') {
    const label = displayName(value.label || value.name || value.address, fallback.label);
    const lat = Number(value.lat ?? value.latitude ?? fallback.lat);
    const lng = Number(value.lng ?? value.longitude ?? fallback.lng);
    return { label, lat: Number.isFinite(lat) ? lat : fallback.lat, lng: Number.isFinite(lng) ? lng : fallback.lng };
  }
  return { ...fallback, label: displayName(value, fallback.label) };
}

function parseDurationMinutes(payload) {
  const direct = Number(payload.durationMinutes ?? payload.duration_minutes);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  const legacy = parseInt(String(payload.duration || ''), 10);
  return Number.isFinite(legacy) && legacy > 0 ? legacy : 45;
}

function parseScheduledStart(payload) {
  const value = String(payload.scheduledStart || payload.scheduled_start || payload.scheduledTime || payload.dateTime || '').trim();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(Date.now() + 86400000).toISOString();
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

async function seedDemo(storage) {
  await storage.reset();
  const traveler = await storage.registerUser(DEMO_TRAVELER);
  await storage.registerUser(DEMO_GUIDE);
  const request = await storage.createRequest(DEMO_REQUEST, traveler.user);
  return {
    accounts: {
      traveler: { name: DEMO_TRAVELER.name, email: DEMO_TRAVELER.email, password: DEMO_PASSWORD },
      guide: { name: DEMO_GUIDE.name, email: DEMO_GUIDE.email, password: DEMO_PASSWORD },
    },
    request,
    seededAt: now(),
  };
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

export {
  TOKEN_DAYS,
  DEMO_PASSWORD,
  DEMO_TRAVELER,
  DEMO_GUIDE,
  DEMO_REQUEST,
  now,
  id,
  normalizeEmail,
  cleanList,
  route,
  publicUser,
  displayName,
  publicRequest,
  publicSession,
  newestFirst,
  bytesToBase64,
  base64ToBytes,
  randomBase64,
  sha256,
  hashPassword,
  verifyPassword,
  bearerToken,
  validDemoKey,
  productionStorage,
  body,
  parsePoint,
  parseDurationMinutes,
  parseScheduledStart,
  requiredPoint,
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
