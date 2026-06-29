#!/usr/bin/env node
/**
 * figma-inspect.mjs — 看 Figma 真实情况：选中 + 各页 root 节点
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = new URL('./dist/server.js', import.meta.url).pathname.replace(/^\//, '');

const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_PATH],
  env: { ...process.env, FIGMA_EXPORTER_RELAY_PORT: '3066' },
});

const client = new Client({ name: 'figma-inspect', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('Waiting for plugin...');
await new Promise((r) => setTimeout(r, 5000));

// 1. 看当前选中
console.log('=== Current selection ===');
const sel = await client.callTool({ name: 'get_selection', arguments: {} });
const selText = sel.content.find((c) => c.type === 'text')?.text ?? '(empty)';
let selData;
try { selData = JSON.parse(selText); } catch { selData = selText; }
console.log(JSON.stringify(selData, null, 2).slice(0, 2000));

// 2. 拿每个页面的 root 节点详情（用 get_node_info）
console.log('\n=== Page roots (via get_node_info) ===');
const docResult = await client.callTool({ name: 'get_document_info', arguments: {} });
const doc = JSON.parse(docResult.content.find((c) => c.type === 'text')?.text ?? '{}');

for (const page of doc.children ?? []) {
  try {
    const nodeInfo = await client.callTool({ name: 'get_node_info', arguments: { nodeId: page.id } });
    const niText = nodeInfo.content.find((c) => c.type === 'text')?.text ?? '{}';
    const ni = JSON.parse(niText);
    const cnt = ni.children?.length ?? 0;
    console.log(`\n[${page.name}] id=${page.id} direct children: ${cnt}`);
    if (cnt > 0) {
      console.log('  top-level children:');
      ni.children.slice(0, 10).forEach((c) => {
        const w = c.absoluteBoundingBox?.width ?? c.width ?? 0;
        const h = c.absoluteBoundingBox?.height ?? c.height ?? 0;
        const exp = c.exportSettings ? `[EXPORT ${c.exportSettings[0]?.format ?? ''}@${c.exportSettings[0]?.constraint?.value ?? ''}x]` : '';
        console.log(`    - ${c.type}: "${c.name}" (${Math.round(w)}x${Math.round(h)}) ${exp}`);
      });
      if (ni.children.length > 10) console.log(`    ... and ${ni.children.length - 10} more`);
    }
  } catch (err) {
    console.log(`[${page.name}] error: ${err.message}`);
  }
}

await client.close();
process.exit(0);