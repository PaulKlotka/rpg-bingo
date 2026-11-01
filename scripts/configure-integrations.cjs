// Uses the existing local Firebase login. Tokens and grants are never printed.
process.env.RPG_FIREBASE_CONFIG_DIR = require('node:path').resolve(__dirname, '../integrations/between-turns/.firebase-config');
const { api } = require('../integrations/between-turns/scripts/cloud-admin.cjs');
const region = 'us-central1';
async function allowInvoker(project, service, accounts) {
  const resource = `/v2/projects/${project}/locations/${region}/services/${service}`;
  const policy = await api('https://run.googleapis.com', 'get', resource + ':getIamPolicy');
  policy.bindings ??= [];
  let binding = policy.bindings.find(b => b.role === 'roles/run.invoker' && !b.condition);
  if (!binding) { binding = { role: 'roles/run.invoker', members: [] }; policy.bindings.push(binding); }
  binding.members = [...new Set([...binding.members, ...accounts.map(account => 'serviceAccount:' + account)])];
  await api('https://run.googleapis.com', 'post', resource + ':setIamPolicy', { policy });
  const state = await api('https://run.googleapis.com', 'get', resource);
  if (state.invokerIamDisabled) throw new Error('Private backend unexpectedly allows public invocation: ' + service);
  console.log(`Configured scoped backend invocation: ${project}/${service}`);
}
async function enableBrowserTransport(project, service) {
  const origin = `https://${region}-run.googleapis.com`;
  const resource = `/apis/serving.knative.dev/v1/namespaces/${project}/services/${service}`;
  const current = await api(origin, 'get', resource);
  if (current.metadata.annotations?.['run.googleapis.com/invoker-iam-disabled'] !== 'true') {
    await api(origin, 'put', resource, {
      apiVersion: current.apiVersion, kind: current.kind,
      metadata: { name: current.metadata.name, namespace: current.metadata.namespace, resourceVersion: current.metadata.resourceVersion, labels: current.metadata.labels, annotations: { ...current.metadata.annotations, 'run.googleapis.com/invoker-iam-disabled': 'true' } }, spec: current.spec,
    });
  }
  const state = await api('https://run.googleapis.com', 'get', `/v2/projects/${project}/locations/${region}/services/${service}`);
  if (!state.invokerIamDisabled) throw new Error('Browser transport was not enabled: ' + service);
  console.log(`Enabled protected browser transport: ${project}/${service}`);
}
(async () => {
  const bingo = 'bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com';
  const rewards = 'rewards-runtime@rpg-rewards-paul.iam.gserviceaccount.com';
  await allowInvoker('between-turns-paul', 'integrationapi', [bingo, rewards]);
  await allowInvoker('rpg-rewards-paul', 'gameapi', [bingo]);
  for (const project of ['rpg-bingo-paul', 'rpg-rewards-paul']) await enableBrowserTransport(project, 'embeddedapi');
  await enableBrowserTransport('between-turns-paul', 'playercommand');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
