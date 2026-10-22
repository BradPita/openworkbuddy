// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
/* 画布创作界面：起步入口、卡片参数与参考输入、结果衔接、按需展开的对话。
 * 只组合既有节点与生成能力，不另造一份工作流或存储格式。
 */
function canvasWorkspaceEmpty() {
  const empty = document.getElementById("canvas-start");
  if (empty) empty.hidden = !!canvasState.graph?.getElements().length;
}

function canvasSetChatOpen(open, focus = false) {
  const page = document.getElementById("assist-page"), panel = page?.querySelector(".canvas-chat");
  if (!panel) return;
  canvasState.chatOpen = !!open; panel.classList.toggle("is-collapsed", !open);
  panel.querySelector("[data-canvas-chat-toggle]")?.setAttribute("aria-expanded", String(!!open));
  const body = panel.querySelector(".canvas-chat-body"); if (body) body.hidden = !open;
  if (open && focus) document.getElementById("canvas-chat-input")?.focus({ preventScroll: true });
  canvasMinimapView();
}

function canvasWorkspaceStartMarkup() {
  const choices = [
    ["image", "image", "创作图片", "输入描述，生成或修改图片"],
    ["video", "video", "制作视频", "文字生成，或从图片开始"],
    ["import", "folder-open", "导入素材", "把本机图片、视频、声音放进来"],
  ];
  return `<div id="canvas-start" class="canvas-start" hidden><span class="canvas-start-eyebrow">${esc(canvasT("从一个想法开始"))}</span><h2>${esc(canvasT("你想创作什么？"))}</h2><p>${esc(canvasT("描述想法、连接素材，每一步都能继续修改。"))}</p><div class="canvas-start-options">${choices.map(([action, icon, title, sub]) => `<button type="button" data-canvas-start="${action}">${ic(icon)}<b>${esc(canvasT(title))}</b><small>${esc(canvasT(sub))}</small>${ic("arrow-up-right")}</button>`).join("")}</div><div class="canvas-start-foot"><button type="button" data-canvas-recipe="image-video">${esc(canvasT("图片 → 视频"))}${ic("arrow-right")}</button><button type="button" data-canvas-start="drama">${esc(canvasT("短剧工作流"))}${ic("arrow-right")}</button></div><small class="canvas-start-help">${esc(canvasT("也可以直接拖入素材；创建节点不会开始生成。"))}</small></div>`;
}

function canvasCreateRecipe() {
  const graph = canvasState.graph; if (!graph) return;
  canvasHistoryFlush(); graph.startBatch("canvas-edit");
  let image, video;
  try {
    const p = canvasNewNodePosition("image");
    image = canvasAddNode("image", { title: canvasT("起始画面") }, p, { persist: false, skipSelect: true });
    video = canvasAddNode("video", { title: canvasT("让画面动起来") }, { x: p.x + 440, y: p.y }, { persist: false, skipSelect: true });
    canvasConnect(image, video, "first_frame");
  } finally { graph.stopBatch("canvas-edit"); }
  canvasSetSelection([image.id], image.id); canvasFitFlush(); canvasPersist(); canvasHistoryFlush();
  canvasFitAll(document.getElementById("assist-page")); canvasFocusNodeInput(image);
}

async function canvasImportMedia(files, target = null) {
  const scope = canvasScope(), graph = canvasState.graph;
  for (const file of Array.from(files || []).slice(0, 12)) {
    try {
      const kind = canvasFileKindFromFile(file);
      if (!["image", "video", "audio"].includes(kind)) throw new Error(canvasT("只支持图片、视频或音频文件"));
      const path = await canvasUploadWorkspaceFile(file);
      if (graph !== canvasState.graph || scope !== canvasScope()) { canvasToast(canvasT("素材已上传到原项目，画布已切换，没有放入当前画布。"), "info"); return; }
      const node = canvasAddNode(kind, { title: file.name, path, url: path, role: "参考素材" }, undefined, { skipSelect: true });
      if (target && graph.getCell(target.id) === target) canvasAddCardReference(target, node);
      else { canvasSetSelection([node.id], node.id); canvasCenterSelected(document.getElementById("assist-page")); }
    } catch (error) { canvasToast(`${canvasT("素材导入失败")}：${String(error.message || error).slice(0, 160)}`, "circle-x", "err"); }
  }
  canvasLoadLibrary();
}

