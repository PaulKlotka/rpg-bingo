// Keep organization-wide domain sharing restrictions intact. Public player invocation uses
// Cloud Run's documented invokerIamDisabled setting; application Auth + App Check still apply.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.env.NODE_USE_SYSTEM_CA !== '1') {
  const child = spawnSync(process.execPath, [__filename], { stdio: 'inherit', env: { ...process.env, NODE_USE_SYSTEM_CA: '1' } });
  process.exit(child.status ?? 1);
}
process.env.XDG_CONFIG_HOME = path.resolve('.firebase-config');
const auth = require('firebase-tools/lib/auth');
const { Client, setRefreshToken } = require('firebase-tools/lib/apiv2');
const projectId = 'rpg-rewards-paul';

async function configure() {
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Sign in first: node scripts/firebase.mjs login');
  setRefreshToken(account.tokens.refresh_token);
  const client = new Client({ urlPrefix: 'https://run.googleapis.com', auth: true });
  const name = `projects/${projectId}/locations/us-central1/services/playercommand`;
  // The service-level v1 annotation avoids recreating a Cloud Functions-managed revision.
  const regional = new Client({ urlPrefix: 'https://us-central1-run.googleapis.com', auth: true });
  const resource = `/apis/serving.knative.dev/v1/namespaces/${projectId}/services/playercommand`;
  const current = (await regional.get(resource)).body;
  if (current.metadata.annotations?.['run.googleapis.com/invoker-iam-disabled'] !== 'true') {
    const metadata = current.metadata;
    await regional.put(resource, {
      apiVersion: current.apiVersion, kind: current.kind,
      metadata: {
        name: metadata.name, namespace: metadata.namespace, resourceVersion: metadata.resourceVersion,
        labels: metadata.labels,
        annotations: { ...metadata.annotations, 'run.googleapis.com/invoker-iam-disabled': 'true' },
      },
      spec: current.spec,
    });
  }
  const configured = await client.get(`/v2/${name}`);
  if (configured.body.invokerIamDisabled !== true) throw new Error('Player HTTP invocation was not enabled.');
  // Never make either backend-only endpoint public.
  for (const service of ['gameapi', 'cleanupexpiredsessions']) {
    const check = await client.get(`/v2/projects/${projectId}/locations/us-central1/services/${service}`);
    if (check.body.invokerIamDisabled) throw new Error(`${service} unexpectedly permits public invocation.`);
  }
  console.log('Player HTTP endpoint enabled; Firebase Authentication and App Check enforced. Game API and cleanup remain private.');
}
configure().catch(error => { console.error(error.message); process.exitCode = 1; });
