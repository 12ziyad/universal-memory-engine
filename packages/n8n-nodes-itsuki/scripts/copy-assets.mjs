// Copy node icons into dist so the packaged nodes can reference them.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = [
	['nodes/Itsuki/itsuki.svg', 'dist/nodes/Itsuki/itsuki.svg'],
	['nodes/Itsuki/itsuki.dark.svg', 'dist/nodes/Itsuki/itsuki.dark.svg'],
];
for (const [from, to] of assets) {
	mkdirSync(dirname(join(root, to)), { recursive: true });
	copyFileSync(join(root, from), join(root, to));
}
console.log(`copied ${assets.length} assets`);
