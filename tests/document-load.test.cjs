const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the actual form applicators: a sparse/older JSON must not retain fields
// from the previously opened customer or job.
for (const [file, type] of [["見積書.html", "estimate"], ["報告書メーカー.html", "report"]]) {
  const html = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const validator = type === "estimate" ? "validateEstimateState" : "validateReportState";
  const validationStart = html.indexOf("function " + validator + "(");
  const validationEnd = html.indexOf(type === "estimate" ? "let _documentRevision" : "function validateImportedEstimate", validationStart);
  const applyStart = html.indexOf("function applyState(raw)");
  const applyEnd = html.indexOf("/* ===== 自動保存", applyStart);
  const fields = new Map([
    ["mKocon", { value: "old-job", type: "text" }],
    ["client", { value: "前の会社", type: "text" }],
    ["subject", { value: "前の案件", type: "text" }],
    ["address", { value: "前の住所", type: "text" }],
    ["billName", { value: "前の請求先", type: "text" }],
    ["directUse", { checked: true, type: "checkbox" }]
  ]);
  const $ = id => {
    if (!fields.has(id)) fields.set(id, { innerHTML: "" });
    return fields.get(id);
  };
  const noop = () => {};
  const ctx = {
    $, clearTimeout, _livePreviewT: null, _documentRevision: 0,
    initialFieldValues: { mKocon: "", client: "", subject: "", address: "", billName: "", directUse: false },
    setDirectEdits: noop, migrateLegacyDirectEdits: () => ({}), _excludedItemKeys: new Set(),
    addPartRow: noop, addCustomRow: noop, addWdayRow: noop, addLodgeRow: noop,
    lodgesFromState: state => state.lodges || [], refreshLodge: noop, syncWE: noop,
    syncBase: noop, renderSheet: noop,
    isValidSignatureData: value => value === "", normalizeWorkRows: rows => rows,
    DEFAULT_WORKERS: [], WORKERS: [], ACTIVE: [], saveWorkers: noop,
    renderWorkerPick: noop, migrateLegacyReportEdits: () => ({}),
    addWorkRow: noop, mainPad: null, sigDataURL: "", updateSigState: noop,
    syncSameState: noop, refreshDirect: noop, renderReport: noop
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(validationStart, validationEnd) + "\n" + html.slice(applyStart, applyEnd), ctx);
  ctx.applyState({ documentType: type, fields: { estNo: "loaded-job", subject: "読み込み後" }, work: [], _kkmtRevision: 4 });
  assert.equal($("mKocon").value, "loaded-job");
  assert.equal($("subject").value, "読み込み後");
  assert.equal($("client").value, "");
  assert.equal($("address").value, "");
  assert.equal($("billName").value, "");
  assert.equal($("directUse").checked, false);
  assert.equal(ctx._documentRevision, 4);
  assert.throws(() => ctx.applyState({ documentType: type, fields: {}, work: [null], parts: [null] }));
  assert.equal($("subject").value, "読み込み後", "invalid data must not replace the loaded form");
}

// Exercise FileReader success, decoding errors, and I/O failures.
const window = {};
window.window = window;
class Reader {
  readAsText(file) {
    queueMicrotask(() => {
      if (file.error) return this.onerror();
      if (file.abort) return this.onabort();
      this.result = file.text;
      this.onload();
    });
  }
}
window.FileReader = Reader;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "google-drive.js"), "utf8"), { window });
(async () => {
  const read = window.KKMTDrive.readJsonFile;
  assert.equal((await read({ text: '{"version":3}' })).version, 3);
  await assert.rejects(() => read({ text: "{" }), /JSONデータ/);
  await assert.rejects(() => read({ error: true }), /ファイルを読み取れません/);
  await assert.rejects(() => read({ abort: true }), /中止/);
  console.log("Document loading checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
