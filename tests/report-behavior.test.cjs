const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the real report application without PDF libraries or a browser dependency.
// This small form fixture implements the controls used by the work-row helpers.
const html = fs.readFileSync(path.join(__dirname, "..", "報告書メーカー.html"), "utf8");
const source = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
const decode = value => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
class Control {
  constructor() { this._value = ""; this.type = "text"; this.checked = false; this.dataset = {}; this.style = {}; this.children = []; this._html = ""; this.classList = { toggle() {}, add() {}, remove() {} }; }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html; }
  addEventListener() {}
  appendChild(child) { this.children.push(child); }
  querySelectorAll() { return []; }
}
class HoursBox extends Control {
  set innerHTML(value) {
    this._html = value;
    this.children = [...value.matchAll(/<input\b[^>]*class="ph"[^>]*>/g)].map(([tag]) => {
      const input = new Control(); input.type = "number";
      input.dataset.worker = decode((tag.match(/data-worker="([^"]*)"/) || ["", ""])[1]);
      const pending = tag.match(/data-unassigned="([^"]*)"/); if (pending) input.dataset.unassigned = pending[1];
      return input;
    });
  }
  get innerHTML() { return this._html; }
  querySelectorAll(selector) { return selector === ".ph" ? this.children : []; }
}
class WorkRow extends Control {
  constructor() {
    super(); this.controls = new Map([".wDate", ".wContent", ".wStart", ".wEnd", ".wHol", ".del"].map(key => [key, new Control()]));
    this.controls.set(".whours", new HoursBox());
  }
  querySelector(selector) { return this.controls.get(selector); }
  querySelectorAll(selector) { return selector === ".ph" ? this.controls.get(".whours").children : []; }
}
function fixture() {
  const fields = new Map();
  for (const [tag, id] of [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]) {
    const field = new Control(); field.type = (tag.match(/type="([^"]+)"/) || ["", "text"])[1];
    field.value = (tag.match(/\bvalue="([^"]*)"/) || ["", ""])[1]; field.checked = /\bchecked(?:\s|>)/.test(tag);
    fields.set(id, field);
  }
  const $ = id => { if (!fields.has(id)) fields.set(id, new Control()); return fields.get(id); };
  $("workRow").content = { cloneNode: () => ({ querySelector: () => new WorkRow() }) };
  let selected = [], parts = [], customs = [];
  const storage = new Map();
  const ctx = {
    console, setTimeout, clearTimeout, URL, Blob,
    document: {
      getElementById: $, addEventListener() {},
      querySelectorAll(selector) {
        if (selector === "#workRows .wrow") return $("workRows").children;
        if (selector === "#workerPick .wpk:checked") return selected.map(value => ({ value }));
        if (selector === "#partsList .prow") return parts;
        if (selector === "#customList .crow") return customs;
        if (selector === "#sheet .rc") return [...$("sheet").innerHTML.matchAll(/<td\b[^>]*class="[^"]*\brc\b[^"]*"[^>]*>(.*?)<\/td>/gs)].map(match => ({ textContent: match[1].replace(/<[^>]*>/g, "") }));
        return [];
      }
    },
    window: { addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    alert() {}, navigator: {},
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  for (const name of ["addPartRow", "addCustomRow", "addLodgeRow", "refreshLodge", "saveWorkers", "renderWorkerPick", "syncWE", "syncBase", "refreshDirect"]) ctx[name] = () => {};
  vm.runInContext('SIMPLE_IDS.forEach(id=>{const el=$(id);if(el)initialFieldValues[id]=el.type==="checkbox"?el.checked:el.value;})', ctx);
  const run = code => vm.runInContext(code, ctx);
  return { ctx, $, run, storage, select: names => { selected = names; ctx.setActiveFromPick(); }, parts: rows => { parts = rows; }, customs: rows => { customs = rows; } };
}
const plain = value => JSON.parse(JSON.stringify(value));
const work = (date, worker, hours, extra = {}) => ({ date, people: [{ worker, hours }], ...extra });
function load(f, rows, activeWorkers = [], extra = {}) { f.ctx.applyState({ documentType: "report", fields: {}, work: rows, workers: [], activeWorkers, ...extra }); }
function dataRow(values) { const controls = new Map(Object.entries(values).map(([key, value]) => [key, { value: String(value) }])); return { querySelector: selector => controls.get(selector) }; }

// A saved work person must survive an older/inconsistent activeWorkers list.
{
  const f = fixture(); load(f, [work("2026-09-30", "新井", "3.5")], ["瑞澤"]);
  assert.equal(f.ctx.getWorkRows()[0].people.find(person => person.worker === "新井").hours, "3.5");
  assert.equal(f.ctx.workFeeFromRows(), 49500);
  assert.match(f.$("sheet").innerHTML, />3\.5<\/td>/);
  assert.match(f.ctx.workTableSheet(f.ctx.getPrintableWorkRows(), ["新井"]), />3\.5<\/td>/);
  assert.equal(f.run('hoursText("0.5")'), "0.5");
}

// Same person/date gets the stated per-day minimum once, including split jobs.
{
  const f = fixture(); load(f, [work("2026-09-30", "新井", "2"), work("2026-09-30", "新井", "2")]);
  assert.equal(f.ctx.workFeeFromRows(), 54000);
  load(f, [work("2026-09-30", "新井", "2"), work("2026-10-01", "新井", "2")]);
  assert.equal(f.ctx.workFeeFromRows(), 90000);
  load(f, [work("", "新井", "2"), work("", "新井", "2")]);
  assert.equal(f.ctx.workFeeFromRows(), 90000, "undated lines must not be assumed to be the same day");
  load(f, [work("2026-09-30", "新井", "2"), work("2026-09-30", "新井", "2", { holiday: true })]);
  assert.equal(f.ctx.workFeeFromRows(), 81000);
  assert.equal(f.ctx.dayWorkFee(9), 102150);
}

// Estimate work keeps unnamed people until the user explicitly picks names.
{
  const f = fixture();
  assert.equal(f.ctx.importEstimate({ documentType: "estimate", fields: {}, wdays: [{ people: "2", hours: "3.5", night: "0", holiday: false }] }, true), true);
  assert.deepEqual(plain(f.ctx.getWorkRows()[0].people), [{ worker: "", hours: "3.5" }, { worker: "", hours: "3.5" }]);
  assert.equal(f.ctx.workFeeFromRows(), 99000);
  assert.match(f.$("sheet").innerHTML, /作業者未設定1/);
  f.select(["新井"]);
  assert.deepEqual(plain(f.ctx.getWorkRows()[0].people), [{ worker: "新井", hours: "3.5" }, { worker: "", hours: "3.5" }]);
  f.select(["新井", "瑞澤"]);
  assert.deepEqual(plain(f.ctx.getWorkRows()[0].people), [{ worker: "瑞澤", hours: "3.5" }, { worker: "新井", hours: "3.5" }]);
  f.select(["瑞澤"]); const state = plain(f.ctx.collectState());
  assert.equal(state.work[0].inactivePeople[0].worker, "新井");
  f.ctx.applyState(state); f.select(["瑞澤", "新井"]);
  assert.equal(f.ctx.getWorkRows()[0].people.find(person => person.worker === "新井").hours, "3.5", "deselect/save/load/reselect must restore the entered hours");
  f.ctx.importEstimate({ documentType: "estimate", fields: {}, wdays: [{ people: "1", hours: "4", night: "0", holiday: false }] }, true);
  f.select(["瑞澤"]); f.select(["瑞澤", "新井"]);
  assert.equal(f.ctx.getWorkRows()[0].people.find(person => person.worker === "新井").hours, "4", "previously selected blank workers may take unnamed hours after explicit reselection");
}

// Selection can include inactive/zero workers for editing without extra PDF pages.
{
  const f = fixture(); load(f, [{ date: "2026-09-30", people: [{ worker: "新井", hours: "0.5" }, ...["瑞澤", "武藤", "平野", "山口"].map(worker => ({ worker, hours: "0" }))] }]);
  assert.equal(f.ctx.getPrintableWorkRows()[0].people.length, 1);
  assert.equal(f.$("sheetExtra").innerHTML, "");
  assert.doesNotMatch(f.$("sheet").innerHTML, /<th colspan="3">山口<\/th>/);
  load(f, Array.from({ length: 8 }, (_, index) => work("2026-09-30", "新井", index ? "0" : "0.5")));
  assert.equal((f.$("sheetExtra").innerHTML.match(/class="sheet rp cont"/g) || []).length, 1);
}

// Zero quantities and an explicit zero sale price must stay zero.
{
  const f = fixture(); f.parts([dataRow({ ".pn": "部品", ".pc": "800", ".pa": "0", ".pq": "1" })]);
  assert.equal(f.ctx.getParts()[0].amt, 0);
  f.parts([dataRow({ ".pn": "部品", ".pc": "800", ".pa": "", ".pq": "0" })]); assert.equal(f.ctx.getParts()[0].amt, 0);
  f.parts([dataRow({ ".pn": "部品", ".pc": "800", ".pa": "", ".pq": "" })]); assert.equal(f.ctx.getParts()[0].amt, 1000);
  f.customs([dataRow({ ".cn": "費用", ".ca": "1000", ".cq": "0" })]); assert.equal(f.ctx.getCustom()[0].amt, 0);
  f.customs([dataRow({ ".cn": "", ".ca": "1000", ".cq": "1" })]); assert.equal(f.ctx.getCustom().length, 0, "other costs retain the stated requirement for a name");
  f.storage.set("kkmt_workers", '{"bad":true}'); f.ctx.loadWorkers(); assert.ok(f.run("WORKERS.includes('新井')"));
  for(const [input,expected] of [["1e3",1000],["1e-3",0.001],["¥1,234",1234],["",0],["-100",-100],["1e400",0]])assert.equal(f.run(`parseNum(${JSON.stringify(input)})`),expected);
}

// Signature drawing restores only the latest image; clearing/new strokes cancel it.
{
  const f=fixture(),listeners=new Map(),images=[],drawn=[];let completed=0,failed=0,cleared=0;
  const context={clearRect(){cleared++;},drawImage(image){drawn.push(image);},beginPath(){},moveTo(){},lineTo(){},stroke(){}};
  const canvas={clientWidth:320,width:320,height:150,getContext:()=>context,getAttribute:()=>null,getBoundingClientRect:()=>({left:0,top:0,width:320,height:150}),setPointerCapture(){},addEventListener:(event,handler)=>listeners.set(event,handler)};
  f.ctx.Image=class{constructor(){images.push(this);}};
  const pad=f.ctx.makePad(canvas,()=>{completed++;},()=>{failed++;});
  pad.draw("first");pad.draw("second");images[0].onload();assert.equal(drawn.length,0);images[1].onload();assert.equal(drawn.length,1);
  pad.draw("cleared");pad.clear();images[2].onload();images[2].onerror();assert.equal(drawn.length,1);assert.equal(failed,0);
  pad.draw("replaced-by-stroke");listeners.get("pointerdown")({clientX:5,clientY:6,pointerId:1});images[3].onload();assert.equal(drawn.length,1);
  listeners.get("pointermove")({clientX:10,clientY:16});listeners.get("pointercancel")();listeners.get("lostpointercapture")();assert.equal(completed,1);
  pad.draw("invalid");images[4].onerror();assert.equal(failed,1);assert.ok(cleared>=2);
}

// A route request must not overwrite another customer's fields or manual edits.
(async () => {
  // A fast confirmation waits for decoding and cannot commit a failed image.
  {
    const f=fixture(),images=[];f.ctx.Image=class{constructor(){images.push(this);}};f.ctx.autosave=()=>{};
    const invalid="data:image/png;base64,AAAA";load(f,[],[],{signature:invalid});
    assert.equal(f.$("sigState").textContent,"サイン画像を確認中…");
    assert.equal(f.ctx.collectState().signature,invalid,"loading keeps the raw state for the shared save controller");
    const validation=f.ctx.waitForReportSignature();images[0].onerror();assert.equal(await validation,false);
    assert.equal(f.ctx.collectState().signature,"");assert.doesNotMatch(f.$("sigState").textContent,/✅/);
    f.ctx.setReportSignature(invalid);const stale=images[1];f.ctx.setReportSignature("data:image/png;base64,BBBB",true);stale.onerror();
    assert.equal(f.ctx.collectState().signature,"data:image/png;base64,BBBB","an old validation error cannot erase new handwriting");
    let finish;f.ctx.padForTest={whenReady:()=>new Promise(resolve=>{finish=resolve;})};
    f.run('ssPad=padForTest;ssDraftSignature="data:image/png;base64,AAAA"');
    f.$("signScreen").classList={contains:()=>true,remove(){throw new Error("failed image must leave the sign screen open");}};
    const confirmation=f.ctx.closeSignScreen(true);assert.equal(f.ctx.collectState().signature,"data:image/png;base64,BBBB");finish(false);await confirmation;
    assert.equal(f.ctx.collectState().signature,"data:image/png;base64,BBBB");
    f.ctx.setReportSignature(invalid);images[2].onload();assert.equal(await f.ctx.waitForReportSignature(),true);assert.match(f.$("sigState").textContent,/✅/);
  }
  for (const change of [f => { f.$("address").value = "変更後"; }, f => { f.$("mKocon").value = "別案件"; }, f => { f.$("b1_km").value = "123"; }, f => f.ctx.cancelPendingFormUpdates(), f => load(f, [])]) {
    const f = fixture(); f.$("apiKey").value = "test-key"; f.$("address").value = "取得前";
    let finish; f.ctx.googleRoute = () => new Promise(resolve => { finish = resolve; });
    const promise = f.ctx.autoCalc("b1"); change(f); const expected = f.$("b1_km").value;
    finish({ km: 77, h: 2, toll: 500, hasToll: true }); await promise;
    assert.equal(f.$("b1_km").value, expected);
    assert.equal(f.$("b1_auto").disabled, false);
  }
  const f = fixture(); f.$("apiKey").value = "test-key"; f.$("address").value = "取得前";
  f.ctx.googleRoute = async () => ({ km: 77, h: 2, toll: 500, hasToll: true });
  f.ctx.autosave = () => {}; f.ctx.scheduleLivePreview = () => {};
  await f.ctx.autoCalc("b1"); assert.equal(f.$("b1_km").value, "77.0");
  for(const fails of [false,true]){
    const f=fixture();f.$("apiKey").value="test-key";f.$("address").value="旧住所";
    const pending=[];f.ctx.googleRoute=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
    f.ctx.autosave=()=>{};f.ctx.scheduleLivePreview=()=>{};
    const old=f.ctx.autoCalc("b1");f.ctx.invalidateRouteRequests();f.$("address").value="新住所";const latest=f.ctx.autoCalc("b1");
    if(fails)pending[0].reject(new Error("old failure"));else pending[0].resolve({km:99,h:1,toll:10,hasToll:true});await old;
    assert.equal(f.$("b1_auto").disabled,true,"old completion must not unlock the latest request");
    assert.equal(f.$("b1_status").textContent,"取得中…","old success/failure must not replace current progress");
    pending[1].resolve({km:22,h:2,toll:20,hasToll:true});await latest;
    assert.equal(f.$("b1_km").value,"22.0");assert.equal(f.$("b1_auto").disabled,false);
  }
  assert.match(html, /8h超は\+12,150\/h/);
  console.log("Report behavior checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
