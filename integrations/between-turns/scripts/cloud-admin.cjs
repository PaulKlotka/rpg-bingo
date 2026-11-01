// Administrative API helper. Reuses the local Firebase CLI login; never prints tokens.
const path = require('node:path');
process.env.XDG_CONFIG_HOME = process.env.RPG_FIREBASE_CONFIG_DIR || path.resolve('.firebase-config');
const auth = require('../node_modules/firebase-tools/lib/auth');
const { Client, setRefreshToken } = require('../node_modules/firebase-tools/lib/apiv2');
const account = auth.getGlobalDefaultAccount();
if (!account) throw new Error('Run npm run firebase -- login first.');
setRefreshToken(account.tokens.refresh_token);
const clients = new Map();
async function api(origin, method, resource, body) {
  if (!clients.has(origin)) clients.set(origin, new Client({ urlPrefix: origin, auth: true }));
  const client = clients.get(origin);
  return (method === 'get' ? await client.get(resource) : await client[method](resource, body)).body;
}
async function operation(origin, initial, version = 'v1') {
  if (!initial.name || initial.done) { if (initial.error) throw new Error(initial.error.message); return initial; }
  for (let i = 0; i < 90; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const status = await api(origin, 'get', `/${version}/${initial.name}`);
    if (status.error) throw new Error(status.error.message);
    if (status.done) return status;
  }
  throw new Error(`Operation still pending: ${initial.name}`);
}
module.exports = { api, operation };
