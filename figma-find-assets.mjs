#!/usr/bin/env node
/**
 * figma-find-assets.mjs — 探索指定节点，找出里面的图标/插画/手机模型等切图
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = new URL('./dist/server.js', import.meta.url).pathname.replace(/^\//, '');
const START_NODE = '3317:4512'; // 用户给的示例节点

const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_PATH],
  env: { ...process.env, FIGMA_EXPORTER_RELAY_PORT: '3066' },
});

const client = new Client({ name: 'figma-find', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('Waiting 5s for plugin reconnect...');
await new Promise((r) => setTimeout(r, 5000));

// 1. 查起始节点
console.log(`\n=== get_node_info: ${START_NODE} ===`);
const ni = JSON.parse(
  (await client.callTool({ name: 'get_node_info', arguments: { nodeId: START_NODE } }))
    .content.find((c) => c.type === 'text')?.text ?? '{}'
);
console.log(`name: ${ni.name}, type: ${ni.type}`);
console.log(`size: ${Math.round(ni.absoluteBoundingBox?.width ?? 0)}x${Math.round(ni.absoluteBoundingBox?.height ?? 0)}`);
if (ni.children?.length) {
  console.log(`children: ${ni.children.length}`);
  console.log('top-level children:');
  ni.children.slice(0, 30).forEach((c) => {
    const w = Math.round(c.absoluteBoundingBox?.width ?? 0);
    const h = Math.round(c.absoluteBoundingBox?.height ?? 0);
    console.log(`  - ${c.type}: "${c.name}" (${w}x${h}) [${c.id}]`);
  });
}

// 2. 在文档里找所有有 exportSettings 的节点（真正的切图都会标导出）
console.log('\n=== Searching all pages for nodes with exportSettings ===');
const doc = JSON.parse(
  (await client.callTool({ name: 'get_document_info', arguments: {} }))
    .content.find((c) => c.type === 'text')?.text ?? '{}'
);

function findExported(nodes, page, path = [], out = []) {
  for (const node of nodes ?? []) {
    const p = [...path, node.name || node.type];
    if (Array.isArray(node.exportSettings) && node.exportSettings.length > 0) {
      out.push({ page, path: p, id: node.id, name: node.name, type: node.type, settings: node.exportSettings });
    }
    if (node.children) findExported(node.children, page, p, out);
  }
  return out;
}

const exported = [];
for (const page of doc.children ?? []) {
  findExported(page.children ?? [], page.name, [page.name], exported);
}
console.log(`Found ${exported.length} nodes with exportSettings:\n`);
exported.forEach((e) => {
  const fmt = e.settings[0]?.format ?? '?';
  const sc = e.settings[0]?.constraint?.value ?? '?';
  console.log(`  [${e.page}] ${e.path.join(' / ')} [${e.id}] ${e.type} ${fmt}@${sc}x`);
});

// 3. 也扫一下 INSTANCE（被引用的资产）
console.log('\n=== Searching all pages for INSTANCE nodes (referenced assets) ===');
function findInstances(nodes, page, path = [], out = []) {
  for (const node of nodes ?? []) {
    const p = [...path, node.name || node.type];
    if (node.type === 'INSTANCE' || node.type === 'COMPONENT') {
      out.push({ page, path: p, id: node.id, name: node.name, type: node.type });
    }
    if (node.children) findInstances(node.children, page, p, out);
  }
  return out;
}
const instances = [];
for (const page of doc.children ?? []) {
  findInstances(page.children ?? [], page.name, [page.name], instances);
}
console.log(`Found ${instances.length} INSTANCE/COMPONENT nodes (showing first 20):`);
instances.slice(0, 20).forEach((i) => {
  console.log(`  [${i.page}] ${i.path.join(' / ')} [${i.id}] ${i.type}`);
});

await client.close();
process.exit(0);