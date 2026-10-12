import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAccessServer } from '../ops/access-control.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('account lifecycle, role boundaries, index isolation and session revocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syntonomy-access-test-'));
    const storePath = join(directory, 'users.json');
    const keys = new Map();
    let writes = 0;
    const engine = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fixture');
        const token = (req.headers.authorization || '').slice(7);
        const key = keys.get(token);
        const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
        let source = ''; for await (const chunk of req) source += chunk;
        if (token !== 'operator-key' && !key) return send(401, {});
        if (url.pathname === '/keys' && req.method === 'POST') {
            const data = JSON.parse(source); const uid = `key-${keys.size + 1}-${Date.now()}`; const token = `${uid}-secret`;
            keys.set(token, { ...data, uid }); return send(201, { uid, key: token });
        }
        if (url.pathname.startsWith('/keys/') && req.method === 'DELETE') {
            for (const [token, value] of keys) if (value.uid === url.pathname.split('/')[2]) keys.delete(token);
            res.writeHead(204).end(); return;
        }
        if (url.pathname === '/indexes') {
            const indexes = ['products', 'private'].filter(uid => !key || key.indexes.includes(uid));
            return send(200, { results: indexes.map(uid => ({ uid })), total: indexes.length, offset: 0, limit: 20 });
        }
        if (url.pathname === '/stats') return send(200, { databaseSize: 999, lastUpdate: 'private-time', indexes: { products: { numberOfDocuments: 1 }, private: { numberOfDocuments: 9 } } });
        if (url.pathname === '/tasks') return send(200, { results: url.searchParams.get('indexUids').split(',').map(indexUid => ({ uid: 1, indexUid })), total: 1, limit: 20, next: null });
        if (url.pathname === '/tasks/99') return send(200, { indexUid: 'private' });
        if (!['GET', 'HEAD'].includes(req.method)) writes++;
        send(200, { ok: true, hits: [], numberOfDocuments: 1 });
    });
    const engineUrl = await listen(engine);
    const config = { storePath, origin: 'https://dashboard.example', engineUrl, engineKey: 'operator-key', bootstrap: { username: 'pegolotti', password: 'administrator-password-123' }, dashboardUrl: engineUrl };
    let gateway = await createAccessServer(config);
    let endpoint = await listen(gateway);
    const request = async (path, cookie, method = 'GET', value, origin = config.origin) => {
        const response = await fetch(endpoint + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && origin ? { Origin: origin } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
        return { status: response.status, data: await response.text(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    async function login(username, password) {
        const response = await fetch(endpoint + '/_auth/login', { method: 'POST', redirect: 'manual', headers: { Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }) });
        assert.equal(response.status, 303); assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
        return response.headers.get('set-cookie').split(';')[0];
    }
    try {
        assert.equal((await request('/api/access/users')).status, 401);
        const admin = await login('pegolotti', config.bootstrap.password);
        const adminInfo = JSON.parse((await request('/api/access/me', admin)).data).user;
        assert.equal(adminInfo.role, 'admin');
        assert.equal((await request(`/api/access/users/${adminInfo.id}`, admin, 'PATCH', { role: 'lecteur' })).status, 409);
        assert.equal((await request(`/api/access/users/${adminInfo.id}`, admin, 'DELETE')).status, 409);
        assert.equal((await request('/api/access/users', admin, 'POST', { username: 'weak', role: 'lecteur', password: 'short' })).status, 400);
        assert.equal((await request('/api/access/users', admin, 'POST', { username: 'wild', role: 'lecteur', password: 'long-password-123', indexes: ['*'] })).status, 400);
        assert.equal((await request('/api/access/users', admin, 'POST', { username: 'missing', role: 'lecteur', password: 'long-password-123', indexes: ['missing'] })).status, 400);
        const create = async (username, role, indexes = ['products']) => {
            const result = await request('/api/access/users', admin, 'POST', { username, displayName: username, role, password: 'long-password-123', indexes });
            assert.equal(result.status, 201); assert.doesNotMatch(result.data, /passwordHash|meiliKey|secret/); return JSON.parse(result.data).user;
        };
        const readerUser = await create('reader', 'lecteur');
        const managerUser = await create('manager', 'gestionnaire');
        const emptyUser = await create('empty', 'lecteur', []);
        const reader = await login('reader', 'long-password-123');
        const manager = await login('manager', 'long-password-123');
        const empty = await login('empty', 'long-password-123');
        assert.equal((await request('/api/access/users', reader)).status, 403);
        assert.equal((await request('/api/access/users', manager)).status, 403);
        assert.equal(JSON.parse((await request('/api/meilisearch/indexes', reader)).data).total, 1);
        assert.equal(JSON.parse((await request('/api/meilisearch/indexes', empty)).data).total, 0);
        const stats = JSON.parse((await request('/api/meilisearch/stats', reader)).data);
        assert.deepEqual(Object.keys(stats.indexes), ['products']); assert.equal(stats.databaseSize, 0); assert.equal(stats.lastUpdate, null);
        assert.equal((await request('/api/meilisearch/indexes/products/search', reader, 'POST', { q: 'test' })).status, 200);
        assert.equal((await request('/api/meilisearch/indexes/products/documents/fetch', reader, 'POST', {})).status, 200);
        const before = writes;
        for (const cookie of [reader, manager]) {
            assert.equal((await request('/api/meilisearch/indexes/private/documents', cookie)).status, 403);
            assert.equal((await request('/api/meilisearch/keys', cookie)).status, 403);
            assert.equal((await request('/api/meilisearch/dumps', cookie, 'POST', {})).status, 403);
            assert.equal((await request('/api/meilisearch/indexes/products', cookie, 'DELETE')).status, 403);
            assert.equal((await request('/api/meilisearch/tasks/99', cookie)).status, 404);
            assert.equal((await request('/api/meilisearch/multi-search', cookie, 'POST', { queries: [{ indexUid: 'private' }] })).status, 403);
        }
        assert.equal((await request('/api/meilisearch/indexes/products/documents', reader, 'POST', [{ id: 'forbidden' }])).status, 403);
        assert.equal((await request('/api/meilisearch/indexes/products/settings', reader, 'PATCH', {})).status, 403);
        assert.equal(writes, before);
        assert.equal((await request('/api/meilisearch/indexes/products/settings', manager, 'PATCH', {})).status, 200);
        assert.equal((await request('/api/meilisearch/indexes/products/documents', manager, 'POST', [{ id: 'allowed' }])).status, 200);
        assert.equal((await request('/api/meilisearch/indexes/products/settings', manager, 'PATCH', {}, 'https://evil.example')).status, 403);
        assert.equal((await request('/api/meilisearch/indexes/products/settings', manager, 'PATCH', {}, '')).status, 403);
        assert.equal((await request('/api/meilisearch/indexes/products%2F..%2Fprivate/documents', manager)).status, 400);
        assert.equal((await request('/API/meilisearch/indexes/private', reader)).status, 404);
        assert.equal((await request('/api/meilisearch/tasks?indexUids=private', reader)).status, 403);
        assert.equal((await request('/api/access/me', reader + 'tamper')).status, 401);
        assert.equal((await request(`/api/access/users/${readerUser.id}`, admin, 'PATCH', { indexes: ['private'] })).status, 200);
        assert.equal((await request('/api/access/me', reader)).status, 401);
        const changedReader = await login('reader', 'long-password-123');
        assert.equal((await request('/api/meilisearch/indexes/products', changedReader)).status, 403);
        assert.equal((await request('/api/meilisearch/indexes/private', changedReader)).status, 200);
        assert.equal((await request(`/api/access/users/${managerUser.id}`, admin, 'PATCH', { active: false })).status, 200);
        assert.equal((await request('/api/access/me', manager)).status, 401);
        assert.equal((await request(`/api/access/users/${readerUser.id}`, admin, 'PATCH', { password: 'replacement-password-456' })).status, 200);
        assert.equal((await request('/api/access/me', changedReader)).status, 401);
        const resetReader = await login('reader', 'replacement-password-456');
        assert.equal((await request('/_auth/logout', resetReader, 'POST')).status, 303);
        assert.equal((await request('/api/access/me', resetReader)).status, 401);
        assert.equal((await request(`/api/access/users/${emptyUser.id}`, admin, 'DELETE')).status, 200);
        const stored = await readFile(storePath, 'utf8');
        assert.doesNotMatch(stored, /administrator-password-123|replacement-password-456|long-password-123/);
        assert.match(stored, /scrypt:/);
        await close(gateway);
        gateway = await createAccessServer(config); endpoint = await listen(gateway);
        assert.equal(JSON.parse((await request('/api/access/users', admin)).data).users.length, 3);
        const concurrent = await Promise.all([create('one', 'lecteur'), create('two', 'lecteur')]);
        assert.equal(concurrent.length, 2);
        assert.equal(JSON.parse((await request('/api/access/users', admin)).data).users.length, 5);
    } finally {
        await close(gateway); await close(engine);
        assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + '/syntonomy-access-test-') || resolve(directory).startsWith(resolve(tmpdir()) + '\\syntonomy-access-test-'), true);
        await unlink(storePath); await rmdir(directory);
    }
});
