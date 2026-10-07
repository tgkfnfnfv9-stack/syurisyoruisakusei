#!/usr/bin/env node
"use strict";
// Measures control-flow waiting with real wall-clock timers and simulated APIs.
// This is not a browser rendering benchmark or a mobile-device performance test.
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { fixture } = require("./helpers/export-fixture.cjs");
const ROOT = path.join(__dirname, "..");
const BASE = "1cf9131";
const REPEATS = 3, WAIT_MS = 250, RENDER_MS = 20, STALLED_OBSERVATION_MS = 100;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const oldSources = Object.fromEntries([["report", "報告書メーカー.html"], ["estimate", "見積書.html"]].map(([type, name]) => [type,
  execFileSync("git", ["show", `${BASE}:${name}`], { cwd: ROOT, encoding: "utf8" })
]));
function between(source, start, end) {
  const from = source.indexOf(start); const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error("Baseline export functions were not found: " + start);
  return source.slice(from, to);
}
function setup(version, type, kind, mode) {
  const f = fixture({ realTimers: true, render: () => pause(RENDER_MS) });
  const counts = { whenIdle: 0, renders: 0, previewFlushes: 0, fitCalls: 0 };
  const app = new f.Element("main"); app.className = "app";
  const page = new f.Element("section"); page.id = "sheet"; page.className = "sheet"; page.textContent = "顧客A・1234円・作業内容";
  app.appendChild(page); f.document.body.appendChild(app);
  const state = { documentType: type, schemaVersion: 2, fields: { mKocon: "123", subject: "計測用", amount: "1234" } };
  const flush = () => { counts.previewFlushes++; counts.fitCalls++; };
  Object.assign(f.global, {
    driveAutosaveController: { whenIdle() { counts.whenIdle++; return mode === "stalled" ? new Promise(() => {}) : pause(WAIT_MS); } },
    $: id => id === "sheet" ? page : null,
    collectState: () => JSON.parse(JSON.stringify(state)), fileBaseName: () => "123_計測用",
    flushLivePreview: flush, flushReportPreview: flush,
    fitSheet: () => counts.fitCalls++, fitAllCells: () => counts.fitCalls++,
    waitForReportSignature: () => Promise.resolve(true), IS_PC: true,
    pcSaveOne: async () => false, downloadBlob() {}
  });
  let run;
  if (version === "before") {
    const source = oldSources[type];
    const build = type === "report" ? "async function buildReportPdf(" : "async function buildPdf(";
    // Run actual baseline functions, replacing only their browser/API boundaries.
    vm.runInContext(between(source, build, "function downloadBlob("), f.context);
    vm.runInContext(between(source, "async function saveDataOnly(", "async function doPrint("), f.context);
    run = () => vm.runInContext(kind === "both" ? "buildOutputPair()" : kind === "json" ? "saveDataOnly()" : type === "report" ? "buildReportPdf()" : "buildPdf()", f.context);
  } else {
    const options = {
      isPC: () => true,
      capture(outputKind) {
        if (outputKind !== "json") flush();
        return { state: JSON.parse(JSON.stringify(state)), name: "123_計測用", quality: type === "report" ? 0.92 : 0.95,
          ...(outputKind === "json" ? {} : f.api.capturePages([page])) };
      }
    };
    if (type === "report") options.beforeCapture = f.global.waitForReportSignature;
    const controller = f.api.create(options);
    run = () => controller.start(kind);
  }
  return { f, counts, run };
}
async function measure(version, type, kind, mode) {
  const { f, counts, run } = setup(version, type, kind, mode);
  const started = performance.now(); let timer;
  try {
    const completed = await Promise.race([
      Promise.resolve(run()).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), mode === "stalled" ? STALLED_OBSERVATION_MS : 2000); })
    ]);
    const elapsedMs = performance.now() - started;
    counts.renders = f.captures.length;
    if (completed && version === "after" && !f.text().includes("準備ができました")) throw new Error("New exporter did not reach ready: " + f.text());
    return { completed, elapsedMs: Number(elapsedMs.toFixed(2)), ...counts };
  } finally {
    clearTimeout(timer);
    const close = f.button("閉じる"); if (close) await close.click();
    f.cleanup();
  }
}
(async () => {
  const rows = [];
  for (const mode of ["delay250", "stalled"]) for (const type of ["report", "estimate"]) for (const kind of ["pdf", "json", "both"]) for (const version of ["before", "after"]) {
    const samples = [];
    for (let i = 0; i < REPEATS; i++) samples.push(await measure(version, type, kind, mode));
    const durations = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
    rows.push({ mode, type, kind, version, completed: samples.every(sample => sample.completed), medianMs: durations[1], whenIdleCalls: samples[0].whenIdle, renders: samples[0].renders, previewFlushes: samples[0].previewFlushes, fitCalls: samples[0].fitCalls, samples });
  }
  const result = { measuredAt: new Date().toISOString(), baseline: BASE, exporterSha256: createHash("sha256").update(fs.readFileSync(path.join(ROOT, "document-export.js"))).digest("hex"), node: process.version, platform: process.platform + "/" + process.arch,
    repeats: REPEATS, waitPerCallMs: WAIT_MS, renderingPerPageMs: RENDER_MS, pages: 1, stalledObservationMs: STALLED_OBSERVATION_MS,
    scope: "API模擬条件下の制御待ち時間。実ブラウザ描画・端末共有・ディスク保存時間を含まない。", rows };
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.scope + "\n旧版: " + BASE + " / 各3回中央値 / 1ページ / render 20ms / wait呼出ごと250ms");
    console.log("| 条件 | 書類 | 出力 | 旧版 ms | 新版 ms | whenIdle旧→新 | 描画旧→新 |");
    console.log("|---|---|---|---:|---:|---:|---:|");
    for (let i = 0; i < rows.length; i += 2) { const a = rows[i], b = rows[i + 1]; console.log(`| ${a.mode} | ${a.type} | ${a.kind} | ${a.completed ? a.medianMs : ">=" + STALLED_OBSERVATION_MS + "（未完了）"} | ${b.medianMs} | ${a.whenIdleCalls}→${b.whenIdleCalls} | ${a.renders}→${b.renders} |`); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
