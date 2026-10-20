// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
function appendReviewDraft(sid, text) {
  if (sid !== sessionId) { toast("请先回到批注所属的任务"); return false; }
  const input = document.getElementById("input"); input.value += (input.value.trim() ? "\n\n" : "") + text;
  input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); return true;
}
async function openCheckpointReview(wrap, sid, checkpoint) {
  if (wrap.querySelector(".checkpoint-review")) { wrap.querySelector(".checkpoint-review").remove(); return; }
  const panel = document.createElement("section"); panel.className = "checkpoint-review"; wrap.appendChild(panel);
  const endpoint = `/api/session/${encodeURIComponent(sid)}/checkpoints/${encodeURIComponent(checkpoint)}`;
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = I18N.t("正在读取改动…"); panel.appendChild(status);
  const call = async (action, body) => { const r = await fetch(endpoint + "/" + action, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}); const data = await r.json(); if (!r.ok) throw Error(data.error || I18N.t("读取改动失败")); return data; };
  const render = data => {
    panel.replaceChildren(status); status.textContent = I18N.t(data.current ? "选择改动块回退，或点击一行写批注。" : "文件已有其他改动，按块回退已停用。");
    const path = document.createElement("p"); path.className = "review-path"; path.dataset.i18nSkip = ""; path.textContent = data.path; panel.appendChild(path);
    for (const hunk of data.hunks) {
      const block = document.createElement("section"); block.className = "review-hunk";
      const button = document.createElement("button"); button.type = "button"; button.className = "step-rewind"; button.textContent = I18N.t(hunk.reverted ? "撤销这块回退" : "回退这一块"); button.disabled = !data.current;
      button.onclick = async () => { panel.querySelectorAll("button").forEach(b => { b.disabled = true; }); try { render(await call("revert", { hunk: hunk.id, hash: data.hash })); refreshFilesCache(); } catch(e) { status.textContent = e.message; try { const latest = await call("review"); render(latest); status.textContent = e.message; } catch {} } };
      block.appendChild(button);
      for (const [side, texts, start] of [["old", hunk.removed, hunk.old_line], ["new", hunk.added, hunk.new_line]]) texts.forEach((text, i) => {
        const line = document.createElement("button"); line.type = "button"; line.className = "review-line " + (side === "old" ? "d-del" : "d-add"); line.dataset.i18nSkip = ""; line.textContent = `${side === "old" ? "−" : "+"} ${start + i}  ${text.replace(/\n$/, "")}`;
        line.onclick = () => {
          let note = block.querySelector(".review-note"); if (!note) { note = document.createElement("div"); note.className = "review-note"; block.appendChild(note); }
          note.replaceChildren(); const label = document.createElement("label"); label.textContent = I18N.t("这行需要怎样修改？"); const input = document.createElement("textarea"); input.maxLength = 4000; label.appendChild(input);note.appendChild(label);
          const send = document.createElement("button");send.type = "button"; send.textContent = I18N.t("加入修改要求");note.appendChild(send);
          send.onclick = () => { if (!input.value.trim()) return; const ok = appendReviewDraft(sid, `File review: ${JSON.stringify(data.path)}\n${side} line ${start + i}: ${JSON.stringify(text)}\nRequested change: ${input.value.trim()}\nLimit changes to this location; preserve unrelated content.`); if (ok) note.remove(); }; input.focus();
        }; block.appendChild(line);
      }); panel.appendChild(block);
    }
    if (!data.hunks.length) status.textContent = I18N.t("没有文本改动块");
  };
  try { render(await call("review")); } catch(e) { status.textContent = e.message; }
}