function canvasBindWorkspace(page) {
  const choose = () => page.querySelector("[data-canvas-import-file]")?.click();
  page.querySelectorAll("[data-canvas-start]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.canvasStart;
    if (action === "import") choose();
    else if (action === "drama") canvasCreateDramaWorkflow();
    else canvasAddNode(action);
  }));
  page.querySelectorAll("[data-canvas-recipe]").forEach((button) => button.addEventListener("click", canvasCreateRecipe));
  page.querySelector("[data-canvas-import]")?.addEventListener("click", choose);
  page.querySelector("[data-canvas-export]")?.addEventListener("click", () => canvasExportSelection());
  const input = page.querySelector("[data-canvas-import-file]");
  input?.addEventListener("change", () => { canvasImportMedia(input.files); input.value = ""; });
  page.querySelector("[data-canvas-chat-toggle]")?.addEventListener("click", () => canvasSetChatOpen(!canvasState.chatOpen, !canvasState.chatOpen));
  page.querySelector("[data-canvas-chat-open]")?.addEventListener("click", () => canvasSetChatOpen(!canvasState.chatOpen, !canvasState.chatOpen));
  const viewport = page.querySelector("#canvas-viewport");
  viewport?.addEventListener("dragover", (event) => { if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); viewport.classList.add("is-file-drop"); } });
  viewport?.addEventListener("dragleave", (event) => { if (!viewport.contains(event.relatedTarget)) viewport.classList.remove("is-file-drop"); });
  viewport?.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault(); viewport.classList.remove("is-file-drop"); canvasImportMedia(event.dataTransfer.files);
  });
  const head = page.querySelector(".canvas-head"), progress = page.querySelector(".canvas-progress");
  canvasState.workspaceObserver = new ResizeObserver(() => {
    page.style.setProperty("--canvas-head-h", Math.ceil(head.getBoundingClientRect().height) + "px");
    page.style.setProperty("--canvas-surface-top", Math.ceil(viewport.getBoundingClientRect().top - page.getBoundingClientRect().top) + "px");
  });
  canvasState.workspaceObserver.observe(head); if (progress) canvasState.workspaceObserver.observe(progress);
  const graph = canvasState.graph;
  graph.on("add remove", (cell) => {
    canvasWorkspaceEmpty();
    if (canvasState.bulk || !cell.isLink()) return;
    const target = graph.getCell(canvasEndpointId(cell.get("target"))); if (target) canvasRefreshCardInputs(target);
  });
  graph.on("change:canvasPayload", (node) => {
    if (canvasState.bulk) return;
    const p = canvasPayload(node), previous = node.previous("canvasPayload") || {};
    if (["path", "url", "first_frame", "reference", "video", "audio", "title", "name"].every((key) => p[key] === previous[key])) return;
    const outgoing = graph.getConnectedLinks ? graph.getConnectedLinks(node, { outbound: true }) : graph.getLinks().filter((link) => canvasEndpointId(link.get("source")) === node.id);
    outgoing.forEach((link) => {
      const target = graph.getCell(canvasEndpointId(link.get("target"))); if (target) canvasRefreshCardInputs(target);
    });
  });
  canvasState.languageHandler = () => {
    if (!page.isConnected || canvasState.graph !== graph) return;
    graph.getElements().forEach((node) => canvasRefreshNode(node));
    graph.getLinks().forEach((link) => canvasDecorateLink(link, canvasLinkRelation(link)));
    canvasRenderInspector(false);
  };
  document.addEventListener("owb-lang", canvasState.languageHandler);
  canvasSetChatOpen(canvasState.chatOpen); canvasWorkspaceEmpty();
}

