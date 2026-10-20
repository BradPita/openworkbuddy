// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";

const OWBPreviewRuntime = (() => {
  function memoryStorage() {
    const values = new Map();
    // Inventory and dashboard pages often serialize their whole database on each save.
    // Business dashboards can serialize a database plus a few recovery snapshots on each save.
    // 8 MiB still surfaced as a misleading storage-full error for those pages.
    // Keep a bounded per-document quota because this is temporary, untrusted preview storage.
    const limit = 64 * 1024 * 1024;
    let bytes = 0;
    const methods = Object.create(typeof Storage === "function" ? Storage.prototype : Object.prototype);
    const setItem = (key, value) => {
      key = String(key); value = String(value);
      const previous = values.has(key) ? 2 * (key.length + values.get(key).length) : 0;
      const next = bytes - previous + 2 * (key.length + value.length);
      if (next > limit) throw new DOMException("Preview storage quota exceeded", "QuotaExceededError");
      values.set(key, value); bytes = next;
    };
    Object.defineProperties(methods, {
      length: { get: () => values.size },
      getItem: { value: key => values.has(String(key)) ? values.get(String(key)) : null },
      setItem: { value: setItem },
      removeItem: { value: key => { key = String(key); if (values.has(key)) { bytes -= 2 * (key.length + values.get(key).length); values.delete(key); } } },
      clear: { value: () => { values.clear(); bytes = 0; } },
      key: { value: index => [...values.keys()][Number(index) >>> 0] ?? null },
      [Symbol.toStringTag]: { value: "Storage" },
    });
    return new Proxy(Object.create(methods), {
      get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : values.get(key),
      set: (_target, key, value) => { if (typeof key !== "string") return false; setItem(key, value); return true; },
      deleteProperty: (_target, key) => { methods.removeItem(key); return true; },
      ownKeys: () => [...values.keys()],
      getOwnPropertyDescriptor: (_target, key) => values.has(key) ? { value: values.get(key), writable: true, enumerable: true, configurable: true } : undefined,
    });
  }

  function installStorage() {
    // Only replace unavailable storage. Each preview document gets its own temporary maps.
    // Its opaque origin, cookies and access to the parent application remain unchanged.
    for (const name of ["localStorage", "sessionStorage"]) {
      try { if (globalThis[name] && typeof globalThis[name].getItem === "function") continue; } catch {}
      try { Object.defineProperty(globalThis, name, { configurable: true, value: memoryStorage() }); } catch {}
    }
  }

  function inject(html, scriptUrl = "/js/preview-runtime.js") {
    const source = String(html);
    const url = String(scriptUrl).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    // Preserve the doctype and early metadata before adding a parser-blocking script.
    // This runs before the page's scripts read storage, including scripts in <head>.
    const leading = /^(?:\s|\uFEFF|\u00EF\u00BB\u00BF|<!--[\s\S]*?-->|<!doctype[^>]*>)*/i;
    let at = source.match(leading)[0].length;
    for (const tag of ["html", "head"]) {
      const match = source.slice(at).match(new RegExp("^<" + tag + "\\b(?:\"[^\"]*\"|'[^']*'|[^'\">])*>(?:\\s|<!--[\\s\\S]*?-->)*", "i"));
      if (match) at += match[0].length;
    }
    const metadata = source.slice(at).match(/^(?:<meta\b(?:"[^"]*"|'[^']*'|[^'">])*\s*>(?:\s|<!--[\s\S]*?-->)*)+/i);
    if (metadata) at += metadata[0].length;
    return source.slice(0, at) + '<script src="' + url + '" data-owb-preview></script>' + source.slice(at);
  }

  return { inject, installStorage };
})();

if (typeof module !== "undefined" && module.exports) module.exports = OWBPreviewRuntime;
else globalThis.OWBPreviewRuntime = OWBPreviewRuntime;
if (typeof document !== "undefined" && document.currentScript?.hasAttribute("data-owb-preview")) OWBPreviewRuntime.installStorage();
