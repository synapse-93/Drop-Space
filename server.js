'use strict';
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map(value => value.trim()).filter(Boolean));
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Busboy = require('busboy');
const { MongoClient, ServerApiVersion } = require('mongodb');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_FILE = process.env.VERCEL ? 4 * 1024 * 1024 : 10 * 1024 * 1024;
const TOTAL_QUOTA = 50 * 1024 * 1024;
const UPLOADS_PER_HOUR = 20;
const SESSION_HOURS = 8;
const MAX_BODY = MAX_FILE + 128 * 1024;
const LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();
let mongoClient;
let db;
let files;
let sessions;
let controls;
let users;
let passwordSalt;
let passwordHash;
let uploadQueue = Promise.resolve();

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  let contents;
  try { contents = require('node:fs').readFileSync(envPath, 'utf8'); } catch { return; }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1].startsWith('#') || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
loadEnvFile();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const DB_NAME = process.env.MONGODB_DB_NAME || 'drop_space';
const LEGACY_DATA_DIR = path.resolve(process.env.LEGACY_DATA_DIR || path.join(ROOT, 'data'));
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_UPLOADS_IN_FLIGHT = 3;
let activeUploads = 0;

function timingSafeString(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function makeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function send(res, status, body, type, headers) {
  const responseHeaders = {
    'Content-Type': type || 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'Cache-Control': 'no-store',
    ...headers
  };
  res.writeHead(status, responseHeaders);
  if (Buffer.isBuffer(body)) return res.end(body);
  if (typeof body === 'string') return res.end(body);
  return res.end(JSON.stringify(body));
}

function fail(res, status, message, headers) {
  return send(res, status, { error: message }, 'application/json; charset=utf-8', headers);
}

function cookieValue(req, name) {
  const prefix = name + '=';
  for (const part of (req.headers.cookie || '').split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return '';
}

function cookieOptions(maxAge) {
  return 'Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (COOKIE_SECURE ? '; Secure' : '');
}

function sessionIdHash(raw) {
  if (!/^[a-f0-9]{64}$/.test(raw)) return '';
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function getSession(req) {
  const raw = cookieValue(req, 'drop_session');
  const hash = sessionIdHash(raw);
  if (!hash) return null;
  const session = await sessions.findOne({ _id: hash, expiresAt: { $gt: new Date() } });
  return session || null;
}

async function requireOwner(req, res) {
  try {
    const session = await getSession(req);
    if (!session) {
      fail(res, 401, 'Your session expired. Please sign in again.');
      return null;
    }
    return session;
  } catch {
    fail(res, 503, 'Owner session storage is unavailable. Check the MongoDB connection.');
    return null;
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const expected = (COOKIE_SECURE ? 'https://' : 'http://') + req.headers.host;
  return origin === expected;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limit && !rejected) {
        rejected = true;
        reject(makeError(413, 'Request is too large.'));
        req.resume();
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', error => { if (!rejected) reject(error); });
  });
}

async function readJson(req, limit) {
  const body = await readBody(req, limit);
  try { return JSON.parse(body.toString('utf8')); } catch { throw makeError(400, 'Request body must be valid JSON.'); }
}

function parseMultipartStream(req) {
  return new Promise((resolve, reject) => {
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE, files: 1, fields: 2, fieldSize: 256 } }); }
    catch { reject(makeError(400, 'Upload must use a valid multipart form.')); return; }
    let file = null;
    let expiryHours = 24;
    let expiresAtRaw = '';
    let fileSeen = false;
    let failure = null;
    parser.on('file', (field, stream, info) => {
      fileSeen = true;
      if (field !== 'file') { failure = makeError(400, 'Upload form field is invalid.'); stream.resume(); return; }
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('limit', () => { failure = makeError(413, 'File exceeds the 10 MB per-file limit.'); });
      stream.on('end', () => {
        if (!stream.truncated && !failure) file = { filename: info.filename, data: Buffer.concat(chunks) };
      });
    });
    parser.on('field', (name, value) => {
      if (name === 'expiryHours') expiryHours = Number(value.trim());
      if (name === 'expiresAt') expiresAtRaw = value.trim();
    });
    parser.on('filesLimit', () => { failure = makeError(400, 'Upload exactly one file at a time.'); });
    parser.on('fieldsLimit', () => { failure = makeError(400, 'Upload form contains too many fields.'); });
    parser.on('error', () => reject(makeError(400, 'Upload form could not be parsed.')));
    parser.on('finish', () => {
      if (failure) { reject(failure); return; }
      if (!fileSeen || !file || file.data.length === 0) { reject(makeError(400, 'Choose a non-empty file to upload.')); return; }
      let expiry;
      if (expiresAtRaw) expiry = new Date(expiresAtRaw);
      else if (Number.isFinite(expiryHours) && expiryHours > 0) expiry = new Date(Date.now() + expiryHours * 3600000);
      if (!expiry || Number.isNaN(expiry.getTime())) { reject(makeError(400, 'Choose a valid expiry time.')); return; }
      const duration = expiry.getTime() - Date.now();
      if (duration < 60000 || duration > 30 * 24 * 3600000) { reject(makeError(400, 'Expiry must be at least 1 minute and no more than 30 days from now.')); return; }
      resolve({ filename: file.filename, data: file.data, expiresAt: expiry });
    });
    req.pipe(parser);
  });
}