function canvasMediaDefaults(kind, update) {
  const keys = kind === "video" ? ["model", "aspect_ratio", "duration", "resolution"] : kind === "image" ? ["model", "size"] : kind === "audio" ? ["voice"] : [];
  if (!keys.length) return {};
  if (canvasState.cardDefaults?.scope !== canvasScope()) canvasState.cardDefaults = { scope: canvasScope() };
  if (!canvasState.cardDefaults[kind]) {
    const previous = [...(canvasState.graph?.getElements() || [])].reverse().find((node) => canvasKind(node) === kind && keys.some((key) => Object.hasOwn(canvasPayload(node), key)));
    canvasState.cardDefaults[kind] = previous ? Object.fromEntries(keys.filter((key) => canvasPayload(previous)[key] != null).map((key) => [key, canvasPayload(previous)[key]])) : {};
  }
  if (update) for (const key of keys) if (Object.hasOwn(update, key)) canvasState.cardDefaults[kind][key] = update[key];
  return { ...canvasState.cardDefaults[kind] };
}

function canvasCardSettings(kind, payload) {
  const model = ["image", "video"].includes(kind)
    ? canvasMediaModelField(canvasT("模型"), kind, payload.model || "").replace('class="canvas-inspector-field"', 'class="canvas-card-model"').replace("data-inspect-key", "data-canvas-card-key") : "";
  const select = (key, label, options, value) => {
    const values = options.some(([v]) => v === String(value || "")) ? options : [[String(value || ""), String(value || "")], ...options];
    return `<label><span>${esc(canvasT(label))}</span><select data-canvas-card-key="${key}" aria-label="${esc(canvasT(label))}">${values.map(([v, text]) => `<option value="${esc(v)}" ${v === String(value || "") ? "selected" : ""}>${esc(canvasT(text))}</option>`).join("")}</select></label>`;
  };
  const ratio = select("aspect_ratio", "画幅", [["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"], ["4:3", "4:3"], ["3:4", "3:4"]], payload.aspect_ratio || "16:9");
  const size = select("size", "尺寸", [["", "模型默认"], ["1024x1024", "1024 × 1024"], ["1536x1024", "1536 × 1024"], ["1024x1536", "1024 × 1536"]], payload.size || "");
  const duration = select("duration", "时长", [["5s", "5s"], ["10s", "10s"], ["15s", "15s"]], payload.duration || "5s");
  const resolution = select("resolution", "分辨率", [["720p", "720p"], ["1080p", "1080p"]], payload.resolution || "1080p");
  const voice = kind === "audio" ? `<label class="canvas-card-voice"><span>${esc(canvasT("音色"))}</span><input data-canvas-card-key="voice" value="${esc(payload.voice || "")}" placeholder="${esc(canvasT("默认音色"))}" aria-label="${esc(canvasT("音色"))}"></label>` : "";
  const advanced = kind === "video" ? ratio + duration + resolution : kind === "image" ? `<span title="${esc(canvasT("自定义尺寸仅在模型支持时生效"))}">${size}</span>` : "";
  const summary = kind === "video" ? `${payload.aspect_ratio || "16:9"} · ${payload.duration || "5s"}` : canvasT("尺寸与高级参数");
  return `<div class="canvas-card-settings">${model}${voice}${advanced ? `<details class="canvas-card-advanced"><summary>${esc(summary)}${ic("chevron-down")}</summary><div>${advanced}</div></details>` : ""}</div>`;
}

function canvasCardReferenceCandidates(target) {
  const graph = canvasState.graph; if (!graph || !target) return [];
  const blocked = new Set([target.id]), downstream = new Map(), connected = new Set();
  // 一次遍历连线找后代，避免每个候选都重新遍历整张图。
  graph.getLinks().forEach((link) => {
    const from = canvasEndpointId(link.get("source")), to = canvasEndpointId(link.get("target"));
    if (!downstream.has(from)) downstream.set(from, []); downstream.get(from).push(to);
    if (to === target.id) connected.add(from);
  });
  const stack = [target.id];
  while (stack.length) for (const id of downstream.get(stack.pop()) || []) if (!blocked.has(id)) { blocked.add(id); stack.push(id); }
  const kinds = CANVAS_LINK_SOURCES[canvasKind(target)] || [];
  return graph.getElements().filter((source) => !blocked.has(source.id) && !connected.has(source.id) && kinds.includes(canvasKind(source)));
}

