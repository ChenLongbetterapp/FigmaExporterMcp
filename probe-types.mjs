#!/usr/bin/env node
// 一次性探针：只查 3317:4512 全树类型统计，不导出
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = new URL('./dist/server.js', import.meta.url).pathname.replace(/^\//, '');
const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_PATH],
  env: { ...process.env, FIGMA_EXPORTER_RELAY_PORT: '3066' },
});
const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
await new Promise((r) => setTimeout(r, 10000));

async function waitFigma() {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await client.callTool({ name: 'get_document_info', arguments: {} });
      const t = r.content.find((c) => c.type === 'text')?.text ?? '';
      if (t.startsWith('{') && t.includes('children')) return JSON.parse(t);
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('not connected');
}
await waitFigma();

console.log('Probing 3317:4512 recursive...');
const r = await client.callTool({ name: 'get_node_info', arguments: { nodeId: '3317:4512' } });
const t = r.content.find((c) => c.type === 'text')?.text ?? '{}';
const n = JSON.parse(t);

const counts = {};
function walk(node) {
  counts[node.type] = (counts[node.type] ?? 0) + 1;
  if (Array.isArray(node.children)) node.children.forEach(walk);
}
walk(n);

console.log('Type counts:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

console.log('\nDirect children of 3317:4512:');
for (const c of (n.children ?? []).slice(0, 12)) {
  console.log(`  ${c.type} "${c.name}" ${JSON.stringify(c.absoluteBoundingBox || {}).slice(0, 60)}`);
}

await client.close();
process.exit(0);