function safeName(input) {
  const cleaned = path.basename(String(input).replace(/[\\/\0]/g, '_')).replace(/[\r\n";]/g, '_').trim().slice(0, 180);
  return cleaned || 'download';
}

function publicRecord(item) {
  return {
    id: String(item._id),
    name: item.name,
    size: item.size,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    downloads: item.downloads || 0,
    revoked: Boolean(item.revoked),
    shareUrl: '/s/' + item.shareToken
  };
}

async function serveStatic(res, filename) {
  try {
    const body = await fs.readFile(path.join(PUBLIC_DIR, filename));
    const extension = path.extname(filename);
    const type = extension === '.html' ? 'text/html; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    send(res, 200, body, type);
  } catch {
    fail(res, 404, 'Page not found.');
  }
}

async function withUploadLock(operation) {
  const previous = uploadQueue;
  let release;
  uploadQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

function rateLimitState(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    const fresh = { startedAt: now, attempts: 0 };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  return current;
}

function authenticatePassword(candidate) {
  if (typeof candidate !== 'string' || candidate.length > 1024) return false;
  const candidateHash = crypto.scryptSync(candidate, passwordSalt, 64);
  return crypto.timingSafeEqual(candidateHash, passwordHash);
}

async function migrateLegacyFiles() {
  await files.updateMany({ scanStatus: { $exists: true } }, { $unset: { scanStatus: '' } });
  const marker = await controls.findOne({ _id: 'legacy-files-v1' });
  if (marker) return;
  let legacy = [];
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(LEGACY_DATA_DIR, 'metadata.json'), 'utf8'));
    if (Array.isArray(parsed)) legacy = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  let imported = 0;
  const legacyFilesPath = path.join(LEGACY_DATA_DIR, 'files');
  for (const item of legacy) {
    if (!item || !item.id || !item.token || !item.storedName || path.basename(item.storedName) !== item.storedName) continue;
    if (await files.findOne({ _id: String(item.id) }, { projection: { _id: 1 } })) continue;
    let data;
    try { data = await fs.readFile(path.join(legacyFilesPath, item.storedName)); } catch { continue; }
    if (data.length > MAX_FILE) continue;
    const createdAt = new Date(item.createdAt);
    const expiresAt = new Date(item.expiresAt);
    await files.insertOne({
      _id: String(item.id),
      ownerId: process.env.OWNER_USERNAME || 'owner',
      shareToken: String(item.token),
      name: safeName(item.name),
      size: data.length,
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
      expiresAt: Number.isNaN(expiresAt.getTime()) ? new Date(0) : expiresAt,
      downloads: Number(item.downloads) || 0,
      revoked: Boolean(item.revoked),
      data
    });
    imported += 1;
  }
  await controls.updateOne(
  { _id: 'legacy-files-v1' },
  {
    $setOnInsert: {
      imported,
      completedAt: new Date()
    }
  },
  { upsert: true }
   );
  if (imported) console.log('Imported ' + imported + ' legacy file(s) into MongoDB. Local source files were left in place as a backup.');
}

async function initialize() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing. Copy .env.example to .env and configure your MongoDB URI.');
  mongoClient = new MongoClient(process.env.MONGODB_URI, {
    appName: 'drop-space-file-sharing',
    maxPoolSize: 10,
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
  });
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  await db.command({ ping: 1 });
  files = db.collection('files');
  sessions = db.collection('sessions');
  controls = db.collection('app_control');
  users = db.collection('users');
  await users.createIndex({ usernameLower: 1 }, { unique: true, name: 'username_unique' });
  const bootstrapUsername = (process.env.OWNER_USERNAME || 'owner').trim();
  const bootstrapPassword = process.env.OWNER_PASSWORD || '';
  if (bootstrapPassword.length >= 12 && bootstrapPassword !== 'replace-with-a-strong-private-passphrase') {
    const existing = await users.findOne({ usernameLower: bootstrapUsername.toLowerCase() });
    if (!existing) {
      const salt = crypto.randomBytes(16);
      await users.insertOne({ username: bootstrapUsername, usernameLower: bootstrapUsername.toLowerCase(), salt: salt.toString('hex'), passwordHash: crypto.scryptSync(bootstrapPassword, salt, 64).toString('hex'), createdAt: new Date() });
    }
  }
  await Promise.all([
    files.createIndex({ shareToken: 1 }, { unique: true, name: 'share_token_unique' }),
    files.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'owner_created' }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'session_expiry' })
  ]);
  await migrateLegacyFiles();
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || (HOST + ':' + PORT)));
  const method = req.method || 'GET';

  if (method === 'GET' && url.pathname === '/login') return serveStatic(res, 'login.html');
  if (method === 'GET' && url.pathname === '/login.js') return serveStatic(res, 'login.js');
  if (method === 'GET' && url.pathname === '/share.js') return serveStatic(res, 'share.js');
  if (method === 'GET' && url.pathname === '/style.css') return serveStatic(res, 'style.css');
  if (method === 'GET' && url.pathname === '/login.css') return serveStatic(res, 'login.css');
  if (method === 'GET' && url.pathname === '/dashboard.css') return serveStatic(res, 'dashboard.css');
  if (method === 'GET' && url.pathname.startsWith('/s/')) return serveStatic(res, 'share.html');

  if (method === 'GET' && url.pathname === '/') {
    const session = await getSession(req);
    if (!session) { res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); return res.end(); }
    return serveStatic(res, 'index.html');
  }
  if (method === 'GET' && url.pathname === '/app.js') return serveStatic(res, 'app.js');

  if (method === 'POST' && url.pathname === '/api/login') {
    if (!sameOrigin(req)) return fail(res, 403, 'Request origin was rejected.');
    const ip = (req.socket && req.socket.remoteAddress) || (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    const state = rateLimitState(ip);
    if (state.attempts >= LOGIN_ATTEMPTS) {
      const retry = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - state.startedAt)) / 1000));
      return fail(res, 429, 'Too many sign-in attempts. Try again in 15 minutes.', { 'Retry-After': String(retry) });
    }
    try {
      const body = await readJson(req, 4096);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const user = await users.findOne({ usernameLower: username.toLowerCase() });
      const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16);
      const candidate = crypto.scryptSync(typeof body.password === 'string' ? body.password : '', salt, 64);
      const valid = Boolean(user && timingSafeString(candidate.toString('hex'), user.passwordHash));
      if (!valid) {
        state.attempts += 1;
        return fail(res, 401, 'That username or password is not correct.');
      }
      loginAttempts.delete(ip);
      const rawSession = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600000);
      await sessions.insertOne({ _id: sessionIdHash(rawSession), username: user.username, createdAt: new Date(), expiresAt });
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': 'drop_session=' + rawSession + '; ' + cookieOptions(SESSION_HOURS * 3600) });
    } catch (error) {
      return fail(res, error.status || 503, error.status ? error.message : 'Sign-in service is unavailable.');
    }
  }

  if (method === 'POST' && url.pathname === '/api/logout') {
    if (!sameOrigin(req)) return fail(res, 403, 'Request origin was rejected.');
    const raw = cookieValue(req, 'drop_session');
    const hash = sessionIdHash(raw);
    if (hash) await sessions.deleteOne({ _id: hash });
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': 'drop_session=; ' + cookieOptions(0) });
  }

  if (method === 'POST' && url.pathname === '/api/register') {
    if (!sameOrigin(req)) return fail(res, 403, 'Request origin was rejected.');
    try {
      const body = await readJson(req, 4096);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) return fail(res, 400, 'Username must be 3–24 characters (letters, numbers, dot, underscore or hyphen).');
      if (password.length < 12 || password.length > 1024) return fail(res, 400, 'Password must be at least 12 characters.');
      const salt = crypto.randomBytes(16);
      const doc = { username, usernameLower: username.toLowerCase(), salt: salt.toString('hex'), passwordHash: crypto.scryptSync(password, salt, 64).toString('hex'), createdAt: new Date() };
      await users.insertOne(doc);
      const rawSession = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600000);
      await sessions.insertOne({ _id: sessionIdHash(rawSession), username, createdAt: new Date(), expiresAt });
      return send(res, 201, { ok: true }, undefined, { 'Set-Cookie': 'drop_session=' + rawSession + '; ' + cookieOptions(SESSION_HOURS * 3600) });
    } catch (error) {
      if (error.code === 11000) return fail(res, 409, 'That username is already taken.');
      return fail(res, error.status || 503, error.status ? error.message : 'Account registration is unavailable. Check MongoDB.');
    }
  }

  if (url.pathname === '/api/owner' || url.pathname.startsWith('/api/files') || url.pathname === '/api/session') {
    const session = await requireOwner(req, res);
    if (!session) return;
    req.authenticatedUser = session.username;
  }

  if (method === 'GET' && url.pathname === '/api/session') return send(res, 200, { username: req.authenticatedUser });

  if (method === 'GET' && url.pathname === '/api/owner') {
    const [list, usage, uploadsThisHour] = await Promise.all([
      files.find({ ownerId: req.authenticatedUser }, { projection: { data: 0 } }).sort({ createdAt: -1 }).toArray(),
      files.aggregate([{ $match: { ownerId: req.authenticatedUser } }, { $group: { _id: null, bytes: { $sum: '$size' } } }]).toArray(),
      files.countDocuments({ ownerId: req.authenticatedUser, createdAt: { $gte: new Date(Date.now() - 3600000) } })
    ]);
    return send(res, 200, {
      files: list.map(publicRecord),
      usedBytes: usage[0]?.bytes || 0,
      quotaBytes: TOTAL_QUOTA,
      maxFileBytes: MAX_FILE,
      uploadsThisHour,
      uploadLimit: UPLOADS_PER_HOUR
    });
  }

  if (method === 'POST' && url.pathname === '/api/files') {
    if (!sameOrigin(req)) return fail(res, 403, 'Request origin was rejected.');
    if (activeUploads >= MAX_UPLOADS_IN_FLIGHT) return fail(res, 429, 'Several uploads are already being processed. Try again shortly.');
    activeUploads += 1;
    try {
      const length = Number(req.headers['content-length'] || 0);
      if (length > MAX_BODY) throw makeError(413, 'Upload exceeds the 10 MB file limit.');
      const upload = await parseMultipartStream(req);
      if (upload.data.length > MAX_FILE) throw makeError(413, 'File exceeds the 10 MB per-file limit.');
      const saved = await withUploadLock(async () => {
        const now = new Date();
        const [used, count] = await Promise.all([
          files.aggregate([{ $match: { ownerId: req.authenticatedUser } }, { $group: { _id: null, bytes: { $sum: '$size' } } }]).toArray(),
          files.countDocuments({ ownerId: req.authenticatedUser, createdAt: { $gte: new Date(now.getTime() - 3600000) } })
        ]);
        if ((used[0]?.bytes || 0) + upload.data.length > TOTAL_QUOTA) throw makeError(413, 'This upload would exceed the 50 MB owner storage quota.');
        if (count >= UPLOADS_PER_HOUR) {
          const oldest = await files.find({ ownerId: req.authenticatedUser, createdAt: { $gte: new Date(now.getTime() - 3600000) } }).sort({ createdAt: 1 }).limit(1).next();
          const seconds = oldest ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + 3600000 - now.getTime()) / 1000)) : 3600;
          throw Object.assign(makeError(429, 'The limit is 20 uploads per hour. Try again after the oldest upload leaves the rolling hour window.'), { retryAfter: seconds });
        }
        const doc = {
          _id: crypto.randomUUID(),
          ownerId: req.authenticatedUser,
          shareToken: crypto.randomBytes(32).toString('base64url'),
          name: safeName(upload.filename),
          size: upload.data.length,
          createdAt: now,
          expiresAt: upload.expiresAt,
          downloads: 0,
          revoked: false,
          data: upload.data
        };
        await files.insertOne(doc);
        return doc;
      });
      return send(res, 201, { file: publicRecord(saved) });
    } catch (error) {
      return fail(res, error.status || 500, error.status ? error.message : 'Upload could not be saved. Check the MongoDB connection.', error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined);
    } finally {
      activeUploads -= 1;
    }
  }

  const expiryEdit = /^\/api\/files\/([a-f0-9-]+)\/expiry$/.exec(url.pathname);
  if (expiryEdit && method === 'POST') {
    if (!sameOrigin(req)) return fail(res, 403, 'Request origin was rejected.');
    try {
      const body = await readJson(req, 4096);
      const expiresAt = new Date(body.expiresAt);
      const duration = expiresAt.getTime() - Date.now();
      if (Number.isNaN(expiresAt.getTime()) || duration < 60000 || duration > 30 * 24 * 3600000) {
        return fail(res, 400, 'Expiry must be at least 1 minute and no more than 30 days from now.');
      }
      const result = await files.updateOne(
        { _id: expiryEdit[1], ownerId: req.authenticatedUser, revoked: false },
        { $set: { expiresAt, expiryUpdatedAt: new Date() } }
      );
      if (!result.matchedCount) return fail(res, 404, 'File not found or its link has been revoked.');
      return send(res, 200, { ok: true, expiresAt });
    } catch (error) {
      return fail(res, error.status || 500, error.status ? error.message : 'Expiry could not be saved. Check the MongoDB connection.');
    }
  }

  const action = /^\/api\/files\/([a-f0-9-]+)\/(revoke|delete)$/.exec(url.pathname);
  if (action && method === 'POST') {
    if (!sameOrigin(req)) return fail(res, 403, 'Request origin was rejected.');
    const id = action[1];
    if (action[2] === 'revoke') {
      const result = await files.updateOne({ _id: id, ownerId: req.authenticatedUser }, { $set: { revoked: true, revokedAt: new Date() } });
      if (!result.matchedCount) return fail(res, 404, 'File not found.');
      return send(res, 200, { ok: true });
    }
    const result = await files.deleteOne({ _id: id, ownerId: req.authenticatedUser });
    if (!result.deletedCount) return fail(res, 404, 'File not found.');
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && url.pathname.startsWith('/api/share/')) {
    const token = url.pathname.slice('/api/share/'.length);
    const item = await files.findOne({ shareToken: token });
    if (!item) return fail(res, 404, 'This share link is invalid.');
    if (item.revoked) return fail(res, 410, 'The owner revoked this share link.');
    if (Date.now() >= item.expiresAt.getTime()) return fail(res, 410, 'This share link has expired.');
    return send(res, 200, { name: item.name, size: item.size, expiresAt: item.expiresAt, downloadUrl: '/download/' + item.shareToken });
  }

  if (method === 'GET' && url.pathname.startsWith('/download/')) {
    const token = url.pathname.slice('/download/'.length);
    const active = await files.findOneAndUpdate(
      { shareToken: token, revoked: false, expiresAt: { $gt: new Date() } },
      { $inc: { downloads: 1 } },
      { returnDocument: 'after' }
    );
    const item = active;
    if (!item) {
      const known = await files.findOne({ shareToken: token }, { projection: { revoked: 1, expiresAt: 1 } });
      if (!known) return fail(res, 404, 'This share link is invalid.');
      if (known.revoked) return fail(res, 410, 'The owner revoked this share link.');
      return fail(res, 410, 'This share link has expired.');
    }
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data.buffer || item.data);
    const name = safeName(item.name);
    return send(res, 200, data, 'application/octet-stream', {
      'Content-Length': String(data.length),
      'Content-Disposition': 'attachment; filename="' + name + '"; filename*=UTF-8\'\'' + encodeURIComponent(item.name)
    });
  }

  return fail(res, 404, 'Page not found.');
}

let initializationPromise;
function ensureInitialized() {
  if (!initializationPromise) initializationPromise = initialize().catch(error => {
    initializationPromise = null;
    throw error;
  });
  return initializationPromise;
}

async function vercelHandler(req, res) {
  try {
    await ensureInitialized();
    await handler(req, res);
  } catch (error) {
    console.error('Drop Space request failed:', error.message);
    if (!res.headersSent) fail(res, error.status || 500, error.status ? error.message : 'Service temporarily unavailable. Check server configuration.');
    else res.destroy();
  }
}

async function start() {
  await ensureInitialized();
  const server = http.createServer(vercelHandler);
  server.listen(PORT, HOST, () => {
    console.log('Drop Space connected to MongoDB database "' + DB_NAME + '" at http://' + HOST + ':' + PORT);
  });
  const close = async () => {
    server.close();
    if (mongoClient) await mongoClient.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (require.main === module) {
  start().catch(error => {
    console.error('Could not start Drop Space:', error.message);
    process.exitCode = 1;
  });
}

module.exports = vercelHandler;
