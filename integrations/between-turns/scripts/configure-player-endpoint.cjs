// Browser transport is public; Firebase Auth and App Check remain enforced.
// Backend integration and scheduled maintenance remain IAM protected.
const { api } = require('./cloud-admin.cjs');
const project = 'between-turns-paul';
(async () => {
  const regional = 'https://us-central1-run.googleapis.com';
  const resource = '/apis/serving.knative.dev/v1/namespaces/' + project + '/services/playercommand';
  const current = await api(regional, 'get', resource);
  if (current.metadata.annotations?.['run.googleapis.com/invoker-iam-disabled'] !== 'true') {
    await api(regional, 'put', resource, {
      apiVersion: current.apiVersion, kind: current.kind,
      metadata: { name: current.metadata.name, namespace: current.metadata.namespace, resourceVersion: current.metadata.resourceVersion, labels: current.metadata.labels, annotations: { ...current.metadata.annotations, 'run.googleapis.com/invoker-iam-disabled': 'true' } },
      spec: current.spec
    });
  }
  for (const name of ['playercommand', 'integrationapi', 'sessionmaintenance']) {
    const service = await api('https://run.googleapis.com', 'get', '/v2/projects/' + project + '/locations/us-central1/services/' + name);
    if ((service.invokerIamDisabled === true) !== (name === 'playercommand')) throw new Error('Unexpected invocation policy for ' + name);
  }
  console.log('Player endpoint enabled with Auth + App Check; integration API and maintenance remain private.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
