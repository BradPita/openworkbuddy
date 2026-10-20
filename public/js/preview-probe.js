// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
(() => {
  const intersects = (a, b) => a.right > b.x && a.left < b.x + b.width && a.bottom > b.y && a.top < b.y + b.height;
  const selector = el => { const parts = []; while (el && el.nodeType === 1 && parts.length < 10) { const tag = el.tagName.toLowerCase(); if (el.id) { parts.unshift("#" + CSS.escape(el.id)); break; } const peers = el.parentElement ? [...el.parentElement.children].filter(x => x.tagName === el.tagName) : [el]; parts.unshift(tag + (peers.length > 1 ? ":nth-of-type(" + (peers.indexOf(el) + 1) + ")" : "")); el = el.parentElement; } return parts.join(" > "); };
  addEventListener("message", ev => {
    const m = ev.data; if (ev.source !== parent || m?.type !== "owb-preview-region" || !/^[\w-]{20,80}$/.test(m.id)) return;
    const rect = m.rect; if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
    const selected = [];
    for (const el of document.querySelectorAll("h1,h2,h3,h4,p,li,td,th,pre,button,a,img,svg,text")) {
      if (selected.length >= 50) break; const r = el.getBoundingClientRect(); if (!intersects(r, rect)) continue;
      const text = el.matches("img") ? el.getAttribute("alt") || "image" : el.textContent;
      selected.push({ selector: selector(el), text: String(text || "").slice(0, 300), ...(el.closest("td,th") ? { row: el.closest("tr")?.rowIndex + 1, column: el.closest("td,th").cellIndex + 1 } : {}) });
    }
    parent.postMessage({ type: "owb-preview-region-result", id: m.id, selected }, "*");
  });
})();
