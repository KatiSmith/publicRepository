import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const src = new URL('../node_modules/web-ifc/web-ifc.wasm', import.meta.url);
const dest = new URL('../public/web-ifc.wasm', import.meta.url);

await mkdir(dirname(dest.pathname), { recursive: true });
await copyFile(src, dest);

console.log('[postinstall] Copied web-ifc.wasm to public/');

