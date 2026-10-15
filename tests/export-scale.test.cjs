const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.ts"), "utf8");
const start = source.indexOf("function choosePngExportScale");
const marker = "\n}\n\n// Export Node as Image Tool";
const end = source.indexOf(marker, start);
assert.ok(start >= 0 && end > start, "choosePngExportScale source not found");

const functionSource = source.slice(start, end + 2);
const transpiled = ts.transpileModule(
  `${functionSource}\nmodule.exports = { choosePngExportScale };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;
const moduleContext = vm.createContext({ module: { exports: {} }, exports: {} });
vm.runInContext(transpiled, moduleContext);
const { choosePngExportScale } = moduleContext.module.exports;

assert.equal(choosePngExportScale({ width: 24, height: 24 }, "android"), 4);
assert.equal(choosePngExportScale({ width: 2400, height: 1080 }, "android"), 4);
assert.equal(choosePngExportScale({ width: 24, height: 24 }, "web"), 4);
assert.equal(choosePngExportScale({ width: 500, height: 300 }, "web"), 3);
assert.equal(choosePngExportScale({ width: 1000, height: 600 }, "web"), 2);
assert.equal(choosePngExportScale({ width: 2560, height: 1440 }, "web"), 1.5);
assert.equal(choosePngExportScale({ width: 1440, height: 10000 }, "web"), 1);
assert.equal(choosePngExportScale({}, "web"), 2);

console.log("export-scale.test.cjs: all assertions passed");
