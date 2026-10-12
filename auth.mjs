import { readFile } from 'node:fs/promises';
import { createAccessServer } from './access-control.mjs';
const bootstrap = JSON.parse(await readFile('/run/dashboard-login.json', 'utf8'));
const server = await createAccessServer({
    origin: bootstrap.url,
    bootstrap,
    storePath: '/run/dashboard-users/users.json',
    engineUrl: process.env.NUXT_MEILISEARCH_HOST,
    engineKey: process.env.NUXT_MEILISEARCH_API_KEY,
});
server.listen(8080, '0.0.0.0');
