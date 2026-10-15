import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePngExportScale, exportFileSegment } from '../dist/exports.js';
test('export scale preserves icon density and caps large web canvases', () => {
  for (const [size, expected] of [[24,4],[500,3],[1000,2],[2560,1.5]]) assert.equal(choosePngExportScale({width:size,height:100},'web'),expected);
  assert.equal(choosePngExportScale({width:24,height:24},'android'),4);
  assert.equal(choosePngExportScale({width:2400,height:1080},'android'),4);
  for (const [width,height] of [[1440,10000],[10000,10000],[500000,100]]) {
    const scale=choosePngExportScale({width,height},'web');
    assert.ok(scale>0 && Math.max(width,height)*scale<=4096);
    assert.ok(width*height*scale*scale<=16_000_000);
  }
  assert.equal(choosePngExportScale({},'web'),2);
});
test('same-name Figma files have separate export directories',()=>{
  assert.notEqual(exportFileSegment({fileName:'同名稿',channel:'a'}),exportFileSegment({fileName:'同名稿',channel:'b'}));
  assert.equal(exportFileSegment({fileName:'A',fileKey:'key',channel:'old'}),exportFileSegment({fileName:'A',fileKey:'key',channel:'new'}));
  assert.throws(()=>exportFileSegment({fileName:'unknown'}),/identified/);
});
