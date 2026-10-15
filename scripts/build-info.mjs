import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function hashFiles(root, files) {
  const hash = createHash('sha256');
  for (const name of files.sort()) {
    const data = fs.readFileSync(path.join(root, name));
    hash.update(`${name.length}:${name}:${data.length}:`);hash.update(data);
  }
  return hash.digest('hex');
}
function tree(root, folder) {
  return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const name = path.join(folder, entry.name);
    return entry.isDirectory() ? tree(root, name) : entry.isFile() ? [name] : [];
  });
}
export function sourceHash(root) {
  return hashFiles(root, ['package.json','package-lock.json','tsconfig.json',
    ...tree(root,'src'),...tree(root,'figma-plugin'),...tree(root,'scripts')]);
}
export function artifactHash(dist) {
  return hashFiles(dist, tree(dist, '.').filter(name => name !== 'build.json'));
}