function canvasCardInputs(nodeId, payload, kind) {
  if (!["image", "video", "audio"].includes(kind)) return "";
  const node = canvasState.graph?.getCell(nodeId), inputs = node ? canvasUpstreamInputs(node) : [];
  const linked = inputs.map((item) => {
    const link = canvasState.graph.getCell(item.linkId);
    const image = canvasUpstreamImage(item), thumb = image ? `<img src="${esc(canvasFileUrl(image, 96))}" alt="" loading="lazy">` : ic(CANVAS_NODE_DEFS[item.kind]?.icon || "file-text");
    return `<div class="canvas-card-ref"><button type="button" class="canvas-card-ref-source" data-canvas-ref-focus="${esc(item.nodeId)}" title="${esc(item.label)}">${thumb}<span>${esc(item.label)}</span></button><select data-canvas-card-relation="${esc(link?.id || "")}" aria-label="${esc(canvasT("参考用途"))}">${(kind === "video" && image ? [["first_frame", "首帧"], ["last_frame", "尾帧"]] : CANVAS_EDGE_RELATIONS).map(([value, label]) => `<option value="${value}" ${value === item.relation ? "selected" : ""}>${esc(canvasT(label))}</option>`).join("")}</select><button type="button" data-canvas-card-disconnect="${esc(link?.id || "")}" title="${esc(canvasT("移除引用"))}" aria-label="${esc(canvasT("移除引用"))}">${ic("x")}</button></div>`;
  });
  const directFields = kind === "video" ? [["first_frame", "首帧"], ["last_frame", "尾帧"], ["reference_video", "参考视频"]] : kind === "image" ? [["reference", "参考图"], ["first_frame", "首帧"]] : [];
  const direct = directFields.filter(([key]) => payload[key]).map(([key, label]) => `<div class="canvas-card-ref is-direct"><span title="${esc(payload[key])}">${esc(canvasT(label))} · ${esc(String(payload[key]).split(/[\\/]/).pop())}</span><button type="button" data-canvas-card-clear="${key}" aria-label="${esc(canvasT("移除引用"))}">${ic("x")}</button></div>`);
  // 候选列表在用户展开时再计算，整图载入时不对每张卡各扫一遍节点和连线。
  const candidates = [];
  return `<div class="canvas-card-inputs" data-canvas-inputs><div class="canvas-card-inputs-head"><span>${esc(canvasT("参考输入"))}${inputs.length + direct.length ? ` · ${inputs.length + direct.length}` : ""}</span>${kind === "audio" ? "" : `<button type="button" data-canvas-card-upload title="${esc(canvasT("上传参考素材"))}">${ic("plus")}${esc(canvasT("上传"))}</button><input type="file" data-canvas-card-file accept="image/*" multiple hidden>`}</div>${linked.join("")}${direct.join("")}<select class="canvas-card-ref-add" data-canvas-card-reference aria-label="${esc(canvasT("从画布添加参考"))}"><option value="">${esc(canvasT("＋ 从画布添加参考"))}</option>${candidates.map((source) => `<option value="${esc(source.id)}">${esc(canvasNodeLabel(source))}</option>`).join("")}</select></div>`;
}

