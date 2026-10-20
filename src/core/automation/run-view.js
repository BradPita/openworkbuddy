// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
/** The inbox only needs navigation and status, without report bodies or tool output. */
function publicRun(run, summary = false) {
  const { source_session_id, ...rest } = run;
  if (!summary) return { ...rest, source_linked: !!source_session_id };
  return { id: run.id, name: run.name, session_id: run.session_id, ended_at: run.ended_at, ok: run.ok, source_linked: !!source_session_id };
}
module.exports = { publicRun };
