const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fixture, deferred } = require("./helpers/export-fixture.cjs");

test("capturePages freezes every page before live form changes and disposes its temporary DOM", () => {
  const f = fixture();
  const first = new f.Element("section"), second = new f.Element("section");
  first.textContent = "最初の顧客・金額"; second.textContent = "続きの作業・サイン";
  first.className = second.className = "sheet";
  f.document.body.append(first, second);
  const initialChildren = f.document.body.children.length;
  const snapshot = f.api.capturePages([first, second]);
  assert.equal(snapshot.pages.length, 2);
  assert.notEqual(snapshot.pages[0], first);
  first.textContent = "編集中の新しい顧客"; second.textContent = "更新された作業";
  assert.equal(snapshot.pages[0].textContent, "最初の顧客・金額");
  assert.equal(snapshot.pages[1].textContent, "続きの作業・サイン");
  snapshot.dispose();
  assert.equal(f.document.body.children.length, initialChildren);
  assert.ok(first.isConnected); assert.ok(second.isConnected);
  f.cleanup();
});

test("JSON-only output does not start PDF generation and downloads once on PC", async () => {
  const f = fixture();
  let calls = 0;
  const state = { documentType: "estimate", fields: { subject: "保存時の件名", amount: "1234" } };
  const exporter = f.api.create({ capture(kind) { calls++; assert.equal(kind, "json"); return { name: "見積テスト", state, pages: [], dispose() {} }; } });
  await exporter.start("json");
  assert.equal(calls, 1); assert.equal(f.captures.length, 0);
  assert.ok(f.text().includes("JSON") || f.text().includes("データ"));
  assert.equal(f.downloads.length, 1, "PC saves the JSON without a second action");
  assert.ok(f.downloads[0].name.endsWith(".json"));
  f.cleanup();
});

test("overlapping clicks cannot run a second capture while PDF is being prepared", async () => {
  const wait = deferred();
  const f = fixture({ render: () => wait.promise });
  let calls = 0, disposed = 0;
  const exporter = f.api.create({ capture() { calls++; return { name: "同時実行", state: { fields: {} }, pages: [new f.Element("section")], dispose() { disposed++; } }; } });
  const first = exporter.start("both");
  await Promise.resolve(); await Promise.resolve();
  const second = exporter.start("both");
  wait.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(f.captures.length, 1);
  assert.equal(disposed, 1, "temporary PDF pages must be cleaned once after generation");
  f.cleanup();
});

