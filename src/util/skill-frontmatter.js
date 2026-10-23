// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · Commercial use requires authorization: COMMERCIAL-LICENSE.md
"use strict";
/** 技能与插件共用解析，避免为了读取元数据加载整个技能管理模块。 */
function parseFrontmatter(raw) {
  const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const out = { name: "", description: "", content: String(raw).trim() };
  if (m) {
    out.content = m[2].trim();
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^(\w+):\s*(.*)$/); // 只认顶层键，metadata 下的缩进行不会误匹配
      if (!kv || (kv[1] !== "name" && kv[1] !== "description")) continue;
      let val = kv[2].trim();
      // YAML 折行块（description: >）：吸收后续缩进行拼成一行
      if (/^[>|][+-]?$/.test(val)) {
        const parts = [];
        while (i + 1 < lines.length && (!lines[i + 1].trim() || /^\s+\S/.test(lines[i + 1]))) {
          parts.push(lines[++i].trim());
        }
        val = parts.filter(Boolean).join(" ");
      }
      out[kv[1]] = val.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

module.exports = { parseFrontmatter };
