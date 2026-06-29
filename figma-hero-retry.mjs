#!/usr/bin/env node
/**
 * 重试拉 HeroSection（之前 scale=2 栈溢出）
 * 用 scale=1，单独导出
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs/promises';
import path from 'path';

const SERVER_PATH = new URL('./dist/server.js', import.meta.url).pathname.replace(/^\//, '');
const EXPORT_DIR = 'D:/LongWorkspace/Project_ToDoList_Android/1_Web/site/src/assets/images/figma';
await fs.mkdir(EXPORT_DIR, { recursive: true });

const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_PATH],
  env: { ...process.env, FIGMA_EXPORTER_RELAY_PORT: '3066', FIGMA_EXPORTER_EXPORT_DIR: EXPORT_DIR },
});

const client = new Client({ name: 'figma-hero', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('Waiting 5s...');
await new Promise((r) => setTimeout(r, 5000));

// HeroSection 在 "头部大banner" 页，node ID 已知是 3311:1074
console.log('Exporting HeroSection at scale=1...');
try {
  const res = await client.callTool({
    name: 'export_node_as_image',
    arguments: { nodeId: '3311:1074', format: 'PNG', scale: 1 },
  });
  const img = res.content.find((c) => c.type === 'image');
  if (img?.data) {
    const outPath = path.join(EXPORT_DIR, 'HeroSection.png');
    await fs.writeFile(outPath, Buffer.from(img.data, 'base64'));
    console.log(`✓ HeroSection.png saved (${Math.round(img.data.length * 0.75 / 1024)}KB)`);
  } else {
    console.log('✗ No image data');
  }
} catch (err) {
  console.log(`✗ Error: ${err.message ?? err}`);
}

// 也试一下"Todolize website > Body"完整首页（之前 SKIP 了因为 8342 高）
// 用 scale=1 重试，文件会小很多
console.log('\nExporting full Body at scale=1...');
try {
  const res = await client.callTool({
    name: 'export_node_as_image',
    arguments: { nodeId: '3311:1036', format: 'PNG', scale: 1 },
  });
  const img = res.content.find((c) => c.type === 'image');
  if (img?.data) {
    const outPath = path.join(EXPORT_DIR, 'FullHomepage.png');
    await fs.writeFile(outPath, Buffer.from(img.data, 'base64'));
    console.log(`✓ FullHomepage.png saved (${Math.round(img.data.length * 0.75 / 1024)}KB)`);
  }
} catch (err) {
  console.log(`✗ Body error: ${err.message ?? err}`);
}

await client.close();
process.exit(0);