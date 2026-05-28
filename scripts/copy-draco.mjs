import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco');
const target = path.join(root, 'public', 'draco');

if (!fs.existsSync(source)) {
  console.warn('Draco source folder not found. Run npm install again after three is installed.');
  process.exit(0);
}

fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log('Copied Three.js Draco decoder files to public/draco');
