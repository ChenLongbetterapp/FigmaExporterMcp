import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceHash, artifactHash } from './build-info.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = spawnSync(process.execPath, [path.join(root,'node_modules/typescript/bin/tsc'),'--noEmit'], { cwd: root, stdio: 'inherit' });
if (types.status !== 0) process.exit(types.status || 1);
await fs.rm(path.join(root,'dist'), { recursive: true, force: true });
await build({ absWorkingDir: root, entryPoints: ['src/server.ts','src/exports.ts'], outdir: 'dist', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', sourcemap: true });
await fs.writeFile(path.join(root,'dist/build.json'), JSON.stringify({
  sourceHash: sourceHash(root), artifactHash: artifactHash(path.join(root,'dist')),
}, null, 2) + '\n');