function canvasAddCardReference(target, source) {
  const why = canvasLinkProblem(source, target);
  if (why) { canvasToast(why, "triangle-alert", "err"); return false; }
  const item = { node: source, kind: canvasKind(source), path: canvasMediaPath(canvasPayload(source)) };
  const image = canvasUpstreamImage(item);
  if (item.kind === "image" && item.path && !image) { canvasToast(canvasT("参考图请使用项目内的 PNG、JPEG、WebP、GIF 或 BMP 文件。"), "info"); return false; }
  const targetPayload = canvasPayload(target), references = [...new Set([targetPayload.reference, targetPayload.first_frame, ...canvasUpstreamImages(target)].filter(Boolean))];
  if (image && references.length >= 4 && !references.includes(image)) { canvasToast(canvasT("最多使用 4 张参考图"), "triangle-alert", "err"); return false; }
  const isVideo = canvasKind(target) === "video";
  if (isVideo && !image && !["note", "script", "agent"].includes(canvasKind(source))) { canvasToast(canvasT("视频参考需要可用图片；视频文件可作为独立素材使用。"), "info"); return false; }
  const hasFirst = canvasPayload(target).first_frame || canvasUpstreamInputs(target).some((input) => input.relation === "first_frame");
  const hasLast = canvasPayload(target).last_frame || canvasUpstreamInputs(target).some((input) => input.relation === "last_frame");
  if (isVideo && image && hasFirst && hasLast) { canvasToast(canvasT("首帧和尾帧已有图片，请先移除要替换的引用。"), "info"); return false; }
  const relation = isVideo && image ? (hasFirst ? "last_frame" : "first_frame") : image ? "reference" : canvasDefaultRelation(source, target);
  canvasHistoryFlush(); canvasConnect(source, target, relation); canvasFitFlush(); canvasPersist();
  return true;
}

function canvasRefreshCardInputs(node) {
  if (!node?.graph || !["image", "video", "audio"].includes(canvasKind(node))) return;
  const root = canvasWireRoot(node.id), old = root?.querySelector("[data-canvas-inputs]"); if (!old) return;
  const temp = document.createElement("template"); temp.innerHTML = canvasCardInputs(node.id, canvasPayload(node), canvasKind(node));
  old.replaceWith(temp.content.firstElementChild); canvasBindCardInputs(node, root); canvasFitSoon(node);
}

function canvasBindCardInputs(node, root) {
  const box = root.querySelector("[data-canvas-inputs]"); if (!box) return;
  box.querySelectorAll("button, select, input").forEach((field) => { field.addEventListener("pointerdown", (event) => event.stopPropagation()); field.addEventListener("keydown", (event) => event.stopPropagation()); });
  box.querySelectorAll("[data-canvas-card-disconnect]").forEach((button) => button.addEventListener("click", () => {
    canvasHistoryFlush(); canvasState.graph.getCell(button.dataset.canvasCardDisconnect)?.remove(); canvasPersist();
  }));
  box.querySelectorAll("[data-canvas-card-clear]").forEach((button) => button.addEventListener("click", () => {
    const next = canvasPayload(node); delete next[button.dataset.canvasCardClear]; node.set("canvasPayload", next);
    canvasRefreshCardInputs(node); canvasPersist(); canvasInspectorSyncField(node, button.dataset.canvasCardClear);
  }));
  box.querySelectorAll("[data-canvas-ref-focus]").forEach((button) => button.addEventListener("click", () => {
    canvasSetSelection([button.dataset.canvasRefFocus]); canvasCenterSelected(document.getElementById("assist-page"));
  }));
  box.querySelectorAll("[data-canvas-card-relation]").forEach((select) => select.addEventListener("change", () => {
    const link = canvasState.graph.getCell(select.dataset.canvasCardRelation); if (!link) return;
    canvasHistoryFlush(); canvasDecorateLink(link, select.value); canvasPersist();
  }));
  const select = box.querySelector("[data-canvas-card-reference]");
  select?.addEventListener("focus", () => {
    select.innerHTML = `<option value="">${esc(canvasT("＋ 从画布添加参考"))}</option>${canvasCardReferenceCandidates(node).map((source) => `<option value="${esc(source.id)}">${esc(canvasNodeLabel(source))}</option>`).join("")}`;
  });
  select?.addEventListener("change", () => { const source = canvasState.graph.getCell(select.value); if (source) canvasAddCardReference(node, source); });
  const upload = box.querySelector("[data-canvas-card-file]");
  box.querySelector("[data-canvas-card-upload]")?.addEventListener("click", () => upload.click());
  upload?.addEventListener("change", () => { canvasImportMedia(upload.files, node); upload.value = ""; });
}

