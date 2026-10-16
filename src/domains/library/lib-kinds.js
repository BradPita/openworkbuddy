// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 资料库「文件类型」筛选：一个名字归哪一类。
 *
 * 前端 public/js/app-04.js 的 LIB_KINDS 是同一套判定的另一份（浏览器里 require 不到这儿）。
 * 两份必须一字不差地判出同样的结果：服务端按类型筛完再分页，前端拿到的那页再按自己的判定
 * 摆进分组——判法一旦长歪，「表格」页里就会混进一份 PDF，或者一张图两边都不认。
 * test/library-favs.js 拿同一批名字两边各判一遍，对不上就红。
 *
 * f.deck：同目录有 deck.json 的网页，是一页页的幻灯片，归「演示」不归「网页」。
 */
const KINDS = {
  img: (n) => /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif)$/i.test(n),
  doc: (n) => /\.(md|markdown|txt|docx?|rtf|pages|odt)$/i.test(n),
  sheet: (n) => /\.(csv|tsv|xlsx?|numbers|ods)$/i.test(n),
  slide: (n, f) => /\.(pptx?|key|odp)$/i.test(n) || (!!(f && f.deck) && /\.html?$/i.test(n)),
  pdf: (n) => /\.pdf$/i.test(n),
  web: (n, f) => /\.html?$/i.test(n) && !(f && f.deck),
  media: (n) => /\.(mp4|mov|webm|mkv|m4v|mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(n),
};

/** kind 不认识（含 "all"）一律放行：筛选条件写坏了，宁可多给也别整页清空 */
function kindOk(kind, name, file) {
  const fn = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
  return !fn || fn(String(name == null ? "" : name), file);
}

module.exports = { KINDS, KIND_KEYS: Object.keys(KINDS), kindOk };
