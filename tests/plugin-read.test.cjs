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
  const variant = sceneNode("variant", "State=Disabled", "COMPONENT", { variantProperties: { State: "Disabled" } });
  Object.defineProperty(variant, "componentPropertyDefinitions", { get() {
    throw new Error("Can only get component property definitions of a component set or non-variant component");
  } });
  const componentSet = attach(sceneNode("component-set", "Button states", "COMPONENT_SET", {
    componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Disabled"] } },
  }), [variant]);
  pageTwo.children.push(componentSet);componentSet.parent = pageTwo;
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
    console: {log(){},warn(){},error(){}},
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
  const readVariant = context.pages[1].nodes.find(node => node.id === "component-set").children[0];
  assert.equal(readVariant.componentPropertyDefinitionsSourceId, "component-set");
  assert.equal(readVariant.componentPropertyDefinitions.State.type, "VARIANT");
  assert.equal(readVariant.variantProperties.State, "Disabled");

  const assets = await vm.runInContext('listDesignAssets({ scope: "all_pages", kinds: ["vector"] })', sandbox);
  assert.equal(JSON.stringify(assets.assets.map((asset) => asset.id)), '["vector"]');

  await assert.rejects(
    vm.runInContext('exportNodeAsImage({ nodeId: "hidden-child", format: "PNG" })', sandbox),
    /Hidden nodes are excluded/
  );

  let readWrites = 0;
  Object.defineProperty(text, "fills", { configurable: true, get: () => [], set: () => { readWrites++; } });
  Object.defineProperty(text, "strokes", { configurable: true, get: () => [], set: () => { readWrites++; } });
  Object.defineProperty(text, "strokeWeight", { configurable: true, get: () => 1, set: () => { readWrites++; } });
  text.reactions = [{ trigger: { type: "ON_CLICK" }, action: { type: "NODE", navigation: "CHANGE_TO", destinationId: "component" } }];
  const scans = await vm.runInContext('scanTextNodes({nodeId:"text",useChunking:true})',sandbox);
  assert.equal(scans.textNodes[0].characters,"Hello");
  const legacyScans = await vm.runInContext('scanTextNodes({nodeId:"text",useChunking:false})',sandbox);
  assert.ok(JSON.stringify(legacyScans).includes("Hello"));
  const reactions = await vm.runInContext('getReactions(["text"])',sandbox);
  assert.ok(JSON.stringify(reactions).includes("CHANGE_TO"),"variant reactions must not be dropped");
  assert.equal(readWrites,0,"read tools must not mutate fills or strokes, including temporary highlights");

  pageOne.appendChild = (node) => { node.parent = pageOne; pageOne.children.push(node); nodes.set(node.id, node); };
  let createdCounter = 0;
  const createEditable = (type) => {
    const node = sceneNode(`created-${++createdCounter}`, "New", type, {fontName:{family:"Inter",style:"Regular"},characters:""});
    node.resize = (width,height) => { node.width=width;node.height=height; };
    node.remove = () => { node.removed=true;pageOne.children=pageOne.children.filter(child=>child!==node);nodes.delete(node.id); };
    return node;
  };
  figma.createFrame = () => createEditable("FRAME");
  let invalidFrame;
  figma.createFrame = () => (invalidFrame=createEditable("FRAME"));
  await assert.rejects(vm.runInContext('createFrame({parentId:"missing-parent"})',sandbox),/Parent node not found/);
  assert.equal(invalidFrame.removed,true,"failed creation must remove its owned node");
  figma.createComponent=()=>createEditable("COMPONENT");
  const component = await vm.runInContext('noteFigmaCreateComponent({fillColor:{r:1,g:0,b:0}})',sandbox);
  assert.equal(nodes.get(component.id).fills[0].opacity,1,"missing alpha defaults to 1 instead of NaN");
  const transparent = await vm.runInContext('createFrame({ x:0,y:0,width:20,height:20,fillColor:{r:1,g:0,b:0,a:0} })',sandbox);
  assert.equal(transparent.fills[0].opacity,0);
  let fontCalls=0,releaseFont;
  figma.createText = () => createEditable("TEXT");
  figma.loadFontAsync = () => ++fontCalls===2 ? new Promise(resolve=>releaseFont=resolve) : Promise.resolve();
  let settled=false;
  const writing=vm.runInContext('createText({ text:"Complete",fontSize:12.5,fontColor:{r:0,g:0,b:0,a:0} })',sandbox).then(value=>{settled=true;return value;});
  await new Promise(setImmediate);
  assert.equal(settled,false,"creation must wait for the final font load and characters write");
  releaseFont();const created=await writing;
  assert.equal(created.characters,"Complete");assert.equal(created.fontSize,12.5);assert.equal(created.fills[0].opacity,0);
  let failedNode;
  figma.createText = () => (failedNode=createEditable("TEXT"));
  figma.loadFontAsync = async () => {throw new Error("Font unavailable");};
  await assert.rejects(vm.runInContext('createText({ text:"Cannot create" })',sandbox),/Font unavailable/);
  assert.equal(failedNode.removed,true,"font failure must clean up the new node");

  const mixedText = sceneNode("mixed-text","Mixed","TEXT",{fontName:figma.mixed,characters:"AB"});
  mixedText.getRangeAllFontNames = () => [{family:"Font A",style:"Regular"},{family:"Font B",style:"Bold"}];
  nodes.set(mixedText.id,mixedText);mixedText.parent=pageOne;
  const loadedFonts=[];figma.loadFontAsync=async font=>{loadedFonts.push(font.family);};
  await vm.runInContext('setTextContent({nodeId:"mixed-text",text:"Updated"})',sandbox);
  assert.equal(mixedText.characters,"Updated");assert.equal(mixedText.fontName,figma.mixed);
  assert.deepEqual(loadedFonts.sort(),["Font A","Font B"]);
  loadedFonts.length=0;
  figma.loadFontAsync=async font=>{loadedFonts.push(font.family);};
  await vm.runInContext('noteFigmaSetTextStyle({nodeId:"mixed-text",fontSize:15})',sandbox);
  assert.equal(mixedText.fontName,figma.mixed);assert.equal(mixedText.fontSize,15);
  await assert.rejects(vm.runInContext('noteFigmaSetTextStyle({nodeId:"mixed-text",fontWeight:700})',sandbox),/Specify fontFamily/);
  figma.base64Decode=data=>new Uint8Array(Buffer.from(data,'base64'));
  figma.createImage=bytes=>{assert.equal(Buffer.from(bytes).toString(),'x');return {hash:'test-image'};};
  let imported;
  figma.createRectangle=()=>(imported=createEditable('RECTANGLE'));
  await assert.rejects(vm.runInContext('importImage({imageData:"eA==",width:24,height:24,parentId:"missing"})',sandbox),/Parent node not found/);
  assert.equal(imported.removed,true);
  const effect=await vm.runInContext('noteFigmaSetEffects({nodeId:"screen",effects:[{type:"DROP_SHADOW",color:{r:0,g:0,b:0,a:0},radius:0}]})',sandbox);
  assert.equal(effect.effects[0].color.a,0);assert.equal(effect.effects[0].radius,0);
  assert.deepEqual(loadedFonts.sort(),["Font A","Font B"]);
  figma.loadFontAsync=async()=>{throw new Error("Original font missing");};
  await assert.rejects(vm.runInContext('setTextContent({nodeId:"mixed-text",text:"Do not apply"})',sandbox),/Original font missing/);
  assert.equal(mixedText.characters,"Updated");assert.equal(mixedText.fontName,figma.mixed);
  const batch = await vm.runInContext('noteFigmaBatchCreate({operations:[{command:"set_annotation",params:{}}]})',sandbox);
  assert.equal(batch.failed,1);assert.equal(batch.succeeded,0);
  await assert.rejects(vm.runInContext('handleCommand("set_instance_overrides",{})',sandbox),/Missing targetNodeIds/);
  screen.annotations=[];hiddenChild.annotations=[{label:'hidden annotation'}];
  const annotations=await vm.runInContext('getAnnotations({nodeId:"screen",includeCategories:false})',sandbox);
  assert.equal(annotations.annotations.length,0);
  await assert.rejects(vm.runInContext('getAnnotations({nodeId:"hidden-child",includeCategories:false})',sandbox),/Hidden nodes/);

  console.log("plugin-read.test.cjs: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