function canvasCardNextActions(kind, payload, nodeId) {
  if (!canvasMediaPath(payload) || !canvasMediaAvailable(canvasMediaPath(payload))) return "";
  const image = kind === "image", versions = new Set([canvasMediaPath(payload), ...(payload.generation_runs || []).filter((run) => run.kind === kind).flatMap((run) => [run.output, run.replaced])].filter(Boolean));
  return `<div class="canvas-card-next"><span>${esc(canvasT("继续创作"))}</span>${image ? `<button type="button" data-canvas-next="image">${esc(canvasT("做变体"))}</button><button type="button" data-canvas-next="video">${esc(canvasT("做视频"))}${ic("arrow-right")}</button>` : ""}${versions.size > 1 ? `<button type="button" data-canvas-compare>${esc(canvasT("对比版本"))}</button>` : ""}<button type="button" data-canvas-reroll="${kind}" title="${esc(canvasT("会重新生成并扣费，当前文件会保留"))}">${esc(canvasT("换一版"))}</button></div>`;
}

function canvasCreateFromResult(source, kind) {
  const file = canvasUpstreamImage({ node: source, kind: canvasKind(source), path: canvasMediaPath(canvasPayload(source)) });
  if (!file || !canvasMediaAvailable(file)) { canvasToast(canvasT("请先生成或导入一张可用图片"), "info"); return; }
  const graph = canvasState.graph; canvasHistoryFlush(); graph.startBatch("canvas-edit");
  let target;
  try {
    const p = canvasPayload(source), inherit = kind === "image" ? { model: p.model || "", size: p.size || "" } : {};
    target = canvasAddNode(kind, { ...inherit, title: canvasT(kind === "video" ? "让画面动起来" : "图片变体"), prompt: "" }, undefined, { persist: false, skipSelect: true });
    canvasConnect(source, target, kind === "video" ? "first_frame" : "reference");
  } finally { graph.stopBatch("canvas-edit"); }
  canvasSetSelection([target.id], target.id); canvasFitFlush(); canvasPersist(); canvasHistoryFlush(); canvasCenterSelected(document.getElementById("assist-page")); canvasFocusNodeInput(target);
}

function canvasBindCardControls(node, root) {
  canvasBindCardInputs(node, root);
  root.querySelectorAll(".canvas-card-advanced summary").forEach((summary) => summary.addEventListener("pointerdown", (event) => event.stopPropagation()));
  root.querySelectorAll(".canvas-card-advanced").forEach((details) => details.addEventListener("toggle", () => canvasFitSoon(node)));
  root.querySelectorAll("[data-canvas-card-key]").forEach((field) => {
    field.addEventListener("pointerdown", (event) => event.stopPropagation());
    field.addEventListener("keydown", (event) => event.stopPropagation());
    field.addEventListener("change", () => {
      canvasHistoryFlush(); const key = field.dataset.canvasCardKey;
      node.set("canvasPayload", { ...canvasPayload(node), [key]: field.value }); canvasMediaDefaults(canvasKind(node), { [key]: field.value });
      canvasPersist(); canvasInspectorSyncField(node, key);
    });
  });
  root.querySelectorAll("[data-canvas-next]").forEach((button) => button.addEventListener("click", () => canvasCreateFromResult(node, button.dataset.canvasNext)));
  root.querySelector("[data-canvas-compare]")?.addEventListener("click", () => canvasCompareVersions(node));
  root.querySelectorAll("[data-canvas-reroll]").forEach((button) => button.addEventListener("click", () => canvasReroll(node, button.dataset.canvasReroll)));
}

