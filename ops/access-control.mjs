import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHmac, randomBytes, randomUUID, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(rawScrypt);
const COOKIE = 'syntonomy_meili_session';
const ROLES = ['admin', 'gestionnaire', 'lecteur'];
const UID = /^[a-zA-Z0-9_-]{1,512}$/;
const READ_ACTIONS = ['search', 'documents.get', 'indexes.get', 'settings.get', 'stats.get', 'tasks.get'];
const MANAGER_ACTIONS = [...READ_ACTIONS, 'documents.add', 'documents.delete', 'indexes.update', 'settings.update'];
const fail = (status, message, code = 'access_denied') => Object.assign(new Error(message), { status, code });
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const sign = (key, payload) => createHmac('sha256', key).update(payload).digest('base64url');
const publicUser = u => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, indexes: u.role === 'admin' ? ['*'] : u.indexes, active: u.active, createdAt: u.createdAt, updatedAt: u.updatedAt });
function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}
export async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    return `scrypt:${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function verifyPassword(password, stored) {
    const [kind, salt, hash] = String(stored).split(':');
    if (kind !== 'scrypt' || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(hash)) return false;
    return same((await scrypt(password, salt, 64)).toString('hex'), hash);
}
async function body(req, limit = 1048576) {
    if (Number(req.headers['content-length'] || 0) > limit) throw fail(413, 'Requête trop volumineuse.');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413, 'Requête trop volumineuse.'); chunks.push(chunk); }
    return Buffer.concat(chunks).toString('utf8');
}
async function jsonBody(req) {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw fail(415, 'Une requête JSON est requise.');
    try { const value = JSON.parse(await body(req)); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
    catch (error) { if (error.status) throw error; throw fail(400, 'JSON invalide.', 'invalid_request'); }
}
function validate(input, previous) {
    const username = String(input.username ?? previous?.username ?? '').trim().toLowerCase();
    const displayName = String(input.displayName ?? previous?.displayName ?? username).trim();
    const role = input.role ?? previous?.role;
    const active = input.active ?? previous?.active ?? true;
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw fail(400, 'Identifiant : 3 à 64 caractères, lettres, chiffres, point, tiret ou underscore.', 'invalid_user');
    if (!displayName || displayName.length > 80 || !ROLES.includes(role) || typeof active !== 'boolean') throw fail(400, 'Nom, rôle ou état du compte invalide.', 'invalid_user');
    const indexes = role === 'admin' ? ['*'] : input.indexes ?? previous?.indexes?.filter(x => x !== '*') ?? [];
    if (!Array.isArray(indexes) || indexes.length > 5000 || indexes.some(x => typeof x !== 'string' || !UID.test(x))) throw fail(400, 'Sélectionnez des index précis, sans joker.', 'invalid_indexes');
    if ((!previous || input.password !== undefined) && (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256)) throw fail(400, 'Le mot de passe doit contenir entre 12 et 256 caractères.', 'invalid_password');
    return { username, displayName, role, indexes: [...new Set(indexes)].sort(), active };
}
const loginPage = error => `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connexion — Syntonomy Meili</title><style>body{font:16px system-ui;background:#f4f6fb;color:#17243a;min-height:100vh;display:grid;place-items:center;margin:0}main{background:white;max-width:360px;width:calc(100% - 72px);padding:32px;border-radius:20px;box-shadow:0 12px 50px #17243a12}h1{margin:0 0 8px;font-size:26px}p{color:#697589;line-height:1.5}label{display:block;margin:22px 0 8px;font-size:14px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d5dbe7;border-radius:8px;font:inherit}button{width:100%;margin-top:24px;background:#305dce;color:white;border:0;border-radius:8px;padding:13px;font:600 15px system-ui;cursor:pointer}.error{color:#b42318}</style><main><h1>Syntonomy Meili</h1><p>Connectez-vous à votre espace de recherche.</p>${error ? '<p class="error">Identifiant ou mot de passe incorrect.</p>' : ''}<form method="post" action="/_auth/login"><label for="username">Identifiant</label><input id="username" name="username" autocomplete="username" required><label for="password">Mot de passe</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>Se connecter</button></form></main></html>`;

/** Public gateway: each request uses the current account permissions, never client claims. */
export async function createAccessServer(config) {
    if (!config.engineKey || !config.engineUrl || !config.origin) throw new Error('Incomplete access gateway configuration');
    let store;
    async function persist(value) {
        await mkdir(dirname(config.storePath), { recursive: true, mode: 0o700 });
        await writeFile(`${config.storePath}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        await rename(`${config.storePath}.tmp`, config.storePath);
    }
    try { store = JSON.parse(await readFile(config.storePath, 'utf8')); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!config.bootstrap?.username || !config.bootstrap?.password) throw new Error('Administrator bootstrap missing');
        const now = new Date().toISOString();
        store = { schemaVersion: 1, signingKey: randomBytes(32).toString('hex'), users: [{ id: randomUUID(), username: config.bootstrap.username, displayName: 'Pegolotti', role: 'admin', indexes: ['*'], active: true, passwordHash: await hashPassword(config.bootstrap.password), revision: 1, createdAt: now, updatedAt: now }] };
        await persist(store);
    }
    if (store.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(store.signingKey) || !store.users.some(u => u.active && u.role === 'admin')) throw new Error('Invalid account store');
    const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
    const attempts = new Map();
    let queue = Promise.resolve();
    function serial(action) { const result = queue.then(action); queue = result.catch(() => {}); return result; }
    function rateAttempt(req) {
        const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
        const now = Date.now();
        if (attempts.size >= 2000) for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
        if (attempts.size >= 2000 && !attempts.has(ip)) throw fail(429, 'Veuillez réessayer plus tard.', 'rate_limited');
        const window = attempts.get(ip) ?? { count: 0, until: now + 900000 };
        if (window.until <= now) { window.count = 0; window.until = now + 900000; }
        if (window.count >= 10) throw fail(429, 'Veuillez réessayer dans quelques minutes.', 'rate_limited');
        window.count++; attempts.set(ip, window); return ip;
    }
    async function engine(path, key = config.engineKey, method = 'GET', value) {
        const response = await fetch(new URL(path, config.engineUrl), { method, headers: { Authorization: `Bearer ${key}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(30000) });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            console.error('Engine operation refused:', response.status, error.code ?? 'unknown');
            throw fail(response.status >= 500 ? 502 : response.status, 'Opération Meilisearch refusée ou indisponible.', 'engine_error');
        }
        return response.status === 204 ? null : response.json();
    }
    async function newKey(user) {
        if (user.role === 'admin' || !user.active || !user.indexes.length) return null;
        const value = await engine('/keys', config.engineKey, 'POST', { name: `Syntonomy user ${user.id}`, description: `Dashboard role ${user.role}`, actions: user.role === 'gestionnaire' ? MANAGER_ACTIONS : READ_ACTIONS, indexes: user.indexes, expiresAt: null });
        return { uid: value.uid, key: value.key };
    }
    async function revokeKey(key) {
        if (!key) return;
        try { await engine(`/keys/${key.uid}`, config.engineKey, 'DELETE'); }
        catch (error) { if (error.status !== 404) console.error('Scoped key revocation failed:', key.uid); }
    }
    function cookieIdentity(req) {
        const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
        if (!cookie || cookie.length > 2048) return null;
        try {
            const parts = cookie.split('.');
            if (parts.length !== 2 || !same(sign(store.signingKey, parts[0]), parts[1])) return null;
            const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
            const user = store.users.find(u => u.id === value.u && u.active && u.revision === value.r);
            return user && value.e > Date.now() ? { user, basic: false } : null;
        } catch { return null; }
    }
    async function identity(req) {
        const cookie = cookieIdentity(req); if (cookie) return cookie;
        const header = req.headers.authorization || '';
        if (!header.startsWith('Basic ') || header.length > 1024) return null;
        const ip = rateAttempt(req);
        const decoded = Buffer.from(header.slice(6), 'base64').toString(); const split = decoded.indexOf(':');
        const user = store.users.find(u => u.username === decoded.slice(0, split).toLowerCase() && u.active);
        if (split < 0 || !(await verifyPassword(decoded.slice(split + 1), user?.passwordHash ?? dummyHash)) || !user || !store.users.includes(user)) return null;
        attempts.delete(ip); return { user, basic: true };
    }
    function requireOrigin(req, auth) {
        if (auth?.basic && !req.headers.origin) return;
        if (req.headers.origin !== config.origin) throw fail(403, 'Origine de la requête refusée.', 'invalid_origin');
    }
    function setSession(res, user) {
        const payload = Buffer.from(JSON.stringify({ u: user.id, r: user.revision, e: Date.now() + 28800000, n: randomBytes(12).toString('hex') })).toString('base64url');
        res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(store.signingKey, payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`);
    }
    async function manageUsers(req, res, auth, parts) {
        if (auth.user.role !== 'admin') throw fail(403, 'La gestion des utilisateurs est réservée aux administrateurs.');
        if (parts.length === 3 && req.method === 'GET') return json(res, 200, { users: store.users.map(publicUser) });
        if (!['POST', 'PATCH', 'DELETE'].includes(req.method) || (req.method === 'POST' ? parts.length !== 3 : parts.length !== 4)) throw fail(405, 'Méthode refusée.');
        requireOrigin(req, auth);
        const input = req.method === 'DELETE' ? {} : await jsonBody(req);
        return serial(async () => {
            const actor = store.users.find(u => u.id === auth.user.id && u.active && u.revision === auth.user.revision && u.role === 'admin');
            if (!actor) throw fail(401, 'Session expirée.', 'authentication_required');
            const previous = req.method === 'POST' ? null : store.users.find(u => u.id === parts[3]);
            if (req.method !== 'POST' && !previous) throw fail(404, 'Utilisateur introuvable.', 'user_not_found');
            if (req.method === 'DELETE') {
                if (previous.id === actor.id) throw fail(409, 'Vous ne pouvez pas supprimer votre propre compte.', 'self_admin_protection');
                if (previous.active && previous.role === 'admin' && store.users.filter(u => u.active && u.role === 'admin').length === 1) throw fail(409, 'Un administrateur actif doit être conservé.', 'last_admin');
                const next = { ...store, users: store.users.filter(u => u.id !== previous.id) };
                await persist(next); store = next; await revokeKey(previous.meiliKey); return json(res, 200, { deleted: true });
            }
            const valid = validate(input, previous);
            if (store.users.some(u => u.username === valid.username && u.id !== previous?.id)) throw fail(409, 'Cet identifiant existe déjà.', 'duplicate_user');
            if (previous?.id === actor.id && (!valid.active || valid.role !== 'admin')) throw fail(409, 'Vous ne pouvez pas retirer vos propres droits administrateur.', 'self_admin_protection');
            if (previous?.active && previous.role === 'admin' && (!valid.active || valid.role !== 'admin') && store.users.filter(u => u.active && u.role === 'admin').length === 1) throw fail(409, 'Un administrateur actif doit être conservé.', 'last_admin');
            if (!previous && store.users.length >= 1000) throw fail(400, 'Limite de comptes atteinte.');
            if (valid.role !== 'admin' && valid.indexes.length) {
                const inventory = await engine('/indexes?limit=10000'); const known = new Set(inventory.results.map(x => x.uid));
                if (valid.indexes.some(x => !known.has(x))) throw fail(400, 'Un des index sélectionnés n’existe plus.', 'unknown_index');
            }
            const now = new Date().toISOString();
            const user = { ...previous, ...valid, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now, revision: (previous?.revision ?? 0) + 1, passwordHash: input.password !== undefined ? await hashPassword(input.password) : previous.passwordHash };
            user.meiliKey = await newKey(user);
            const next = { ...store, users: previous ? store.users.map(u => u.id === user.id ? user : u) : [...store.users, user] };
            try { await persist(next); } catch (error) { await revokeKey(user.meiliKey); throw error; }
            store = next; await revokeKey(previous?.meiliKey);
            if (user.id === actor.id) setSession(res, user);
            json(res, previous ? 200 : 201, { user: publicUser(user) });
        });
    }
    function forward(req, res, target, key, bufferedBody) {
        const headers = { ...req.headers, host: target.host };
        for (const name of ['cookie', 'authorization', 'connection', 'proxy-authorization', 'x-syntonomy-user', 'x-syntonomy-role', 'x-meili-api-key', 'x-forwarded-host', 'x-forwarded-proto']) delete headers[name];
        if (key) headers.authorization = `Bearer ${key}`;
        if (bufferedBody !== undefined) headers['content-length'] = Buffer.byteLength(bufferedBody);
        const upstream = http.request(target, { method: req.method, headers }, result => {
            const responseHeaders = { ...result.headers, 'cache-control': 'no-store' }; delete responseHeaders['set-cookie'];
            res.writeHead(result.statusCode, responseHeaders); result.pipe(res);
        });
        upstream.setTimeout(120000, () => upstream.destroy());
        upstream.on('error', () => { if (!res.headersSent) json(res, 502, { message: 'Service temporairement indisponible.', code: 'upstream_unavailable' }); else res.end(); });
        req.on('aborted', () => upstream.destroy());
        if (bufferedBody === undefined) req.pipe(upstream); else upstream.end(bufferedBody);
    }
    async function proxyEngine(req, res, auth, url, parts) {
        const user = auth.user;
        const index = parts[1] === 'indexes' ? parts[2] : null;
        const engineParts = parts.slice(1);
        const path = '/' + engineParts.map(x => encodeURIComponent(x)).join('/');
        const target = new URL(path, config.engineUrl); target.search = url.search;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) requireOrigin(req, auth);
        if (user.role === 'admin') return forward(req, res, target, config.engineKey);
        const allowed = uid => user.indexes.includes(uid); const key = user.meiliKey?.key;
        if (index && !allowed(index)) throw fail(403, 'Cet index n’est pas associé à votre compte.', 'index_forbidden');
        if (path === '/health' || path === '/version') {
            if (req.method !== 'GET') throw fail(403, 'Opération refusée.');
            // Version is a global action and cannot be attached to index-scoped keys.
            return json(res, 200, await engine(path));
        }
        if (path === '/indexes' && req.method === 'GET') {
            if (!key) return json(res, 200, { results: [], offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 20), total: 0 });
            const data = await engine(target.pathname + target.search, key);
            if (data.results.some(x => !allowed(x.uid))) throw fail(502, 'Réponse Meilisearch non conforme.', 'scope_violation');
            return json(res, 200, data);
        }
        if (path === '/stats' && req.method === 'GET') {
            const data = key ? await engine('/stats', key) : { indexes: {} };
            const indexes = Object.fromEntries(Object.entries(data.indexes).filter(([uid]) => allowed(uid)));
            return json(res, 200, { indexes, databaseSize: 0, lastUpdate: null, isIndexing: Object.values(indexes).some(x => x.isIndexing) });
        }
        if (engineParts[0] === 'tasks' && req.method === 'GET') {
            if (!key) { if (engineParts.length !== 1) throw fail(404, 'Tâche introuvable.'); return json(res, 200, { results: [], total: 0, limit: 20, from: null, next: null }); }
            if (engineParts.length === 1) {
                const requested = url.searchParams.get('indexUids')?.split(',');
                if (requested?.some(uid => !allowed(uid))) throw fail(403, 'Index de tâche non autorisé.', 'index_forbidden');
                target.searchParams.set('indexUids', (requested ?? user.indexes).join(','));
                const data = await engine(target.pathname + target.search, key);
                if (data.results.some(x => !allowed(x.indexUid))) throw fail(502, 'Réponse de tâches non conforme.', 'scope_violation');
                return json(res, 200, data);
            }
            if (engineParts.length === 2 && /^\d+$/.test(engineParts[1])) {
                const data = await engine(path, key);
                if (!allowed(data.indexUid)) throw fail(404, 'Tâche introuvable.', 'task_not_found');
                return json(res, 200, data);
            }
        }
        if (path === '/multi-search' && req.method === 'POST') {
            const data = await jsonBody(req);
            if (!Array.isArray(data.queries) || !data.queries.length || data.queries.some(q => !allowed(q.indexUid))) throw fail(403, 'Un des index de recherche est interdit.', 'index_forbidden');
            if (data.federation?.remote || data.queries.some(q => q.federationOptions?.remote)) throw fail(403, 'Recherche distante interdite.');
            return forward(req, res, target, key, JSON.stringify(data));
        }
        if (index && key) {
            const rest = engineParts.slice(2);
            const read = req.method === 'GET' && (rest.length === 0 || ['documents', 'stats', 'settings'].includes(rest[0]));
            const search = req.method === 'POST' && rest.length === 1 && ['search', 'facet-search'].includes(rest[0]);
            const fetchDocuments = req.method === 'POST' && rest.length === 2 && rest[0] === 'documents' && rest[1] === 'fetch';
            const edit = user.role === 'gestionnaire' && ((rest.length === 0 && req.method === 'PATCH') || (['documents', 'settings'].includes(rest[0]) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)));
            if (read || search || fetchDocuments || edit) return forward(req, res, target, key);
        }
        throw fail(403, 'Cette opération n’est pas autorisée pour votre rôle.', 'role_forbidden');
    }
    const server = http.createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Referrer-Policy', 'same-origin');
        try {
            if (!req.url.startsWith('/') || req.url.startsWith('//')) throw fail(400, 'Chemin invalide.', 'invalid_path');
            const rawPath = req.url.split('?')[0]; const decoded = rawPath.split('/').map(x => decodeURIComponent(x));
            if (decoded.some(x => x.includes('/') || x.includes('\\') || x === '.' || x === '..' || x.includes('%') || /[\x00-\x1f]/.test(x))) throw fail(400, 'Chemin invalide.', 'invalid_path');
            const parts = decoded.filter(Boolean); const url = new URL(req.url, config.origin);
            if (rawPath === '/_auth/health') return res.end('ok');
            if (rawPath === '/_auth/login') {
                res.setHeader('Cache-Control', 'no-store');
                if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(loginPage(false)); }
                if (req.method !== 'POST') throw fail(405, 'Méthode refusée.');
                requireOrigin(req); const ip = rateAttempt(req);
                const fields = new URLSearchParams(await body(req, 8192));
                const user = store.users.find(u => u.username === String(fields.get('username') || '').toLowerCase().trim() && u.active);
                if (!(await verifyPassword(String(fields.get('password') || ''), user?.passwordHash ?? dummyHash)) || !user || !store.users.includes(user)) { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(loginPage(true)); }
                attempts.delete(ip); setSession(res, user); res.writeHead(303, { Location: '/' }); return res.end();
            }
            const auth = await identity(req);
            if (!auth) {
                if (url.pathname.startsWith('/api/')) return json(res, 401, { message: 'Session expirée. Reconnectez-vous.', code: 'authentication_required' });
                res.writeHead(302, { Location: '/_auth/login' }); return res.end();
            }
            if (rawPath === '/_auth/logout' && req.method === 'POST') {
                requireOrigin(req, auth); res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
                await serial(async () => { const next = { ...store, users: store.users.map(u => u.id === auth.user.id ? { ...u, revision: u.revision + 1 } : u) }; await persist(next); store = next; });
                res.writeHead(303, { Location: '/_auth/login' }); return res.end();
            }
            if (rawPath === '/api/access/me' && req.method === 'GET') return json(res, 200, { user: publicUser(auth.user) });
            if (parts[0] === 'api' && parts[1] === 'access') {
                if (parts[2] === 'users') return await manageUsers(req, res, auth, parts);
                throw fail(404, 'Route introuvable.');
            }
            if (parts[0] === 'api' && parts[1] === 'meilisearch') return await proxyEngine(req, res, auth, url, parts.slice(1));
            const publicReadApi = rawPath === '/api/config' || /^\/api\/_nuxt_icon\/[a-z0-9_-]+$/.test(rawPath);
            if (parts[0]?.toLowerCase() === 'api' && (!publicReadApi || req.method !== 'GET')) throw fail(404, 'Route introuvable.');
            if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Méthode refusée.');
            forward(req, res, new URL(req.url, config.dashboardUrl ?? 'http://dashboard:3000'));
        } catch (error) {
            if (!res.headersSent) json(res, error.status ?? (error instanceof URIError ? 400 : 500), { message: error.status ? error.message : 'Opération indisponible.', code: error.code ?? 'internal_error' });
            else res.end();
            if (!error.status && !(error instanceof URIError)) console.error('Access gateway failure:', error.name);
        }
    });
    return server;
}
