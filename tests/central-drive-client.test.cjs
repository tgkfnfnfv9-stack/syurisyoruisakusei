const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const records = [];
const clone = value => JSON.parse(JSON.stringify(value));
const normalize = value => String(value == null ? "" : value).trim();

function findRecord(docType, kocon, subject) {
  const normalizedKocon = normalize(kocon);
  const normalizedSubject = normalize(subject);
  const sameType = records.filter(record => record.docType === docType);
  if (normalizedKocon) return sameType.find(record => record.kocon === normalizedKocon) || null;
  return (normalizedSubject && sameType.find(record => record.subject === normalizedSubject)) || null;
}

const window = {
  addEventListener() {},
  confirm: () => true,
  KKMT_CENTRAL_DRIVE_CONFIG: {
    url: "https://central.example/exec",
    pin: "ad5d1bc7"
  }
};
window.window = window;
window.setTimeout = setTimeout;
window.clearTimeout = clearTimeout;

const head = {
  appendChild(script) {
    script.parentNode = head;
    const url = new URL(script.src);
    const callback = url.searchParams.get("callback");
    const pin = url.searchParams.get("pin");
    let response;
    if (pin !== "ad5d1bc7") {
      response = { ok: false, error: "共通PINが正しくありません。" };
    } else if (url.searchParams.get("action") === "ping") {
      response = { ok: true, result: { connected: true } };
    } else if (url.searchParams.get("action") === "load") {
      const record = findRecord(
        url.searchParams.get("docType"),
        url.searchParams.get("kocon"),
        url.searchParams.get("subject")
      );
      response = { ok: true, result: record ? clone(record.data) : null };
    } else {
      response = { ok: false, error: "不明な操作です。" };
    }
    setTimeout(() => window[callback](response), 0);
  },
  removeChild(script) {
    script.parentNode = null;
  }
};
window.document = {
  head,
  documentElement: head,
  createElement() {
    return { parentNode: null, async: false, src: "", onerror: null };
  }
};

async function centralFetch(url, options = {}) {
  assert.equal(url, "https://central.example/exec");
  assert.equal(options.method, "POST");
  assert.equal(options.mode, "no-cors");
  assert.equal(options.credentials, "include");
  const request = JSON.parse(options.body);
  assert.equal(request.pin, "ad5d1bc7");
  assert.equal(request.action, "save");

  const kocon = normalize(request.kocon);
  const subject = normalize(request.subject);
  let existing = kocon ? findRecord(request.docType, kocon, "") : findRecord(request.docType, "", subject);
  if (!existing && subject) {
    const bySubject = findRecord(request.docType, "", subject);
    if (!kocon || (bySubject && !bySubject.kocon)) existing = bySubject;
  }
  if (!existing && request.previousSubject) {
    const byPreviousSubject = findRecord(request.docType, "", request.previousSubject);
    if (!kocon || (byPreviousSubject && !byPreviousSubject.kocon)) existing = byPreviousSubject;
  }
  if (!existing) {
    existing = { docType: request.docType, kocon, subject, data: null };
    records.push(existing);
  }
  existing.kocon = kocon;
  existing.subject = subject;
  existing.data = Object.assign(clone(request.data), { _kkmtDocumentType: request.docType });
  return { type: "opaque" };
}

const context = {
  window,
  localStorage: {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem() {},
    removeItem() {}
  },
  fetch: centralFetch,
  Headers,
  URLSearchParams,
  URL,
  console,
  setTimeout,
  clearTimeout,
  Intl,
  Date,
  Math,
  encodeURIComponent,
  decodeURIComponent
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "google-drive.js"), "utf8"),
  context,
  { filename: "google-drive-central.js" }
);

(async () => {
  const drive = window.KKMTDrive;
  await drive.prepare();
  assert.equal(drive.isConnected(), true);
  await drive.connect();

  await drive.saveJson({
    subject: "高コン未定案件",
    docType: "estimate",
    data: { fields: { subject: "高コン未定案件" }, version: 1 }
  });
  assert.equal(records.length, 1);
  assert.deepEqual(
    clone(await drive.loadJson({ subject: "高コン未定案件", docType: "estimate" })),
    { fields: { subject: "高コン未定案件" }, version: 1 }
  );

  await drive.saveJson({
    kocon: "888",
    subject: "高コン未定案件",
    docType: "estimate",
    data: { fields: { mKocon: "888", subject: "高コン未定案件" }, version: 2 }
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].kocon, "888");
  assert.deepEqual(
    clone(await drive.loadJson({ kocon: "888", docType: "estimate" })),
    { fields: { mKocon: "888", subject: "高コン未定案件" }, version: 2 }
  );

  await drive.saveJson({
    kocon: "888",
    subject: "作業報告案件",
    docType: "report",
    data: { fields: { mKocon: "888", subject: "作業報告案件" }, work: [] }
  });
  assert.equal(records.length, 2);
  assert.deepEqual(
    clone(await drive.loadJson({ subject: "作業報告案件", docType: "report" })),
    { fields: { mKocon: "888", subject: "作業報告案件" }, work: [] }
  );
  assert.equal(window.google, undefined, "central mode must not require Google OAuth library");

  await drive.saveJson({ kocon: "same-a", subject: "同一件名", docType: "estimate", data: { wdays: [], version: 71 } });
  await drive.saveJson({ kocon: "same-b", subject: "同一件名", docType: "estimate", data: { wdays: [], version: 72 } });
  assert.equal(records.filter(record => record.docType === "estimate" && record.subject === "同一件名").length, 2);
  assert.deepEqual(clone(await drive.loadJson({ kocon: "same-a", docType: "estimate" })), { wdays: [], version: 71 });
  assert.deepEqual(clone(await drive.loadJson({ kocon: "same-b", docType: "estimate" })), { wdays: [], version: 72 });

  console.log("Central Drive client checks passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
