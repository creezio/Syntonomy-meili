import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAccessServer } from '../ops/access-control.mjs';

const suffix = randomBytes(8).toString('hex');
const fixtures = ['a', 'b'].map(x => `syntonomy_rbac_qa_${suffix}_${x}`);
const origin = 'https://syntonomy-access-test.invalid';
const engineUrl = process.env.NUXT_MEILISEARCH_HOST;
const engineKey = process.env.NUXT_MEILISEARCH_API_KEY;
const directory = await mkdtemp(join(tmpdir(), 'syntonomy-access-live-'));
const storePath = join(directory, 'users.json');
const password = randomBytes(24).toString('hex');
let gateway;
let endpoint;
let admin;
const users = [];
async function engine(path, method = 'GET', data, token = engineKey) {
    const r = await fetch(new URL(path, engineUrl), { method, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await r.text(); return { status: r.status, data: value ? JSON.parse(value) : null };
}
async function waitTask(task) {
    for (let n = 0; n < 100; n++) {
        const result = await engine(`/tasks/${task.taskUid}`);
        if (result.data.status === 'succeeded') return;
        assert.notEqual(result.data.status, 'failed', result.data.error?.message);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Fixture task timeout');
}
async function call(path, cookie, method = 'GET', value) {
    const response = await fetch(endpoint + path, { method, redirect: 'manual', headers: { Cookie: cookie, Origin: origin, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
    const text = await response.text(); return { status: response.status, data: text ? JSON.parse(text) : null };
}
async function login(username) {
    const response = await fetch(endpoint + '/_auth/login', { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }) });
    assert.equal(response.status, 303); return response.headers.get('set-cookie').split(';')[0];
}
try {
    for (const uid of fixtures) {
        const created = await engine('/indexes', 'POST', { uid, primaryKey: 'id' }); assert.equal(created.status, 202); await waitTask(created.data);
        const docs = await engine(`/indexes/${uid}/documents`, 'POST', [{ id: 'fixture', name: uid }]); await waitTask(docs.data);
    }
    gateway = await createAccessServer({ origin, storePath, bootstrap: { username: 'qaadmin', password }, engineUrl, engineKey });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${gateway.address().port}`;
    admin = await login('qaadmin');
    for (const role of ['lecteur', 'gestionnaire']) {
        const created = await call('/api/access/users', admin, 'POST', { username: role, displayName: role, role, indexes: [fixtures[0]], password });
        assert.equal(created.status, 201); users.push(created.data.user);
        const session = await login(role);
        const indexes = await call('/api/meilisearch/indexes?limit=10000', session);
        assert.equal(indexes.status, 200); assert.deepEqual(indexes.data.results.map(x => x.uid), [fixtures[0]]); assert.equal(indexes.data.total, 1);
        const stats = await call('/api/meilisearch/stats', session); assert.equal(stats.status, 200); assert.deepEqual(Object.keys(stats.data.indexes), [fixtures[0]]);
        assert.equal((await call(`/api/meilisearch/indexes/${fixtures[1]}/documents`, session)).status, 403);
        assert.equal((await call('/api/meilisearch/keys', session)).status, 403);
        const read = await call(`/api/meilisearch/indexes/${fixtures[0]}/search`, session, 'POST', { q: '' }); assert.equal(read.status, 200); assert.equal(read.data.hits[0].id, 'fixture');
        const write = await call(`/api/meilisearch/indexes/${fixtures[0]}/documents`, session, 'POST', [{ id: 'managed', name: 'test' }]);
        assert.equal(write.status, role === 'lecteur' ? 403 : 202);
        if (role === 'gestionnaire') {
            await waitTask(write.data);
            const settings = await call(`/api/meilisearch/indexes/${fixtures[0]}/settings`, session, 'PATCH', { searchableAttributes: ['name'] });
            assert.equal(settings.status, 202); await waitTask(settings.data);
            const task = await call(`/api/meilisearch/tasks/${settings.data.taskUid}`, session); assert.equal(task.status, 200); assert.equal(task.data.indexUid, fixtures[0]);
        }
        const tasks = await call('/api/meilisearch/tasks?limit=100', session); assert.equal(tasks.status, 200); assert(tasks.data.results.every(x => x.indexUid === fixtures[0]));
        assert.equal((await call(`/api/meilisearch/indexes/${fixtures[0]}`, session, 'DELETE')).status, 403);
        assert.equal((await call(`/api/access/users/${created.data.user.id}`, admin, 'PATCH', { indexes: [fixtures[1]] })).status, 200);
        assert.equal((await call('/api/access/me', session)).status, 401);
        const changed = await login(role);
        assert.equal((await call(`/api/meilisearch/indexes/${fixtures[0]}`, changed)).status, 403);
        assert.equal((await call(`/api/meilisearch/indexes/${fixtures[1]}`, changed)).status, 200);
    }
    console.log(JSON.stringify({ status: 'passed', checks: ['scoped engine keys', 'index lists and statistics isolation', 'reader write denial', 'manager documents and settings', 'task isolation', 'permission changes invalidate sessions'], fixtures: 'temporary indexes only' }));
} finally {
    if (gateway) {
        for (const user of users) { const result = await call(`/api/access/users/${user.id}`, admin, 'DELETE'); assert.equal(result.status, 200); }
        await new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); });
    }
    for (const uid of fixtures) {
        assert(uid.startsWith(`syntonomy_rbac_qa_${suffix}_`));
        const removed = await engine(`/indexes/${uid}`, 'DELETE'); if (removed.status === 202) await waitTask(removed.data); else assert.equal(removed.status, 404);
    }
    assert(resolve(directory).startsWith(resolve(tmpdir()) + '/syntonomy-access-live-'));
    await unlink(storePath).catch(error => { if (error.code !== 'ENOENT') throw error; }); await rmdir(directory);
}
