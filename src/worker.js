// Battle Zone Mymensingh — booking API on Cloudflare Workers + D1.
// The website in /public is served as static assets; everything under /api lands here.

const OPEN = 600, CLOSE = 1320, STEP = 30;          // 10:00 am – 10:00 pm, in minutes
const DURS = [30, 60, 90, 120, 180];
const STATIONS = [
  { id: 'PS5-1', t: 'ps5' }, { id: 'PS5-2', t: 'ps5' }, { id: 'PS5-3', t: 'ps5' },
  { id: 'PS4-1', t: 'ps4' }, { id: 'PS4-2', t: 'ps4' },
  { id: 'RACE-1', t: 'race' }, { id: 'VR-1', t: 'vr' },
];
const TYPES = ['ps5', 'ps4', 'race', 'vr', 'room'];
const MAXP = { ps5: 2, ps4: 2, race: 1, vr: 1, room: 14 };   // players per station; room = group size
// [regular, opening offer] in taka, from the shop's price list
const DEFAULT_PRICES = { offer: true, items: {
  ps5: { 1: { 30: [120, 100], 60: [220, 180] }, 2: { 30: [140, 120], 60: [240, 200] } },
  ps4: { 1: { 30: [100, 80], 60: [190, 150] }, 2: { 30: [110, 90], 60: [200, 160] } },
  race: { 1: { 30: [190, 150], 60: [300, 250] } },
  vr: { 1: { 30: [250, 200], 60: [440, 350] } },
} };
function priceFor(cfg, type, players, dur) {
  const i = cfg.offer ? 1 : 0;
  if (type === 'room') return STATIONS.reduce((s, x) => s + priceFor(cfg, x.t, MAXP[x.t], dur), 0);
  const t = cfg.items[type][Math.min(players, MAXP[type])];
  return Math.floor(dur / 60) * t[60][i] + (dur % 60 ? t[30][i] : 0);
}
function validPrices(c) {
  if (!c || typeof c !== 'object' || typeof c.offer !== 'boolean' || !c.items) return false;
  const ok = v => Number.isInteger(v) && v >= 0 && v <= 100000;
  for (const t of ['ps5', 'ps4', 'race', 'vr'])
    for (let p = 1; p <= MAXP[t]; p++)
      for (const d of [30, 60]) { const v = c.items?.[t]?.[p]?.[d]; if (!Array.isArray(v) || v.length !== 2 || !ok(v[0]) || !ok(v[1])) return false; }
  return true;
}
const clampPlayers = (type, n) => Math.max(1, Math.min(MAXP[type], Number.isInteger(n) ? n : 1));
const STATUSES = ['booked', 'arrived', 'done', 'cancelled'];
const MAX_UPCOMING_PER_PHONE = 2;
const SESSION_HOURS = 12;
const PBKDF2_ITER = 100000;

// ---------- small helpers ----------
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randBytes = n => crypto.getRandomValues(new Uint8Array(n));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const newId = () => b64url(randBytes(9));
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'BZ-' + [...randBytes(4)].map(b => A[b % A.length]).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function pbkdf2(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256));
}
async function hashPw(pw) { const salt = hex(randBytes(16)); return salt + ':' + await pbkdf2(pw, salt); }

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const normPhone = p => String(p ?? '').replace(/[\s-]/g, '').replace(/^\+?88/, '');
const validPhone = p => /^01[3-9]\d{8}$/.test(p);
const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
const validSlot = (s, d) => Number.isInteger(s) && DURS.includes(d) && s >= OPEN && s % STEP === 0 && s + d <= CLOSE;

