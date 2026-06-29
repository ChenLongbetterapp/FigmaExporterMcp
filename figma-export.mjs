#!/usr/bin/env node
/**
 * figma-export.mjs — 验证插件新代码 + 切图导出
 *
 * 步骤：
 * 1. 连接 MCP server
 * 2. 探针：查 3317:4512 (插画组)，确认插件返回的 children 里有 VECTOR
 *    - 如果 0 个 VECTOR → 提示用户 reload 插件
 * 3. 全文件扫描：找所有可能的切图
 *    - VECTOR + 尺寸适中
 *    - 有 image fill (hasImageFill)
 *    - 有 exportSettings
 *    - 名字含插画/icon/mockup/card/avatar/logo/star/bell 等
 *    - 尺寸小的形状节点
 * 4. 批量 export
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs/promises';
import path from 'path';

const SERVER_PATH = new URL('./dist/server.js', import.meta.url).pathname.replace(/^\//, '');
const EXPORT_DIR = 'D:/LongWorkspace/Project_ToDoList_Android/1_Web/site/public/figma';
await fs.mkdir(EXPORT_DIR, { recursive: true });

const ASSET_KEYWORDS = [
  '插画', 'illustration', 'icon', '图标', 'mockup', '样机', 'phone',
  'card', '卡片', 'notification', '通知', 'avatar', '头像',
  'logo', 'badge', 'star', 'trophy', 'medal', 'symbol', 'mark',
  'image', 'picture', 'pic', 'asset', 'bell', 'check', 'streak',
  'completed', 'reminder', 'people', 'user',
];

const DESIGN_READ_OPTIONS = {
  includeChildren: true,
  includeVectors: true,
  includeText: false,
  includeInvisible: false,
  includeFills: true,
  includeEffects: false,
  maxDepth: 20,
};

const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_PATH],
  env: { ...process.env, FIGMA_EXPORTER_RELAY_PORT: '3066', FIGMA_EXPORTER_EXPORT_DIR: EXPORT_DIR },
});

const client = new Client({ name: 'figma-export', version: '1.0.0' }, { capabilities: {} });
console.log('[1/6] Connecting to MCP server...');
await client.connect(transport);
console.log('[2/6] Waiting 10s for plugin reconnect + join registration...');
await new Promise((r) => setTimeout(r, 10000));

// 等 plugin 连上
async function waitForFigma(maxTries = 10) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const r = await client.callTool({ name: 'get_document_info', arguments: {} });
      const t = r.content.find((c) => c.type === 'text')?.text ?? '';
      if (t.startsWith('{') && t.includes('children')) return JSON.parse(t);
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Figma plugin never connected');
}
const doc = await waitForFigma();

// [3/6] 探针：递归扫描 3317:4512 全树，统计各类型数量
console.log('\n[3/6] Probing 3317:4512 recursively for node types...');
const probe = JSON.parse(
  (await client.callTool({ name: 'get_node_info', arguments: { nodeId: '3317:4512', options: DESIGN_READ_OPTIONS } }))
    .content.find((c) => c.type === 'text')?.text ?? '{}'
);

function countTypes(node, counts = {}) {
  counts[node.type] = (counts[node.type] ?? 0) + 1;
  for (const c of node.children ?? []) countTypes(c, counts);
  return counts;
}
const typeCounts = countTypes(probe);
console.log('     Node type counts (recursive):');
Object.entries(typeCounts).forEach(([t, n]) => console.log(`       ${t}: ${n}`));

if ((typeCounts.VECTOR ?? 0) > 0) {
  console.log('     ✓ VECTOR nodes present — new plugin code is loaded');
} else {
  console.log('     ⚠️  No VECTOR nodes found even recursively. Plugin may not have reloaded, OR this design has no vector nodes.');
}

// [4/6] 全文件扫描
console.log('\n[4/6] Scanning all pages for asset candidates...');
const pageIds = (doc.children ?? []).map((p) => ({ name: p.name, id: p.id }));
console.log(`     ${pageIds.length} pages`);

function isAssetCandidate(node) {
  if (!node || !node.type) return false;
  if (node.type === 'TEXT') return false;

  const w = node.absoluteBoundingBox?.width ?? node.width ?? 0;
  const h = node.absoluteBoundingBox?.height ?? node.height ?? 0;
  if (w < 4 || h < 4) return false;
  if (w > 1500 || h > 3000) return false;
  if (node.visible === false) return false;

  // 0. SLICE 节点 — Figma 传统的"切图"标记类型，必是切图
  if (node.type === 'SLICE') return w >= 8 && h >= 8;

  // 1. exportSettings 标记
  if (Array.isArray(node.exportSettings) && node.exportSettings.length > 0) return true;
  // 2. 有 image fill（外链/嵌入图）
  if (node.hasImageFill) return true;
  // 3. VECTOR（图标/插画）
  if (node.type === 'VECTOR' && w >= 8 && h >= 8 && w < 1000 && h < 1000) return true;
  // 5. auto-layout FRAME 跳过（容器）
  if (node.layoutMode && node.layoutMode !== 'NONE') return false;
  // 6. 名字匹配 + 尺寸合理
  const name = (node.name || '').toLowerCase();
  if (ASSET_KEYWORDS.some((kw) => name.includes(kw.toLowerCase())) && w < 1000 && h < 1000) return true;
  // 7. 形状节点只有命名像资产时才导出，避免 1x1 透明 box/mask 噪声。
  if (['RECTANGLE', 'ELLIPSE', 'STAR', 'POLYGON', 'REGULAR_POLYGON'].includes(node.type) && w < 500 && h < 500) {
    return /icon|logo|badge|avatar|widget|theme|image|photo|reminder|streak|completed|star|medal|trophy/.test(name);
  }

  return false;
}

function findAssets(nodes, page, path = [], out = []) {
  for (const node of nodes ?? []) {
    const p = [...path, node.name || node.type];
    if (isAssetCandidate(node)) {
      out.push({
        page, path: p, id: node.id, name: node.name, type: node.type,
        w: node.absoluteBoundingBox?.width ?? node.width ?? 0,
        h: node.absoluteBoundingBox?.height ?? node.height ?? 0,
        hasExport: Array.isArray(node.exportSettings) && node.exportSettings.length > 0,
        hasImage: !!node.hasImageFill,
      });
    }
    if (node.children) findAssets(node.children, page, p, out);
  }
  return out;
}

const assets = [];
for (const p of pageIds) {
  try {
    const ni = JSON.parse(
      (await client.callTool({ name: 'get_node_info', arguments: { nodeId: p.id, options: DESIGN_READ_OPTIONS } }))
        .content.find((c) => c.type === 'text')?.text ?? '{}'
    );
    findAssets(ni.children ?? [], p.name, [p.name], assets);
  } catch (err) {
    console.warn(`     ! ${p.name}: ${err.message}`);
  }
}

const uniqueById = new Map();
assets.forEach((a) => { if (!uniqueById.has(a.id)) uniqueById.set(a.id, a); });
const deduped = [...uniqueById.values()];
console.log(`     ${assets.length} candidates → ${deduped.length} unique`);

const byType = {};
deduped.forEach((a) => { (byType[a.type] ??= []).push(a); });
console.log('\n     By type:');
Object.entries(byType).forEach(([t, list]) => console.log(`       ${t}: ${list.length}`));
console.log(`     With image fill: ${deduped.filter((a) => a.hasImage).length}`);
console.log(`     With exportSettings: ${deduped.filter((a) => a.hasExport).length}`);

// [5/6] 批量导出
console.log('\n[5/6] Exporting...');
let exported = 0;
let skipped = 0;
const failed = [];
for (const a of deduped) {
  try {
    const res = await client.callTool({
      name: 'export_node_as_image',
      arguments: { nodeId: a.id, format: 'PNG', scale: 2 },
    });
    const img = res.content.find((c) => c.type === 'image');
    if (!img?.data) {
      skipped++;
      failed.push({ id: a.id, name: a.name, type: a.type, reason: 'no image data' });
      continue;
    }
    // 用 node ID 命名（解决 Figma 自动 group 名字重复导致文件覆盖问题）
    const fileName = `n${a.id.replace(/[:.]/g, '-')}.png`;
    const outPath = path.join(EXPORT_DIR, fileName);
    await fs.writeFile(outPath, Buffer.from(img.data, 'base64'));
    exported++;
    if (exported % 20 === 0) console.log(`     [${exported}/${deduped.length}]`);
  } catch (err) {
    skipped++;
    failed.push({ id: a.id, name: a.name, type: a.type, reason: err.message ?? err });
  }
}

// [6/6] 报告
console.log(`\n[6/6] ✓ Exported ${exported} / ${deduped.length} (${skipped} skipped)`);
if (failed.length > 0) {
  console.log('\nSkipped (first 15):');
  failed.slice(0, 15).forEach((f) => console.log(`  - ${f.type} "${f.name}" [${f.id}]: ${f.reason}`));
}

await client.close();
process.exit(0);
