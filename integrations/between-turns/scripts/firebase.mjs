import { spawn } from 'node:child_process';
import path from 'node:path';
const child = spawn(process.execPath, [path.resolve('node_modules/firebase-tools/lib/bin/firebase.js'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, XDG_CONFIG_HOME: path.resolve('.firebase-config'), NODE_USE_SYSTEM_CA: '1' },
});
child.on('exit', code => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill('SIGINT'));