// Bangladesh is UTC+6 all year (no daylight saving).
function dhakaNow() {
  const t = new Date(Date.now() + 6 * 3600e3);
  return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
function addDays(date, n) { const t = new Date(date + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
const bookingDays = () => { const { date } = dhakaNow(); return [...Array(7)].map((_, i) => addDays(date, i)); };

// ---------- responses ----------
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC, ...extra } });
const fail = (status, error) => json({ error }, status);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function readJson(req) {
  if (!String(req.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const text = await req.text();
  if (text.length > 10000) throw new HttpError(413, 'Too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Bad JSON.'); }
}
const cookie = (req, name) => {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
};
const sessionCookie = (token, maxAge) => `bz_s=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
const ipOf = req => req.headers.get('CF-Connecting-IP') || 'unknown';

// ---------- data helpers ----------
async function getSetting(db, k) { return (await db.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first())?.v; }
const setSetting = (db, k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();
async function prices(db) {
  const v = await getSetting(db, 'prices');
  try { const c = JSON.parse(v); if (validPrices(c)) return c; } catch {}
  return DEFAULT_PRICES;
}
async function hitCount(db, key, windowMs) {
  return (await db.prepare('SELECT COUNT(*) n FROM hits WHERE key = ? AND ts > ?').bind(key, Date.now() - windowMs).first()).n;
}
const addHit = (db, key) => db.prepare('INSERT INTO hits (key, ts) VALUES (?, ?)').bind(key, Date.now()).run();

const INSERT_BOOKING = `INSERT INTO bookings (id, code, date, start, dur, type, station, players, name, phone, status, price, source, created, updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Claim every 30-minute block of the seat(s) and insert the booking in one transaction.
// If another booking already holds any block, the whole batch fails and nothing is written.
// A full-room booking (station ROOM) claims every station.
async function claim(db, row) {
  const stmts = [db.prepare(INSERT_BOOKING).bind(row.id, row.code, row.date, row.start, row.dur, row.type, row.station, row.players,
    row.name, row.phone, row.status, row.price, row.source, row.created, row.updated)];
  const seats = row.station === 'ROOM' ? STATIONS.map(x => x.id) : [row.station];
  for (const seat of seats)
    for (let b = row.start; b < row.start + row.dur; b += STEP)
      stmts.push(db.prepare('INSERT INTO slots (date, station, block, booking_id) VALUES (?, ?, ?, ?)').bind(row.date, seat, b, row.id));
  try { await db.batch(stmts); return true; }
  catch (e) { if (/UNIQUE|constraint/i.test(String(e?.message || e))) return false; throw e; }
}

async function isAdmin(db, req) {
  const t = cookie(req, 'bz_s');
  if (!t) return false;
  const row = await db.prepare('SELECT expires FROM sessions WHERE hash = ?').bind(await sha256(t)).first();
  return !!row && row.expires > Date.now();
}
async function checkPassword(env, pw) {
  const stored = await getSetting(env.DB, 'admin_pw');
  if (stored) { const [salt, h] = stored.split(':'); return safeEqual(await pbkdf2(pw, salt), h); }
  if (!env.ADMIN_PASSWORD) return false;
  return safeEqual(await sha256(String(pw)), await sha256(env.ADMIN_PASSWORD));
}

// ---------- routes ----------
async function handle(req, env) {
  const db = env.DB;
  const url = new URL(req.url);
  const p = url.pathname, m = req.method;

  if (m === 'GET' && p === '/api/health') return json({ ok: true });

  // Public: busy seats for the next 7 days. No names or phone numbers.
  if (m === 'GET' && p === '/api/public') {
    const days = bookingDays(), now = dhakaNow();
    const { results } = await db.prepare(`SELECT date, start, dur, station FROM bookings
      WHERE date >= ? AND date <= ? AND status != 'cancelled'`).bind(days[0], days[6]).all();
    const busy = results.flatMap(r => r.station === 'ROOM' ? STATIONS.map(x => ({ ...r, station: x.id })) : [r]);
    return json({ days, now: now.min, prices: await prices(db), busy });
  }

  // Public: make a booking. The server picks the seat.
  if (m === 'POST' && p === '/api/book') {
    const ip = ipOf(req);
    if (await hitCount(db, 'book:' + ip, 3600e3) >= 8) return fail(429, 'Too many bookings from this connection. Call the shop instead.');
    const b = await readJson(req);
    const days = bookingDays(), now = dhakaNow();
    const { date, start, dur, type } = b;
    const name = clean(b.name, 60), phone = normPhone(b.phone);
    if (!days.includes(date)) return fail(400, 'Pick a day within the next week.');
    if (!TYPES.includes(type)) return fail(400, 'Pick what you want to play.');
    const players = clampPlayers(type, b.players);
    if (!validSlot(start, dur)) return fail(400, 'That time is outside opening hours.');
    if (date === now.date && start < now.min) return fail(400, 'That time has already passed.');
    if (name.length < 2) return fail(400, 'Add your name.');
    if (!validPhone(phone)) return fail(400, 'Enter a valid phone number, like 01712345678.');

    const upcoming = (await db.prepare(`SELECT COUNT(*) n FROM bookings WHERE phone = ? AND status = 'booked'
      AND (date > ? OR (date = ? AND start + dur > ?))`).bind(phone, now.date, now.date, now.min).first()).n;
    if (upcoming >= MAX_UPCOMING_PER_PHONE) return fail(409, `You already have ${MAX_UPCOMING_PER_PHONE} bookings coming up.`);

    const pr = await prices(db), t = Date.now(), price = priceFor(pr, type, players, dur);
    const seats = type === 'room' ? ['ROOM'] : STATIONS.filter(x => x.t === type).map(x => x.id);
    for (const station of seats) {
      const row = { id: newId(), code: newCode(), date, start, dur, type, station, players, name, phone,
        status: 'booked', price, source: 'online', created: t, updated: t };
      if (await claim(db, row)) {
        await addHit(db, 'book:' + ip);
        return json({ booking: { code: row.code, station, type, players, date, start, dur, price } }, 201);
      }
    }
    return fail(409, type === 'room' ? 'The full room is not free at that time. Pick another.' : 'That time just filled up. Pick another.');
  }

  // Admin login / logout
  if (m === 'POST' && p === '/api/admin/login') {
    const key = 'login:' + ipOf(req);
    if (await hitCount(db, key, 900e3) >= 5) return fail(429, 'Too many tries. Wait 15 minutes.');
    const { password } = await readJson(req);
    if (!(await checkPassword(env, password))) { await addHit(db, key); return fail(401, 'Wrong password.'); }
    const token = b64url(randBytes(32));
    await db.batch([
      db.prepare('DELETE FROM hits WHERE key = ? OR ts < ?').bind(key, Date.now() - 86400e3),
      db.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()),
      db.prepare('INSERT INTO sessions (hash, expires) VALUES (?, ?)').bind(await sha256(token), Date.now() + SESSION_HOURS * 3600e3),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_HOURS * 3600) });
  }
  if (m === 'POST' && p === '/api/admin/logout') {
    const t = cookie(req, 'bz_s');
    if (t) await db.prepare('DELETE FROM sessions WHERE hash = ?').bind(await sha256(t)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (p.startsWith('/api/admin/')) {
    if (!(await isAdmin(db, req))) return fail(401, 'Log in again.');

    if (m === 'GET' && p === '/api/admin/me') return json({ ok: true });

    if (m === 'GET' && p === '/api/admin/bookings') {
      const date = url.searchParams.get('date');
      if (!isDate(date)) return fail(400, 'Bad date.');
      const { results } = await db.prepare('SELECT * FROM bookings WHERE date = ? ORDER BY start, station').bind(date).all();
      return json({ bookings: results });
    }

    if (m === 'POST' && p === '/api/admin/bookings') {
      const b = await readJson(req);
      const st = b.station === 'ROOM' ? { id: 'ROOM', t: 'room' } : STATIONS.find(x => x.id === b.station);
      if (!isDate(b.date) || !st) return fail(400, 'Pick a day and a station.');
      if (!validSlot(b.start, b.dur)) return fail(400, 'That runs outside opening hours.');
      const blocked = b.kind === 'blocked', t = Date.now(), pr = await prices(db);
      const players = clampPlayers(st.t, b.players);
      const row = { id: newId(), code: blocked ? '' : newCode(), date: b.date, start: b.start, dur: b.dur, type: st.t, station: st.id, players,
        name: clean(b.name, 60) || (blocked ? 'Blocked' : 'Walk-in'), phone: clean(normPhone(b.phone), 16),
        status: blocked ? 'blocked' : 'arrived', price: blocked ? 0 : priceFor(pr, st.t, players, b.dur),
        source: blocked ? 'block' : 'walk-in', created: t, updated: t };
      if (!(await claim(db, row))) return fail(409, st.id === 'ROOM' ? 'Some stations are taken at that time.' : `${st.id} is already taken at that time.`);
      return json({ booking: row }, 201);
    }

    const one = p.match(/^\/api\/admin\/bookings\/([A-Za-z0-9_-]{6,40})$/);
    if (one && m === 'PATCH') {
      const { status } = await readJson(req);
      if (!STATUSES.includes(status)) return fail(400, 'Bad status.');
      const stmts = [db.prepare("UPDATE bookings SET status = ?, updated = ? WHERE id = ? AND status NOT IN ('blocked','cancelled')").bind(status, Date.now(), one[1])];
      if (status === 'cancelled') stmts.push(db.prepare('DELETE FROM slots WHERE booking_id = ?').bind(one[1]));   // frees the seat
      const [r] = await db.batch(stmts);
      return r.meta.changes ? json({ ok: true }) : fail(404, 'Booking not found.');
    }
    if (one && m === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM slots WHERE booking_id = ?').bind(one[1]),
        db.prepare('DELETE FROM bookings WHERE id = ?').bind(one[1]),
      ]);
      return json({ ok: true });
    }

    if (m === 'PUT' && p === '/api/admin/settings') {
      const b = await readJson(req);
      if (!validPrices(b)) return fail(400, 'Prices must be whole taka.');
      const clean = { offer: b.offer, items: {} };
      for (const t of ['ps5', 'ps4', 'race', 'vr']) { clean.items[t] = {}; for (let p = 1; p <= MAXP[t]; p++) clean.items[t][p] = { 30: b.items[t][p][30], 60: b.items[t][p][60] }; }
      await setSetting(db, 'prices', JSON.stringify(clean));
      return json({ prices: clean });
    }

    if (m === 'POST' && p === '/api/admin/password') {
      const b = await readJson(req);
      if (!(await checkPassword(env, b.current))) return fail(400, 'Current password is wrong.');
      if (typeof b.next !== 'string' || b.next.length < 8) return fail(400, 'New password needs 8+ characters.');
      await setSetting(db, 'admin_pw', await hashPw(b.next));
      await db.prepare('DELETE FROM sessions WHERE hash != ?').bind(await sha256(cookie(req, 'bz_s'))).run();   // log out other devices
      return json({ ok: true });
    }

    if (m === 'GET' && p === '/api/admin/export.csv') {
      const { results } = await db.prepare('SELECT code, date, start, dur, type, station, players, name, phone, status, price, source, created FROM bookings ORDER BY date, start').all();
      const hm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
      const q = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
      const csv = ['Code,Date,Start,End,Game,Station,Players,Name,Phone,Status,Price,Source,Created']
        .concat(results.map(r => [r.code, r.date, hm(r.start), hm(r.start + r.dur), r.type, r.station, r.players, r.name, r.phone, r.status, r.price, r.source, new Date(r.created).toISOString()].map(q).join(',')))
        .join('\r\n');
      return new Response('﻿' + csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="battle-zone-bookings.csv"', ...SEC } });
    }
  }
  return fail(404, 'Not found.');
}

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await handle(req, env); }
    catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      console.error(e);
      return fail(500, 'Server error. Try again.');
    }
  },
};