for (const kind of ["pdf", "json", "both"]) {
  test(`${kind}: retained files are individually downloadable and keep one snapshot`, async () => {
    const f = fixture();
    const input = { documentType: "report", schemaVersion: 2, fields: { billName: "保存時のお客様", mKocon: "123" }, work: [{ content: "初期作業" }], signature: "data:image/png;base64,AAAA" };
    const first = new f.Element("section"), second = new f.Element("section");
    first.textContent = "保存時のお客様"; second.textContent = "初期作業";
    let calls = 0;
    const exporter = f.api.create({ capture() { calls++; return { name: "123_保存時のお客様", state: input, ...(kind === "json" ? { pages: [], dispose() {} } : f.api.capturePages([first, second])) }; } });
    const pending = exporter.start(kind);
    input.fields.billName = "編集中のお客様"; input.work[0].content = "更新作業";
    first.textContent = "編集中のお客様"; second.textContent = "更新作業";
    await pending;
    assert.equal(calls, 1);
    const links = f.document.querySelectorAll("a");
    assert.equal(links.length, kind === "both" ? 2 : 1);
    assert.equal(f.downloads.length, links.length, "one output action downloads every file on PC");
    assert.deepEqual(f.downloads.map(d => d.name.split(".").pop()), kind === "both" ? ["pdf", "json"] : [kind]);
    for (const download of f.downloads) {
      assert.ok(download.name.startsWith("123_保存時のお客様"));
      const data = JSON.parse(await download.blob.text());
      if (download.name.endsWith(".json")) {
        assert.equal(data.fields.billName, "保存時のお客様");
        assert.equal(data.work[0].content, "初期作業");
        assert.equal(data.signature, "data:image/png;base64,AAAA");
      } else {
        assert.equal(data.pages, 2);
        assert.equal(Buffer.from(data.images[0][0].split(",")[1], "base64").toString(), "保存時のお客様");
        assert.equal(Buffer.from(data.images[1][0].split(",")[1], "base64").toString(), "初期作業");
        assert.deepEqual(data.images.map(image => image.slice(2)), [[5, 5, 287, 287 * 1520 / 2246], [5, 5, 287, 287 * 1520 / 2246]]);
      }
    }
    const urls = Array.from(f.objectURLs.keys());
    await f.button("閉じる").click();
    assert.equal(f.objectURLs.size, 0); assert.equal(f.revoked.length, urls.length);
    assert.equal(f.document.querySelectorAll("dialog").length, 0);
    f.cleanup();
  });
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("phone: one share action saves both files; cancellation retries without another PDF generation", async () => {
  let attempts = 0, shared;
  const f = fixture({ navigator: { userAgent: IPHONE, canShare: () => true, async share(data) { attempts++; shared = data; if (attempts === 1) throw Object.assign(new Error("cancel"), { name: "AbortError" }); } } });
  const exporter = f.api.create({ capture() { return { name: "共有テスト", state: { fields: {} }, pages: [new f.Element("section")], dispose() {} }; } });
  await exporter.start("both");
  assert.equal(f.downloads.length, 0, "phones do not fire download popups");
  assert.match(f.text(), /まとめて保存/);
  const share = f.button("まとめて保存"); assert.ok(share);
  await share.click(); assert.match(f.text(), /キャンセル/);
  assert.equal(share.disabled, false); assert.equal(f.document.querySelectorAll("a").length, 2);
  await share.click(); assert.equal(attempts, 2); assert.equal(f.captures.length, 1);
  assert.deepEqual(Array.from(shared.files, file => file.name), ["共有テスト.pdf", "共有テスト.json"]);
  f.cleanup();
});

test("phone: a still-active output tap opens the share sheet with both files immediately", async () => {
  let shared = null;
  const f = fixture({ navigator: { userAgent: IPHONE, userActivation: { isActive: true }, canShare: () => true, async share(data) { shared = data; } } });
  const exporter = f.api.create({ capture() { return { name: "即共有", state: { fields: {} }, pages: [new f.Element("section")], dispose() {} }; } });
  await exporter.start("both");
  assert.deepEqual(Array.from(shared.files, file => file.name), ["即共有.pdf", "即共有.json"]);
  assert.match(f.document.querySelector("[role=status]").textContent, /両方/);
  f.cleanup();
});

test("phone without mixed-file sharing downloads both files automatically", async () => {
  const f = fixture({ navigator: { userAgent: IPHONE, canShare: ({ files }) => files.length === 1 && files[0].type === "application/pdf", share() {} } });
  const exporter = f.api.create({ capture() { return { name: "非対応端末", state: { fields: {} }, pages: [new f.Element("section")], dispose() {} }; } });
  await exporter.start("both");
  assert.equal(f.button("まとめて保存"), undefined);
  assert.equal(f.buttons().length, 1, "only the close button remains");
  assert.equal(f.downloads.length, 2);
  assert.match(f.text(), /両方をダウンロードしました/);
  f.cleanup();
});

test("PC with Web Share still downloads both files instead of opening a share sheet", async () => {
  let shares = 0;
  const f = fixture({ navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0", userActivation: { isActive: true }, canShare: () => true, async share() { shares++; } } });
  const exporter = f.api.create({ capture() { return { name: "PC", state: { fields: {} }, pages: [new f.Element("section")], dispose() {} }; } });
  await exporter.start("both");
  assert.equal(shares, 0); assert.equal(f.downloads.length, 2);
  assert.deepEqual(f.downloads.map(d => d.name), ["PC.pdf", "PC.json"]);
  f.cleanup();
});

test("PDF generation failure releases temporary pages and closing allows a fresh export", async () => {
  let fail = true, disposed = 0;
  const f = fixture({ render: () => { if (fail) throw new Error("render failed"); } });
  const app = new f.Element("main"); app.className = "app"; f.document.body.appendChild(app);
  const exporter = f.api.create({ capture() { return { name: "再生成", state: { fields: {} }, pages: [new f.Element("section")], dispose() { disposed++; } }; } });
  await exporter.start("both"); assert.match(f.text(), /render failed/); assert.equal(disposed, 1);
  const recovery = f.document.querySelectorAll("a"); assert.equal(recovery.length, 1);
  assert.ok(recovery[0].download.endsWith(".json"));
  assert.doesNotMatch(f.document.querySelector("[role=status]").textContent, /準備ができました/);
  await recovery[0].click(); assert.deepEqual(JSON.parse(await f.downloads[0].blob.text()), { fields: {} });
  assert.equal(f.document.querySelector("h2").textContent, "PDF作成に失敗しました", "PDF failure stays visible after saving recovered JSON");
  await f.button("閉じる").click(); assert.equal(app.inert, false);
  fail = false; await exporter.start("both"); assert.equal(disposed, 2); assert.equal(f.document.querySelectorAll("a").length, 2);
  f.cleanup();
});

test("cancelling generation waits for the pending capture and leaves no downloads or locked form", async () => {
  const wait = deferred(), started = deferred(); let disposed = 0;
  const f = fixture({ render: () => { started.resolve(); return wait.promise; } });
  const app = new f.Element("main"); app.className = "app"; f.document.body.appendChild(app);
  const exporter = f.api.create({ capture() { return { name: "中止", state: { fields: {} }, pages: [new f.Element("section")], dispose() { disposed++; } }; } });
  const pending = exporter.start("both");
  await started.promise;
  await f.button("中止").click(); assert.match(f.text(), /中止処理中/);
  wait.resolve(); await pending;
  assert.equal(disposed, 1); assert.equal(app.inert, false);
  assert.equal(f.document.querySelectorAll("dialog").length, 0); assert.equal(f.downloads.length, 0); assert.equal(f.objectURLs.size, 0);
  f.cleanup();
});

test("a failed or stalled signature preparation does not export incomplete data", async () => {
  for (const beforeCapture of [() => Promise.reject(new Error("invalid signature")), () => new Promise(() => {})]) {
    const f = fixture(); let captures = 0;
    const exporter = f.api.create({ beforeCapture, capture() { captures++; } });
    await exporter.start("both");
    assert.equal(captures, 0); assert.equal(f.document.querySelectorAll("a").length, 0);
    assert.match(f.text(), /invalid signature|時間切れ/);
    await f.button("閉じる").click(); f.cleanup();
  }
});

test("snapshot iframe isolates IDs from live selectors and removes itself after cloning errors", () => {
  const f = fixture();
  const sheet = new f.Element("section"); sheet.id = "sheet"; sheet.className = "sheet";
  const cell = new f.Element("span"); cell.id = "amount"; cell.textContent = "1234"; cell.setAttribute("contenteditable", "true"); sheet.appendChild(cell);
  f.document.body.appendChild(sheet);
  const snapshot = f.api.capturePages([sheet]);
  assert.equal(snapshot.pages[0].id, "sheet");
  assert.equal(snapshot.pages[0].querySelector("#amount").textContent, "1234");
  assert.equal(snapshot.pages[0].querySelector("#amount").getAttribute("contenteditable"), "false");
  assert.equal(f.document.querySelectorAll("#sheet").length, 1, "isolated PDF sheet IDs must not pollute normal render/autosave selectors");
  assert.equal(snapshot.pages[0].style.transform, "none"); assert.equal(snapshot.pages[0].style.zoom, "1");
  snapshot.dispose();
  const broken = new f.Element("section"); broken.cloneNode = () => { throw new Error("clone failure"); };
  assert.throws(() => f.api.capturePages([broken]), /clone failure/);
  assert.equal(f.document.querySelectorAll("iframe").length, 0);
  f.cleanup();
});

test("invalid PDF image fails explicitly without delivering a PDF that silently omits it", async () => {
  const f = fixture();
  const sheet = new f.Element("section"), image = new f.Element("img"); image.complete = true; image.naturalWidth = 0; sheet.appendChild(image);
  let disposed = 0;
  const exporter = f.api.create({ capture() { return { name: "画像不良", state: { fields: {} }, pages: [sheet], dispose() { disposed++; } }; } });
  await exporter.start("both");
  assert.match(f.text(), /画像を読み込めません/); assert.equal(f.captures.length, 0); assert.equal(disposed, 1);
  assert.equal(f.document.querySelectorAll("a").length, 1);
  assert.ok(f.document.querySelector("a").download.endsWith(".json"));
  f.cleanup();
});

test("a stalled PDF renderer times out, disposes its isolated pages, and unlocks on close", async () => {
  const f = fixture({ render: () => new Promise(() => {}) });
  const app = new f.Element("main"); app.className = "app"; f.document.body.appendChild(app);
  let disposed = 0;
  const exporter = f.api.create({ capture() { return { name: "時間切れ", state: { fields: {} }, pages: [new f.Element("section")], dispose() { disposed++; } }; } });
  await exporter.start("both");
  assert.match(f.text(), /PDF作成が時間切れ/); assert.equal(disposed, 1);
  assert.equal(f.downloads.length, 0); assert.equal(f.objectURLs.size, 1);
  assert.ok(f.document.querySelector("a").download.endsWith(".json"));
  await f.button("閉じる").click(); assert.equal(app.inert, false); assert.equal(f.objectURLs.size, 0);
  f.cleanup();
});


test("PDF snapshot preserves standards doctype and report continuation CSS ancestry", () => {
  const f = fixture();
  const main = new f.Element("section"), continuation = new f.Element("section");
  main.id = "sheet"; main.className = "sheet rp";
  continuation.className = "sheet rp cont";
  const snapshot = f.api.capturePages([main, continuation]);
  const frame = f.document.querySelector("iframe");
  assert.match(frame.contentDocument.html, /^<!doctype html>/i);
  assert.match(frame.contentDocument.html, /<html lang="ja">/);
  assert.equal(snapshot.pages[0].parentNode, frame.contentDocument.body);
  assert.equal(snapshot.pages[1].parentNode.id, "sheetExtra");
  assert.equal(frame.contentDocument.body.children[0], snapshot.pages[0]);
  assert.equal(snapshot.pages[1].classList.contains("cont"), true);
  snapshot.dispose(); assert.equal(f.document.querySelector("iframe"), null);
  f.cleanup();
});

test("each file stays with its filename and closing during sharing is blocked", async () => {
  const wait = deferred();
  const f = fixture({ navigator: { userAgent: IPHONE, canShare: () => true, share: () => wait.promise } });
  const exporter = f.api.create({ capture: () => ({ name: "同じ書類", state: {}, pages: [new f.Element("section")] }) });
  await exporter.start("both");
  const groups = f.document.querySelectorAll(".export-file");
  assert.equal(groups.length, 2);
  groups.forEach((group, i) => {
    const link = group.querySelector("a");
    assert.equal(link.download, "同じ書類" + (i ? ".json" : ".pdf"));
    assert.equal(group.querySelector(".export-filename").textContent, link.download);
    assert.match(link.textContent, /ダウンロード/);
  });
  const pending = f.button("まとめて保存").click();
  await f.document.querySelector("dialog").emit("cancel");
  assert.doesNotMatch(f.document.querySelector("[role=status]").textContent, /中止/);
  assert.equal(f.document.querySelectorAll("dialog").length, 1);
  wait.reject(Object.assign(new Error("cancel"), { name: "AbortError" }));
  await pending;
  assert.match(f.document.querySelector("[role=status]").textContent, /再試行/);
  await f.button("閉じる").click();
  assert.equal(f.document.querySelectorAll("dialog").length, 0);
  f.cleanup();
});

test("device detection treats phones and iPads as mobile and desktops as PC", () => {
  const f = fixture();
  const check = navigator => { f.global.navigator = navigator; return f.api.isMobile(); };
  assert.equal(check({ userAgent: IPHONE }), true);
  assert.equal(check({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0 Mobile Safari/537.36" }), true);
  assert.equal(check({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", maxTouchPoints: 5 }), true);
  assert.equal(check({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", maxTouchPoints: 0 }), false);
  assert.equal(check({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0" }), false);
  f.cleanup();
});
