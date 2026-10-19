import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const env = { ...process.env,
  XDG_CONFIG_HOME: path.join(cwd, '.firebase-config'),
  FIREBASE_EMULATORS_PATH: path.join(cwd, '.emulator-cache'),
  NODE_USE_SYSTEM_CA: '1',
};
const androidJava = 'C:/Program Files/Android/Android Studio/jbr/bin';
if (process.platform === 'win32' && existsSync(path.join(androidJava, 'java.exe'))) env.PATH = `${androidJava};${env.PATH}`;
const args = ['emulators:start', '--project', 'demo-rpg-games', '--only', 'auth,firestore,functions', '--export-on-exit', '.emulator-state'];
if (existsSync('.emulator-state/firebase-export-metadata.json')) args.push('--import', '.emulator-state');
const child = spawn(process.execPath, [path.join(cwd, 'node_modules/firebase-tools/lib/bin/firebase.js'), ...args], { stdio: 'inherit', env });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 0));
