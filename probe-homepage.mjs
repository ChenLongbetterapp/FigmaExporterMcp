#!/usr/bin/env node
/**
 * probe-homepage.mjs — 详细探针：列出 "Todolize website" 页全部节点
 * 按 DOM 位置找到每个 section 实际用了什么图标/切图
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs/promises';

const SERVER_PATH = new URL('./dist/server.js', import.meta.url).pathname.replace(/^\//, '');
const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_PATH],
  env: { ...process.env, FIGMA_EXPORTER_RELAY_PORT: '3066' },
});
const client = new Client({ name: 'probe-home', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('Waiting 10s...');
await new Promise((r) => setTimeout(r, 10000));

// 等 plugin 连上
async function waitFigma() {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await client.callTool({ name: 'get_document_info', arguments: {} });
      const t = r.content.find((c) => c.type === 'text')?.text ?? '';
      if (t.startsWith('{') && t.includes('children')) return JSON.parse(t);
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('not connected');
}
const doc = await waitFigma();

// 找 "Todolize website" 页 ID
const homePage = (doc.children ?? []).find((p) => p.name === 'Todolize website');
if (!homePage) {
  console.log('Todolize website page not found');
  process.exit(1);
}
console.log(`Home page: ${homePage.name} (${homePage.id})`);

// 取页面树
const ni = JSON.parse(
  (await client.callTool({ name: 'get_node_info', arguments: { nodeId: homePage.id } }))
    .content.find((c) => c.type === 'text')?.text ?? '{}'
);

// 打印完整树，每行带路径和 ID
function printTree(node, depth = 0, path = []) {
  const p = [...path, node.name || node.type];
  const indent = '  '.repeat(depth);
  const w = Math.round(node.absoluteBoundingBox?.width ?? node.width ?? 0);
  const h = Math.round(node.absoluteBoundingBox?.height ?? node.height ?? 0);
  const imgFill = node.hasImageFill ? ' [IMG]' : '';
  console.log(`${indent}${node.type} "${node.name}" ${w}x${h} [${node.id}]${imgFill}`);
  for (const c of node.children ?? []) {
    printTree(c, depth + 1, p);
  }
}

// 只显示前 3 层 + 叶子的图标（深度 > 3 只显示类型/icon）
function printTreeCompact(node, depth = 0, path = []) {
  const p = [...path, node.name || node.type];
  const indent = '  '.repeat(depth);
  const w = Math.round(node.absoluteBoundingBox?.width ?? node.width ?? 0);
  const h = Math.round(node.absoluteBoundingBox?.height ?? node.height ?? 0);
  const imgFill = node.hasImageFill ? ' [IMG]' : '';
  const showSize = depth <= 2 ? ` ${w}x${h}` : '';
  console.log(`${indent}${node.type} "${node.name}"${showSize} [${node.id}]${imgFill}`);
  for (const c of node.children ?? []) {
    printTreeCompact(c, depth + 1, p);
  }
}

console.log('\n=== Full tree (all depths) ===\n');
printTree(ni);

// 也 dump 原始 JSON 供后续分析
await fs.mkdir('D:/LongWorkspace/Project_ToDoList_Android/1_Web/site/copilot_temp', { recursive: true });
await fs.writeFile(
  'D:/LongWorkspace/Project_ToDoList_Android/1_Web/site/copilot_temp/home-tree.json',
  JSON.stringify(ni, null, 2)
);
console.log('\nFull tree JSON: D:/.../copilot_temp/home-tree.json');

await client.close();
process.exit(0);