function canvasCompareVersions(node) {
  const kind = canvasKind(node), rows = canvasHistoryVersions(node, canvasPayload(node), kind).filter((row) => canvasMediaAvailable(row.rel));
  if (rows.length < 2) return;
  canvasState.compareClose?.();
  const restoreFocus = document.activeElement;
  const overlay = document.createElement("div"); overlay.className = "canvas-media-lightbox is-open canvas-compare";
  overlay.innerHTML = `<div class="canvas-media-lightbox-card" role="dialog" aria-modal="true" aria-label="${esc(canvasT("对比版本"))}"><div class="canvas-media-lightbox-head"><b>${esc(canvasNodeLabel(node))} · ${esc(canvasT("对比版本"))}</b><button type="button" data-compare-close aria-label="${esc(canvasT("关闭"))}">${ic("x")}</button></div><div class="canvas-compare-columns">${[0, 1].map((side) => `<section><select data-compare-select="${side}" aria-label="${esc(canvasT(side ? "右侧版本" : "左侧版本"))}">${rows.map((row, index) => `<option value="${index}" ${index === side ? "selected" : ""}>${esc(row.version > 0 ? `v${row.version}` : canvasT("原版"))} · ${esc(row.rel.split(/[\\/]/).pop())}</option>`).join("")}</select><div data-compare-media></div><button type="button" class="ui-btn ui-btn--outline ui-btn--sm" data-compare-use>${esc(canvasT("用这一版"))}</button></section>`).join("")}</div></div>`;
  const scope = canvasScope(), graph = canvasState.graph;
  const refresh = (section) => {
    const rel = rows[Number(section.querySelector("select").value)].rel, stage = section.querySelector("[data-compare-media]");
    stage.innerHTML = kind === "image" ? `<img src="${esc(canvasFileUrl(rel))}" alt="${esc(canvasT("生成版本"))}">` : kind === "video" ? `<video src="${esc(canvasFileUrl(rel))}" controls preload="metadata"></video>` : canvasAudioPreview(rel);
  };
  const close = () => { overlay.querySelectorAll("video,audio").forEach((media) => media.pause()); overlay.remove(); document.removeEventListener("keydown", key); canvasState.compareClose = null; if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true }); };
  const key = (event) => {
    if (imeKey(event)) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const fields = [...overlay.querySelectorAll("button,select,video,audio")], first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  overlay.querySelectorAll("section").forEach((section) => {
    refresh(section); section.querySelector("select").onchange = () => refresh(section);
    section.querySelector("[data-compare-use]").onclick = async () => { if (canvasScope() !== scope || canvasState.graph !== graph) return close(); await canvasUseVersion(node.id, kind, rows[Number(section.querySelector("select").value)].rel); close(); };
  });
  overlay.querySelector("[data-compare-close]").onclick = close;
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  canvasState.compareClose = close; document.addEventListener("keydown", key); document.body.appendChild(overlay); overlay.querySelector("select").focus();
}


async function canvasExportSelection(selected = false) {
  const scope = canvasScope();
  await canvasFlushRemoteWrite();
  if (scope !== canvasScope()) return;
  if (canvasState.remoteBroken || canvasState.saveFailed || canvasState.remoteConflict || canvasState.restoreChoice) { canvasToast(canvasT("请先处理画布保存问题，再导出。"), "triangle-alert", "err"); return; }
  const ids = selected ? [...canvasState.selectedIds] : [];
  if (selected && !ids.length) { canvasToast(canvasT("请先选择要导出的节点"), "info"); return; }
  const query = new URLSearchParams({ name: canvasState.canvasName });
  if (ids.length) query.set("nodeIds", JSON.stringify(ids));
  if (query.toString().length > 12000) { canvasToast(canvasT("选中节点过多，请分批或导出整张画布。"), "info"); return; }
  const button = document.querySelector("[data-canvas-export]"); if (button) button.disabled = true;
  try {
    const url = `/api/canvas/export?${query}`;
    const response = await fetch(url + "&check=1"), info = await response.json();
    if (!response.ok) throw new Error(info.error || canvasT("导出失败"));
    if (scope !== canvasScope()) return;
    // 让浏览器直接流式下载，媒体包不转成前端 Blob/ArrayBuffer。
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${canvasState.canvasName}.zip`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    canvasToast(info.missing.length ? canvasT("已开始导出，{n} 项素材未打包，详情见 manifest.json。", { n: info.missing.length }) : canvasT("已开始导出画布与 {n} 个素材文件。", { n: info.files }), info.missing.length ? "triangle-alert" : "download");
  } catch (error) { canvasToast(`${canvasT("导出失败")}：${String(error.message || error).slice(0, 160)}`, "circle-x", "err"); }
  finally { if (button) button.disabled = false; }
}
