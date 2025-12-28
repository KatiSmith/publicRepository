import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = new URL('../node_modules/web-ifc/web-ifc.wasm', import.meta.url);
const dest = new URL('../public/web-ifc.wasm', import.meta.url);

const destPath = fileURLToPath(dest);
await mkdir(dirname(destPath), { recursive: true });
await copyFile(src, destPath);

console.log('[postinstall] Copied web-ifc.wasm to public/');

