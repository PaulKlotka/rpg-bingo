// Explicitly targets the new hub project; no existing game project is mutated.
const { api, operation } = require('./cloud-admin.cjs');
const fs = require('node:fs');
const project = process.argv[2]; const billing = process.argv[3];
if (project !== 'between-turns-paul' || !/^billingAccounts\/[A-Z0-9-]+$/.test(billing || '')) throw new Error('Usage: node scripts/provision.cjs between-turns-paul billingAccounts/ACCOUNT_ID');
const root = `projects/${project}`;
const save = (name, value) => fs.writeFileSync(`.firebase-config/${name}.json`, JSON.stringify(value, null, 2));
async function exists(origin, resource) {
  try { return await api(origin, 'get', resource); } catch (error) { if (error.status === 404 || error.context?.response?.statusCode === 404 || /404|not found|NOT_FOUND/i.test(error.message)) return null; throw error; }
}
async function main() {
  const p = await api('https://cloudresourcemanager.googleapis.com', 'get', `/v1/${root}`);
  const number = p.projectNumber;
  console.log('Linking billing for the new Between Turns project.');
  await api('https://cloudbilling.googleapis.com', 'put', `/v1/${root}/billingInfo`, { billingAccountName: billing });
  console.log('Enabling Firebase runtime services.');
  const serviceOrigin = 'https://serviceusage.googleapis.com';
  const requiredServices = ["firestore.googleapis.com","identitytoolkit.googleapis.com","firebaserules.googleapis.com","cloudfunctions.googleapis.com","run.googleapis.com","cloudbuild.googleapis.com","artifactregistry.googleapis.com","cloudscheduler.googleapis.com","pubsub.googleapis.com","recaptchaenterprise.googleapis.com","firebaseappcheck.googleapis.com","firebasehosting.googleapis.com","iam.googleapis.com"];
  const enabledServices = await api(serviceOrigin, 'get', `/v1/projects/${number}/services?filter=state:ENABLED&pageSize=200`);
  const enabledNames = new Set((enabledServices.services || []).map(service => service.config.name));
  const missingServices = requiredServices.filter(service => !enabledNames.has(service));
  if (missingServices.length) await operation(serviceOrigin, await api(serviceOrigin, 'post', `/v1/projects/${number}/services:batchEnable`, { serviceIds: missingServices }));
  console.log('Creating the regional Firestore database.');
  const firestore = 'https://firestore.googleapis.com';
  if (!await exists(firestore, `/v1/${root}/databases/(default)`)) await operation(firestore, await api(firestore, 'post', `/v1/${root}/databases?databaseId=(default)`, { locationId: 'us-central1', type: 'FIRESTORE_NATIVE', deleteProtectionState: 'DELETE_PROTECTION_ENABLED' }));
  console.log('Configuring guest authentication.');
  const domains = [`${project}.web.app`, `${project}.firebaseapp.com`];
  const identity = 'https://identitytoolkit.googleapis.com';
  const authBody = { signIn: { anonymous: { enabled: true } }, authorizedDomains: ['localhost', ...domains] };
  try { await api(identity, 'patch', `/admin/v2/${root}/config?updateMask=signIn.anonymous.enabled,authorizedDomains`, authBody); }
  catch (error) {
    if (!/CONFIGURATION_NOT_FOUND|configuration.*not.*found/i.test(error.message)) throw error;
    await api(identity, 'post', `/v2/${root}/identityPlatform:initializeAuth`, {});
    await api(identity, 'patch', `/admin/v2/${root}/config?updateMask=signIn.anonymous.enabled,authorizedDomains`, authBody);
  }
  console.log('Registering the web application and App Check.');
  const firebase = 'https://firebase.googleapis.com';
  let apps = await api(firebase, 'get', `/v1beta1/${root}/webApps`);
  let app = (apps.apps || []).find(a => a.displayName === 'Between Turns');
  if (!app) {
    await operation(firebase, await api(firebase, 'post', `/v1beta1/${root}/webApps`, { displayName: 'Between Turns' }), 'v1beta1');
    apps = await api(firebase, 'get', `/v1beta1/${root}/webApps`); app = apps.apps.find(a => a.displayName === 'Between Turns');
  }
  const web = await api(firebase, 'get', `/v1beta1/${root}/webApps/${app.appId}/config`); save('web-config', web);
  const recaptcha = 'https://recaptchaenterprise.googleapis.com';
  const keys = await api(recaptcha, 'get', `/v1/${root}/keys`);
  let key = (keys.keys || []).find(k => k.displayName === 'Between Turns App Check');
  if (!key) key = await api(recaptcha, 'post', `/v1/${root}/keys`, { displayName: 'Between Turns App Check', webSettings: { allowedDomains: domains, allowAllDomains: false, integrationType: 'SCORE' } });
  save('appcheck-key', key);
  const siteKey = key.name.split('/').pop();
  await api('https://firebaseappcheck.googleapis.com', 'patch', `/v1/projects/${number}/apps/${app.appId}/recaptchaEnterpriseConfig?updateMask=siteKey,tokenTtl`, { name: `projects/${number}/apps/${app.appId}/recaptchaEnterpriseConfig`, siteKey, tokenTtl: '3600s' });
  console.log('Creating a dedicated runtime identity with Firestore access.');
  const iam = 'https://iam.googleapis.com'; const email = `between-turns-runtime@${project}.iam.gserviceaccount.com`;
  if (!await exists(iam, `/v1/${root}/serviceAccounts/${email}`)) await api(iam, 'post', `/v1/${root}/serviceAccounts`, { accountId: 'between-turns-runtime', serviceAccount: { displayName: 'Between Turns runtime' } });
  const crm = 'https://cloudresourcemanager.googleapis.com';
  const policy = await api(crm, 'post', `/v1/${root}:getIamPolicy`, {});
  const grant = (role, member) => { let binding = policy.bindings.find(b => b.role === role && !b.condition); if (!binding) policy.bindings.push(binding = { role, members: [] }); if (!binding.members.includes(member)) binding.members.push(member); };
  grant('roles/datastore.user', `serviceAccount:${email}`);
  grant('roles/firebaseappcheck.tokenVerifier', `serviceAccount:${email}`);
  grant('roles/cloudbuild.builds.builder', `serviceAccount:${number}-compute@developer.gserviceaccount.com`);
  await api(crm, 'post', `/v1/${root}:setIamPolicy`, { policy });
  fs.writeFileSync('.env.production.local', `VITE_USE_FIREBASE_EMULATORS=false\nVITE_FIREBASE_PROJECT_ID=${project}\nVITE_FIREBASE_API_KEY=${web.apiKey}\nVITE_FIREBASE_AUTH_DOMAIN=${web.authDomain}\nVITE_FIREBASE_APP_ID=${web.appId}\nVITE_APPCHECK_SITE_KEY=${siteKey}\n`);
  fs.writeFileSync(`functions/.env.${project}`, `APPS_JSON=[]\nGAMES_JSON=[]\nGAME_API_AUDIENCE=https://us-central1-${project}.cloudfunctions.net/integrationApi\nHUB_RUNTIME_SERVICE_ACCOUNT=${email}\n`);
  save('provisioned', { project, number, appId: web.appId, runtime: email, hosting: `https://${project}.web.app`, completedAt: new Date().toISOString() });
  console.log(`Between Turns infrastructure configured: ${project}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
