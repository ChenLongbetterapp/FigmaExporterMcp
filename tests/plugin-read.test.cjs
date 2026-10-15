const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function attach(parent, children) {
  parent.children = children;
  for (const child of children) child.parent = parent;
  return parent;
}

function sceneNode(id, name, type, extra = {}) {
  return {
    id,
    name,
    type,
    visible: true,
    opacity: 1,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    exportAsync: async () => new Uint8Array([1, 2, 3]),
    ...extra,
  };
}

(async () => {
  const deepLeaf = sceneNode("deep-leaf", "Deep leaf", "RECTANGLE");
  let deepTree = deepLeaf;
  for (let depth = 0; depth < 25; depth += 1) {
    deepTree = attach(sceneNode(`deep-${depth}`, `Deep ${depth}`, "FRAME"), [deepTree]);
  }

  const hiddenChild = sceneNode("hidden-child", "Hidden child", "TEXT", { characters: "secret" });
  const hiddenParent = attach(sceneNode("hidden-parent", "Hidden parent", "FRAME", { visible: false }), [hiddenChild]);
  const vector = sceneNode("vector", "Logo mark", "VECTOR", { isAsset: true, width: 24, height: 24 });
  const image = sceneNode("image", "Hero image", "RECTANGLE", {
    fills: [{ type: "IMAGE", visible: true, opacity: 1, imageHash: "hash", scaleMode: "FILL" }],
  });
  const text = sceneNode("text", "Title", "TEXT", {
    characters: "Hello",
    fontName: { family: "Example Sans", style: "Bold" },
    fontSize: 32,
    fontWeight: 700,
    lineHeight: { unit: "PIXELS", value: 40 },
    letterSpacing: { unit: "PIXELS", value: 0 },
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    textAutoResize: "WIDTH_AND_HEIGHT",
    getStyledTextSegments: () => [{
      start: 0,
      end: 5,
      characters: "Hello",
      fontName: { family: "Example Sans", style: "Bold" },
      fontSize: 32,
      fontWeight: 700,
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, visible: true, opacity: 1 }],
    }],
  });
  const screen = attach(sceneNode("screen", "Home", "FRAME", { width: 390, height: 844 }), [vector, image, text, hiddenParent, deepTree]);
  const pageOne = attach({ id: "page-1", name: "Screens", type: "PAGE", loadAsync: async () => {} }, [screen]);
  const pageTwo = attach({ id: "page-2", name: "Components", type: "PAGE", loadAsync: async () => {} }, [
    sceneNode("component", "Button", "COMPONENT", { key: "component-key", isAsset: false }),
  ]);
  const root = attach({ id: "document", name: "Fixture", type: "DOCUMENT" }, [pageOne, pageTwo]);
  const nodes = new Map();
  const index = (node) => {
    nodes.set(node.id, node);
    if (node.children) node.children.forEach(index);
  };
  index(root);

  const figma = {
    mixed: Symbol("mixed"),
    skipInvisibleInstanceChildren: false,
    editorType: "figma",
    fileKey: undefined,
    root,
    currentPage: pageOne,
    ui: { postMessage() {}, onmessage: null },
    clientStorage: { getAsync: async () => null, setAsync: async () => {} },
    showUI() {},
    notify() {},
    on() {},
    loadAllPagesAsync: async () => {},
    getNodeByIdAsync: async (id) => nodes.get(id) || null,
  };

  const sandbox = vm.createContext({
    figma,
    __html__: "",
    console,
    setTimeout,
    clearTimeout,
    Uint8Array,
  });
  const pluginPath = path.join(__dirname, "..", "figma-plugin", "code.js");
  vm.runInContext(fs.readFileSync(pluginPath, "utf8"), sandbox, { filename: pluginPath });

  assert.equal(figma.skipInvisibleInstanceChildren, true);
  const documentInfo = await vm.runInContext("getDocumentInfo()", sandbox);
  assert.equal(documentInfo.pageCount, 2);
  assert.equal(documentInfo.pages[0].children.length, 1);

  const context = await vm.runInContext('getDesignContext({ scope: "all_pages" })', sandbox);
  assert.equal(context.pages.length, 2);
  assert.equal(context.hiddenNodesExcluded, true);
  assert.equal(JSON.stringify(context).includes("Hidden child"), false);
  assert.equal(JSON.stringify(context).includes("Deep leaf"), true);
  assert.equal(context.stats.pageCount, 2);
  assert.equal(context.stats.textNodeCount, 1);
  assert.ok(context.assets.some((asset) => asset.id === "screen" && asset.kind === "screen"));
  assert.ok(context.assets.some((asset) => asset.id === "vector" && asset.suggestedFormat === "SVG"));
  assert.ok(context.assets.some((asset) => asset.id === "image" && asset.kind === "image"));
  assert.ok(context.tokens.colors.some((token) => token.value === "#ff0000"));

  const assets = await vm.runInContext('listDesignAssets({ scope: "all_pages", kinds: ["vector"] })', sandbox);
  assert.equal(JSON.stringify(assets.assets.map((asset) => asset.id)), '["vector"]');

  await assert.rejects(
    vm.runInContext('exportNodeAsImage({ nodeId: "hidden-child", format: "PNG" })', sandbox),
    /Hidden nodes are excluded/
  );

  console.log("plugin-read.test.cjs: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
