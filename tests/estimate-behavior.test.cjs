const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "見積書.html"), "utf8");
function definition(name) {
  const match = new RegExp("\\n((?:async )?function " + name + "\\()").exec(html);
  assert.ok(match, "missing actual function: " + name);
  const start = match.index + 1;
  const rest = html.slice(start);
  const end = /\n(?:function |async function |const |let |\/\*)/.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

function harness() {
  const fields = new Map();
  const lists = new Map(["partsList", "customList", "wdList", "lodgeList"].map(id => [id, []]));
  let renderCount = 0, dirtyCount = 0, previewCount = 0, autosaveCount = 0;
  function input(value = "", type = "text") {
    let text = String(value);
    const listeners = {};
    return {
      type, checked: false, className: "", textContent: "", innerHTML: "", disabled: false,
      get value() { return text; }, set value(value) { text = String(value); },
      addEventListener(event, listener) { listeners[event] = listener; },
      fire(event) { if (listeners[event]) listeners[event](); }
    };
  }
  const $ = id => {
    if (!fields.has(id)) {
      const field = input();
      if (lists.has(id)) {
        Object.defineProperty(field, "innerHTML", { get: () => "", set: () => lists.set(id, []) });
        field.appendChild = row => { row.parentList = id; lists.get(id).push(row); };
      }
      fields.set(id, field);
    }
    return fields.get(id);
  };
  const defaults = {
    partRow: { ".pn": "", ".pc": "", ".pa": "", ".pq": "1" },
    customRow: { ".cn": "", ".ca": "", ".cq": "1" },
    wdayRow: { ".wdPeople": "1", ".wdHours": "", ".wdNight": "0", ".wdHol": "" },
    lodgeRow: { ".ldgMemo": "", ".ldgPeople": "1", ".ldgNights": "", ".ldgHol": "" }
  };
  for (const [id, values] of Object.entries(defaults)) {
    $(id).content = { cloneNode() {
      const cells = Object.fromEntries(Object.entries(values).map(([selector, value]) => [selector, input(value)]));
      cells[".del"] = input();
      const row = {
        dataset: {}, querySelector: selector => cells[selector],
        remove() { lists.set(this.parentList, lists.get(this.parentList).filter(item => item !== this)); }
      };
      return { querySelector: () => row };
    } };
  }
  const context = {
    document: {
      getElementById: $,
      querySelectorAll(selector) {
        const match = /^#(partsList|customList|wdList|lodgeList) /.exec(selector);
        return match ? lists.get(match[1]) : [];
      }
    },
    clearTimeout,
    _livePreviewT: null, _documentRevision: 0,
    initialFieldValues: { workFee: "0", address: "", mKocon: "", b1_km: "", b1_h: "", b1_toll: "" },
    setDirectEdits() {}, migrateLegacyDirectEdits: () => ({}), _excludedItemKeys: new Set(),
    syncBase() {}, renderSheet() { renderCount++; },
    scheduleLivePreview() { previewCount++; }, autosave() { autosaveCount++; }, cancelLocalAutosave() {}
  };
  vm.createContext(context);
  const names = [
    "newRowId", "invalidateRouteRequests", "routeRequestIsCurrent",
    "addPartRow", "partRowsRaw", "getParts", "addCustomRow", "customRowsRaw", "getCustom",
    "addWdayRow", "wdayRows", "perDayFee", "recomputeWorkFee", "syncWE",
    "addLodgeRow", "lodgeRows", "lodgeTotals", "refreshLodge", "lodgesFromState",
    "validateEstimateState", "applyState", "originAddr", "autoCalc", "cancelPendingFormUpdates"
  ];
  const preface = html.slice(html.indexOf("const P="), html.indexOf("function invalidateRouteRequests"));
  vm.runInContext(preface + "\n" + names.map(definition).join("\n"), context);
  vm.runInContext("driveAutosaveController={markDirty:()=>recordDirty()};", Object.assign(context, { recordDirty() { dirtyCount++; } }));
  $("apiKey").value = "test-key"; $("address").value = "旧住所"; $("mKocon").value = "JOB-A";
  return { context, $, lists, counts: () => ({ renderCount, dirtyCount, previewCount, autosaveCount }) };
}

async function main() {
  const h = harness(), c = h.context;
  for (const [text, expected] of [["1e3", 1000], ["1e-3", 0.001], ["¥1,234", 1234], ["", 0], ["-100", -100], ["1e400", 0]]) {
    assert.equal(vm.runInContext("parseNum(" + JSON.stringify(text) + ")", c), expected, "number parsing: " + text);
  }
  c.addPartRow({ name: "無償部品", cost: 800, excl: 0, qty: 1 });
  assert.equal(h.lists.get("partsList")[0].querySelector(".pa").value, "0", "numeric zero must survive restoration");
  assert.equal(c.getParts()[0].amt, 0, "explicit zero must not fall back to cost markup");
  const part = h.lists.get("partsList")[0];
  part.querySelector(".pa").value = "";
  assert.equal(c.getParts()[0].amt, 1000, "blank price still computes markup");
  part.querySelector(".pq").value = "0";
  assert.equal(c.getParts()[0].amt, 0, "quantity zero must not charge one item");
  part.querySelector(".pq").value = "";
  assert.equal(c.getParts()[0].amt, 1000, "blank quantity retains default one");
  part.querySelector(".pa").value = "-1000";
  assert.equal(c.getParts()[0].amt, 0, "negative part prices cannot reduce the estimate");
  part.querySelector(".pa").value = ""; part.querySelector(".pc").value = "-800";
  assert.equal(c.getParts()[0].amt, 0, "negative costs cannot produce a negative markup");
  c.addCustomRow({ name: "雑費", amt: 500, qty: 0 });
  assert.equal(c.getCustom()[0].amt, 0);
  const custom = h.lists.get("customList")[0];
  custom.querySelector(".cq").value = "";
  assert.equal(c.getCustom()[0].amt, 500);
  custom.querySelector(".ca").value = "-500";
  assert.equal(c.getCustom()[0].amt, 0, "negative custom costs cannot reduce the estimate");
  custom.querySelector(".cn").value = "";
  assert.equal(c.getCustom().length, 0, "the documented name-required behavior is preserved");

  const state = workFee => ({
    documentType: "estimate", fields: { workFee },
    wdays: [{ people: "1", hours: "3", night: "0", holiday: false }], parts: [], customs: [], lodges: []
  });
  c.applyState(state("50000"));
  assert.equal(h.$("workFee").value, "50000", "loading preserves a manually changed fee");
  h.lists.get("wdList")[0].querySelector(".wdHours").value = "4";
  h.lists.get("wdList")[0].querySelector(".wdHours").fire("input");
  assert.equal(h.$("workFee").value, "54000", "normal work edits still recalculate");
  c.applyState(state("0"));
  assert.equal(h.$("workFee").value, "0");
  c.applyState(state(""));
  assert.equal(h.$("workFee").value, "", "an intentionally cleared fee stays cleared");
  const noFee = state("50000"); delete noFee.fields.workFee;
  c.applyState(noFee);
  assert.equal(h.$("workFee").value, "45000", "missing fee calculates from work rows");
  c.applyState({ fields: { workFee: "70000" }, parts: [], customs: [] });
  assert.equal(h.$("workFee").value, "70000", "older data without daily rows retains its stored fee");
  c.applyState({ fields: { apiKey: "replacement-key", loadFile: "unexpected-file" } });
  assert.equal(h.$("apiKey").value, "test-key", "document data cannot replace a device API key");
  assert.equal(h.$("loadFile").value, "", "unknown fields cannot write a file input");

  function deferredRoute() {
    let resolve, reject;
    c.googleRoute = () => new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = c.autoCalc("b1");
    return { pending, resolve: () => resolve({ km: 100, h: 2, toll: 1200, hasToll: true }), reject };
  }
  h.$("address").value = "旧住所"; h.$("mKocon").value = "JOB-A";
  const loaded = deferredRoute();
  c.applyState({ fields: { address: "新住所", mKocon: "JOB-B", b1_km: "20", b1_h: "0.5", b1_toll: "0" } });
  const countsBefore = h.counts();
  loaded.resolve(); await loaded.pending;
  assert.equal(h.$("b1_km").value, "20", "old route response must not overwrite a loaded job");
  assert.deepEqual(h.counts(), countsBefore, "discarded response must not save the new document");

  const edited = deferredRoute(); h.$("b1_km").value = "30";
  edited.resolve(); await edited.pending;
  assert.equal(h.$("b1_km").value, "30", "manual route edits win over a pending response");

  const changedAddress = deferredRoute(); h.$("address").value = "別住所";
  changedAddress.resolve(); await changedAddress.pending;
  assert.equal(h.$("b1_km").value, "30", "address changes discard old route data");
  const valid = deferredRoute(); valid.resolve(); await valid.pending;
  assert.equal(h.$("b1_km").value, "100.0");
  assert.equal(h.$("b1_h").value, "2.0");
  assert.equal(h.$("b1_toll").value, "1200");
  assert.equal(h.counts().dirtyCount, 1, "accepted response requests autosave once");

  const old = deferredRoute(); c.cancelPendingFormUpdates();
  const newer = deferredRoute();
  old.resolve(); await old.pending;
  assert.equal(h.$("b1_auto").disabled, true, "an old finally must not reenable a newer request button");
  assert.equal(h.$("b1_status").textContent, "取得中…");
  newer.resolve(); await newer.pending;
  assert.equal(h.$("b1_auto").disabled, false);
  console.log("Estimate behavior checks passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
