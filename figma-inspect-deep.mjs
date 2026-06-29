#!/usr/bin/env node
/**
 * figma-inspect-deep.mjs — 深度探索单个节点及其周边
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = new URL('./dist/server.js', import.meta.url).pathname.replace(/^\//, '');
const TARGET = '3317:4488';

const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_PATH],
  env: { ...process.env, FIGMA_EXPORTER_RELAY_PORT: '3066' },
});

const client = new Client({ name: 'figma-inspect', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('Waiting 5s...');
await new Promise((r) => setTimeout(r, 5000));

// 1. 直接看目标节点
console.log(`\n=== Target node: ${TARGET} ===`);
const ni = JSON.parse(
  (await client.callTool({ name: 'get_node_info', arguments: { nodeId: TARGET } }))
    .content.find((c) => c.type === 'text')?.text ?? '{}'
);
console.log(`name: "${ni.name}"`);
console.log(`type: ${ni.type}`);
console.log(`size: ${Math.round(ni.absoluteBoundingBox?.width ?? 0)}x${Math.round(ni.absoluteBoundingBox?.height ?? 0)}`);
if (ni.children?.length) {
  console.log(`children: ${ni.children.length}`);
  ni.children.forEach((c) => {
    const w = Math.round(c.absoluteBoundingBox?.width ?? 0);
    const h = Math.round(c.absoluteBoundingBox?.height ?? 0);
    console.log(`  - ${c.type}: "${c.name}" (${w}x${h}) [${c.id}]`);
  });
}

// 2. 看 3317:4488 的父节点（找兄弟节点）
console.log('\n=== Parent of target ===');
const parentId = '3317:8'; // 试试 common ancestor
try {
  const parent = JSON.parse(
    (await client.callTool({ name: 'get_nodes_info', arguments: { nodeIds: ['3317:4487', '3317:4488', '3317:4489', '3317:4490', '3317:4491', '3317:4492', '3317:4493', '3317:4494', '3317:4495', '3317:4496'] } }))
      .content.find((c) => c.type === 'text')?.text ?? '[]'
  );
  console.log(JSON.stringify(parent, null, 2).slice(0, 3000));
} catch (err) {
  console.log('error:', err.message);
}

// 3. 用 get_nodes_info 批量查 3317:4488 周围的节点 ID（3317:4488 ± 20）
console.log('\n=== Surrounding nodes (3317:4470 ~ 3317:4520) ===');
const ids = [];
for (let i = 4470; i <= 4520; i++) ids.push(`3317:${i}`);
try {
  const result = JSON.parse(
    (await client.callTool({ name: 'get_nodes_info', arguments: { nodeIds: ids } }))
      .content.find((c) => c.type === 'text')?.text ?? '[]'
  );
  const nodes = JSON.parse(result);
  nodes.forEach((n) => {
    if (!n.id) return;
    const w = Math.round(n.absoluteBoundingBox?.width ?? 0);
    const h = Math.round(n.absoluteBoundingBox?.height ?? 0);
    console.log(`  ${n.id}  ${n.type}  "${n.name}"  ${w}x${h}`);
  });
} catch (err) {
  console.log('error:', err.message);
}

await client.close();
process.exit(0);