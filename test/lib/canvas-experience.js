// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs");

const canvasFixture = (nodes, edges) => `
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 250));
      localStorage.clear();
      window.__store.jia = { main: { version: 2, updatedAt: 1000, edges: ${JSON.stringify(edges || [])}, nodes: ${JSON.stringify(nodes)} } };
      window.__active = "jia"; canvasState.canvasName = "main"; canvasState.handsOnAt = 0; canvasState.nodeGesture = null;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }`;
const canvasNodeFixture = (id, kind, payload, x, y) => ({ id, kind, payload, position: { x, y } });

// 新旧画布回归共用同一份真实页面和项目存储夹具。
async function runCanvasExperience({ run, win, ok }) {
  const 摆画布 = canvasFixture, 卡片 = canvasNodeFixture;
  const 同 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  console.log("\n— 五十二、卡片直接输入、空内容不生成、新节点在当前视口 —");
  const 卡上输入 = await run(`
    (async () => {
      ${摆画布([])}
      const page = document.getElementById("assist-page"), paper = canvasState.paper;
      canvasZoom(page, .65); canvasState.x = -2800; canvasState.y = -1700; paper.translate(-2800, -1700);
      const image = canvasAddNode("image"), root = canvasWireRoot(image.id), field = root.querySelector('[data-canvas-inline-key="prompt"]');
      const r = root.getBoundingClientRect(), v = document.getElementById("canvas-viewport").getBoundingClientRect();
      const out = { 空值: field.value, 聚焦: document.activeElement === field, 无面板: !canvasState.inspectorOpen,
        可见: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom };
      field.value = "保留原人物，换成海边夜景\\n@角色"; field.dispatchEvent(new Event("input", { bubbles: true }));
      out.内容 = canvasPayload(image).prompt;
      const menuEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); field.dispatchEvent(menuEvent);
      const key = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }); field.dispatchEvent(key);
      out.原生输入 = !menuEvent.defaultPrevented && !key.defaultPrevented && !document.getElementById("canvas-context-menu");
      let saves = 0; const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === canvasStorageKey()) saves++; return setItem.call(this, key, value); };
      try {
        for (let i = 0; i < 40; i++) { field.value = "连续输入" + i; field.dispatchEvent(new Event("input", { bubbles: true })); }
        const before = saves; await canvasFlushRemoteWrite();
        out.合并保存 = { 之前: before, 之后: saves, 最后内容: canvasLoadSaved().nodes.find((n) => n.id === image.id).payload.prompt };
      } finally { Storage.prototype.setItem = setItem; }
      const reference = canvasAddNode("image", { title: "参考素材", path: "ref.png" }, { x: 20, y: 20 }, { skipSelect: true });
      canvasConnect(reference, image, "reference");
      field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true }));
      window.__runs = []; window.__bodies = [];
      const results = [await canvasGenerate(image, "image")];
      const video = canvasAddNode("video", { first_frame: "ref.png" }); results.push(await canvasGenerate(video, "video"));
      const audio = canvasAddNode("audio"); results.push(await canvasGenerate(audio, "audio"));
      out.空内容 = { 结果: results, 请求: window.__runs.length, 工具请求: window.__bodies.filter((b) => b.url === "/api/tool/run").length };
      const old = canvasAddNode("image", { prompt: "这张图要保持的主体、风格与构图…" }); out.旧占位 = await canvasGenerate(old, "image");
      const note = canvasAddNode("note"), edit = canvasWireRoot(note.id).querySelector("[contenteditable=true]");
      out.笔记 = { 内容: edit.textContent, 聚焦: document.activeElement === edit, 存的: canvasPayload(note).text };
      const shot = canvasAddNode("shot"); out.镜头 = { 空提示词: canvasPayload(shot).prompt === "", 空台词: canvasPayload(shot).line === "", 就地输入: canvasState.inlineEdit?.nodeId === shot.id };
      canvasInlineCancel(); await canvasFlushRemoteWrite(); return out;
    })()`);
  ok(卡上输入.空值 === "" && 卡上输入.聚焦 && 卡上输入.无面板, "新参考图卡片直接出现空输入框并聚焦，不用先开设置", 卡上输入);
  ok(卡上输入.可见, "大幅平移、缩放后添加的节点仍完整出现在当前视口", 卡上输入);
  ok(卡上输入.内容 === "保留原人物，换成海边夜景\n@角色" && 卡上输入.原生输入, "卡片输入实时保存，换行、@、退格和原生右键不被画布快捷键吞掉", 卡上输入);
  ok(卡上输入.合并保存.之前 === 0 && 卡上输入.合并保存.之后 === 1 && 卡上输入.合并保存.最后内容 === "连续输入39", "连续输入 40 次合并为一次快照，切换前立即写下最后一笔", 卡上输入.合并保存);
  ok(卡上输入.空内容.请求 === 0 && 卡上输入.空内容.工具请求 === 0 && 卡上输入.空内容.结果.every((r) => !r.ok && r.error === "缺提示词"), "空图片/视频/配音均不发请求；已连参考图或已有首帧也不代替提示词", 卡上输入.空内容);
  ok(!卡上输入.旧占位.ok && 卡上输入.旧占位.error === "占位文字", "旧存档里的示例占位文案仍被识别，不能误生成", 卡上输入.旧占位);
  ok(卡上输入.笔记.内容 === "" && 卡上输入.笔记.存的 === "" && 卡上输入.笔记.聚焦 && 卡上输入.镜头.空提示词 && 卡上输入.镜头.空台词 && 卡上输入.镜头.就地输入, "笔记、镜头初值为空，添加后直接输入，不用先删示例文字", 卡上输入);

  console.log("\n— 五十三、批量参考、复制不丢关系、批量整理和删除只保存一次 —");
  const 批量体验 = await run(`
    (async () => {
      ${摆画布([卡片("r1", "image", { title: "人物参考", path: "ref-a.png" }, 40, 40), 卡片("r2", "image", { title: "光线参考", path: "ref-b.png" }, 500, 300)])}
      canvasSetSelection(["r1", "r2"]); canvasHistoryReset(canvasSnapshot());
      canvasConnectReferences("__new__");
      const target = canvasSelectedNode(), id = target.id;
      const 连好 = { 个数: canvasState.graph.getElements().length, 输入: canvasUpstreamImages(target), 聚焦: document.activeElement === canvasWireRoot(id).querySelector("textarea"), 提示词: canvasPayload(target).prompt };
      target.set("canvasPayload", { ...canvasPayload(target), prompt: "同一个人物，柔和侧光", model: "指定图模型", pending_jobs: { image: { id: "原任务" } }, generation_runs: [{ output: "原结果.png" }] });
      canvasPersist(); canvasHistoryFlush();
      const copies = canvasDuplicateSelection(target), copy = copies[0], cp = canvasPayload(copy);
      const 复制 = { 输入: canvasUpstreamImages(copy), 提示词: cp.prompt, 型号: cp.model, 无旧任务: !cp.pending_jobs && !cp.generation_runs, 未串绑: !cp.board && !cp.sourceId };
      canvasSetSelection(["r1", "r2"]); canvasArrangeSelection("left");
      const 整理 = canvasState.graph.getCell("r1").position().x === canvasState.graph.getCell("r2").position().x;
      canvasHistoryFlush(); canvasUndo();
      const 撤销整理 = canvasState.graph.getCell("r1").position().x !== canvasState.graph.getCell("r2").position().x;
      canvasSetSelection(["r1", "r2"]); canvasHistoryReset(canvasSnapshot());
      let writes = 0; const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === canvasStorageKey()) writes++; return original.call(this, key, value); };
      try { canvasDeleteSelection(); } finally { Storage.prototype.setItem = original; }
      const 删除 = { 次数: writes, 源卡没了: !canvasState.graph.getCell("r1") && !canvasState.graph.getCell("r2") };
      canvasUndo();
      删除.撤回 = !!canvasState.graph.getCell("r1") && !!canvasState.graph.getCell("r2") && canvasUpstreamImages(canvasState.graph.getCell(id)).length === 2;
      await canvasFlushRemoteWrite(); return { 连好, 复制, 整理, 撤销整理, 删除 };
    })()`);
  ok(批量体验.连好.个数 === 3 && 批量体验.连好.输入.length === 2 && 批量体验.连好.聚焦 && 批量体验.连好.提示词 === "", "多张素材一次连进新图片节点，只聚焦输入，不自动生成", 批量体验.连好);
  ok(同(批量体验.复制.输入, 批量体验.连好.输入) && 批量体验.复制.提示词 === "同一个人物，柔和侧光" && 批量体验.复制.型号 === "指定图模型" && 批量体验.复制.无旧任务 && 批量体验.复制.未串绑, "复制保留模型、提示词、上游参考，不继承旧任务或分镜绑定", 批量体验.复制);
  ok(批量体验.整理 && 批量体验.撤销整理, "多选左对齐可用，一次撤销还原各自位置", 批量体验);
  ok(批量体验.删除.次数 === 1 && 批量体验.删除.源卡没了 && 批量体验.删除.撤回, "批量删除只写一次本机快照，撤销同时恢复节点和连线", 批量体验.删除);

  console.log("\n— 五十四、大画布增量同步、滚轮合帧与小地图 —");
  const 大图 = Array.from({ length: 160 }, (_, i) => 卡片("perf" + i, "note", { title: "节点 " + i, text: "内容 " + i }, (i % 16) * 400, Math.floor(i / 16) * 300));
  const 性能体验 = await run(`
    (async () => {
      ${摆画布(大图)}
      const page = document.getElementById("assist-page"), graph = canvasState.graph, paper = canvasState.paper;
      const roots = new Map(graph.getElements().map((node) => [node.id, canvasWireRoot(node.id).firstElementChild]));
      const snap = canvasSnapshot(); snap.nodes[80].payload = { ...snap.nodes[80].payload, text: "只改这一张" };
      let refreshes = 0; const refresh = window.canvasRefreshNode;
      window.canvasRefreshNode = (...args) => { refreshes++; return refresh(...args); };
      const start = performance.now();
      try { canvasApplySnapshot(snap, { fromRemote: true }); } finally { window.canvasRefreshNode = refresh; }
      const 同步 = { 耗时: performance.now() - start, 重画: refreshes, 保留: graph.getElements().filter((node) => canvasWireRoot(node.id).firstElementChild === roots.get(node.id)).length, 改到了: canvasPayload(graph.getCell("perf80")).text };
      canvasZoom(page, .6); canvasState.x = 0; canvasState.y = 0; paper.translate(0, 0);
      let transforms = 0; const translate = paper.translate;
      paper.translate = function(...args) { if (args.length) transforms++; return translate.apply(this, args); };
      const world = page.querySelector("#canvas-world");
      for (let i = 0; i < 120; i++) world.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 1, deltaY: 2, clientX: 600, clientY: 300 }));
      const 帧前 = transforms; await new Promise(requestAnimationFrame); paper.translate = translate;
      const 滚动 = { 帧前, 变换: transforms, x: canvasState.x, y: canvasState.y };
      page.querySelector("[data-canvas-minimap]").click(); await new Promise(requestAnimationFrame);
      const map = canvasState.minimap, before = canvasState.x;
      const r = map.svg.getBoundingClientRect();
      // 使用真实坐标换算，跳转不依赖小地图当前的缩放比例。
      const point = new DOMPoint(r.left + r.width * .8, r.top + r.height * .5).matrixTransform(map.svg.getScreenCTM().inverse());
      const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: r.left + r.width * .8, clientY: r.top + r.height * .5 });
      // 合成指针没有活跃硬件 id；只替换 capture，不替换导航计算。
      const capture = map.svg.setPointerCapture; map.svg.setPointerCapture = () => {};
      try { map.svg.dispatchEvent(pointer); } finally { map.svg.setPointerCapture = capture; }
      const area = canvasViewportArea(page), mr = map.el.getBoundingClientRect();
      const 导航 = { 显示: !map.el.hidden, 正确图层: map.nodes.ownerSVGElement === map.svg && map.svg.viewBox.baseVal.width > 0, 不被遮住: mr.bottom <= area.top + area.height + 1 && mr.top >= area.top, 轮廓: map.nodes.children.length, 移了: before !== canvasState.x, 准确: Math.abs(canvasState.x - (area.offsetX + area.width / 2 - point.x * canvasState.scale)) < .1 };
      map.el.querySelector("button").click(); 导航.可关闭 = map.el.hidden;
      await canvasFlushRemoteWrite(); return { 同步, 滚动, 导航 };
    })()`);
  ok(性能体验.同步.重画 === 1 && 性能体验.同步.保留 === 159 && 性能体验.同步.改到了 === "只改这一张", "160 节点只改一张：仅重画一张，另外 159 张卡片 DOM 保留", 性能体验.同步);
  ok(性能体验.滚动.帧前 === 0 && 性能体验.滚动.变换 === 1 && 性能体验.滚动.x === -120 && 性能体验.滚动.y === -240, "120 个滚轮事件一帧只改一次 SVG，累计位移完整保留", 性能体验.滚动);
  ok(性能体验.导航.显示 && 性能体验.导航.正确图层 && 性能体验.导航.不被遮住 && 性能体验.导航.轮廓 === 160 && 性能体验.导航.移了 && 性能体验.导航.准确 && 性能体验.导航.可关闭, "小地图按需打开，展示全部轮廓，点击准确跳转并可关闭；不被底部对话框遮住", 性能体验.导航);
  console.log("  增量同步测量（本机 Chromium，160 张笔记卡）:", JSON.stringify(性能体验.同步));

  if (process.env.CANVAS_SCREENSHOT) {
    await run(`document.querySelector(".input-wrap").style.display = "none"; chatCol.classList.add("wide-page"); document.getElementById("chat-scroll").scrollTop = 0; true`);
    await run(`(async () => { ${摆画布([卡片("demo1", "image", { title: "人物参考", prompt: "人物穿浅色外套，柔和日光" }, 40, 60), 卡片("demo2", "image", { title: "场景参考", prompt: "傍晚海边，远处灯塔" }, 430, 60), 卡片("demo3", "image", { title: "新画面", prompt: "保持同一个人物，在海边回头，电影感构图" }, 820, 60)], [{ source: { id: "demo1" }, target: { id: "demo3" }, relation: "reference" }, { source: { id: "demo2" }, target: { id: "demo3" }, relation: "reference" }])} canvasFitAll(document.getElementById("assist-page")); if (!canvasState.minimapOpen) document.querySelector("[data-canvas-minimap]").click(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise((r) => setTimeout(r, 60)); })()`);
    const rect = await run(`(() => { const r = document.getElementById("assist-page").getBoundingClientRect(); return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }; })()`);
    fs.writeFileSync(process.env.CANVAS_SCREENSHOT, (await win.webContents.capturePage(rect)).toPNG());
  }
}

module.exports = { canvasFixture, canvasNodeFixture, runCanvasExperience };
