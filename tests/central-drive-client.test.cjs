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
  if (!normalizedSubject) return null;
  const matches = sameType.filter(record => record.subject === normalizedSubject);
  return matches.find(record => !record.kocon) || matches[0] || null;
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
  let existing = kocon ? findRecord(request.docType, kocon, "") : null;
  if (!existing && subject) {
    const bySubject = findRecord(request.docType, "", subject);
    if (bySubject && !bySubject.kocon) existing = bySubject;
  }
  if (!existing && request.previousSubject) {
    const byPreviousSubject = findRecord(request.docType, "", request.previousSubject);
    if (byPreviousSubject && !byPreviousSubject.kocon) existing = byPreviousSubject;
  }
  const existingRevision = Number(existing && existing.data && existing.data._kkmtRevision) || 0;
  const hasExpectedRevision = request.expectedRevision != null ||
    !!(request.data && Object.prototype.hasOwnProperty.call(request.data, "_kkmtRevision"));
  if (!hasExpectedRevision && existingRevision > 0) return { type: "opaque" };
  const expectedRevision = hasExpectedRevision
    ? (request.expectedRevision == null ? Number(request.data._kkmtRevision) || 0 : request.expectedRevision)
    : 0;
  if ((existing && expectedRevision !== existingRevision) || (!existing && expectedRevision !== 0)) {
    return { type: "opaque" };
  }
  if (!existing) {
    existing = { docType: request.docType, kocon, subject, data: null };
    records.push(existing);
  }
  existing.kocon = kocon;
  existing.subject = subject;
  existing.data = Object.assign(clone(request.data), {
    _kkmtDocumentType: request.docType,
    _kkmtRevision: existingRevision + 1,
    _kkmtUpdatedAt: new Date().toISOString()
  });
  return { type: "opaque" };
}

const localValues = new Map();
const localStorage = {
  get length() { return localValues.size; },
  key: index => [...localValues.keys()][index] ?? null,
  getItem: key => localValues.has(key) ? localValues.get(key) : null,
  setItem: (key, value) => localValues.set(key, String(value)),
  removeItem: key => localValues.delete(key)
};
const context = {
  window,
  localStorage,
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
  const loadData = async query => {
    const data = clone(await drive.loadJson(query));
    if (data) {
      delete data._kkmtRevision;
      delete data._kkmtUpdatedAt;
    }
    return data;
  };
  await drive.prepare();
  assert.equal(drive.isConnected(), true);
  await drive.connect();

  let estimateSave = await drive.saveJson({
    subject: "高コン未定案件",
    docType: "estimate",
    data: { fields: { subject: "高コン未定案件" }, version: 1 }
  });
  assert.equal(records.length, 1);
  assert.deepEqual(
    await loadData({ subject: "高コン未定案件", docType: "estimate" }),
    { fields: { subject: "高コン未定案件" }, version: 1 }
  );

  estimateSave = await drive.saveJson({
    kocon: "888",
    subject: "高コン未定案件",
    docType: "estimate",
    expectedRevision: estimateSave.revision,
    data: { fields: { mKocon: "888", subject: "高コン未定案件" }, version: 2, _kkmtRevision: estimateSave.revision }
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].kocon, "888");
  assert.deepEqual(
    await loadData({ kocon: "888", docType: "estimate" }),
    { fields: { mKocon: "888", subject: "高コン未定案件" }, version: 2 }
  );
  await assert.rejects(
    () => drive.saveJson({
      kocon: "888", subject: "高コン未定案件", docType: "estimate",
      data: { fields: { mKocon: "888", subject: "高コン未定案件" }, version: 999 }
    }),
    /他の端末で更新/
  );
  await assert.rejects(
    () => drive.saveJson({
      kocon: "888", subject: "高コン未定案件", docType: "estimate",
      expectedRevision: estimateSave.revision,
      data: { _kkmtRevision: estimateSave.revision }
    }),
    /必須項目/
  );

  await drive.saveJson({
    kocon: "888",
    subject: "作業報告案件",
    docType: "report",
    data: { fields: { mKocon: "888", subject: "作業報告案件" }, work: [] }
  });
  assert.equal(records.length, 2);
  assert.deepEqual(
    await loadData({ subject: "作業報告案件", docType: "report" }),
    { fields: { mKocon: "888", subject: "作業報告案件" }, work: [] }
  );
  assert.equal(window.google, undefined, "central mode must not require Google OAuth library");

  await drive.saveJson({ kocon: "same-a", subject: "同一件名", docType: "estimate", data: { fields: { mKocon: "same-a", subject: "同一件名" }, wdays: [], version: 71 } });
  await drive.saveJson({ kocon: "same-b", subject: "同一件名", docType: "estimate", data: { fields: { mKocon: "same-b", subject: "同一件名" }, wdays: [], version: 72 } });
  assert.equal(records.filter(record => record.docType === "estimate" && record.subject === "同一件名").length, 2);
  assert.deepEqual(await loadData({ kocon: "same-a", docType: "estimate" }), { fields: { mKocon: "same-a", subject: "同一件名" }, wdays: [], version: 71 });
  assert.deepEqual(await loadData({ kocon: "same-b", docType: "estimate" }), { fields: { mKocon: "same-b", subject: "同一件名" }, wdays: [], version: 72 });
  await drive.saveJson({ subject: "同一件名", docType: "estimate", data: { fields: { mKocon: "", subject: "同一件名" }, wdays: [], version: 73 } });
  assert.equal(records.filter(record => record.docType === "estimate" && record.subject === "同一件名").length, 3);
  assert.deepEqual(await loadData({ kocon: "same-b", docType: "estimate" }), { fields: { mKocon: "same-b", subject: "同一件名" }, wdays: [], version: 72 });

  const base = await drive.loadJson({ kocon: "same-a", docType: "estimate" });
  await drive.saveJson({
    kocon: "same-a", subject: "同一件名", docType: "estimate",
    expectedRevision: base._kkmtRevision,
    data: { fields: { mKocon: "same-a", subject: "同一件名" }, wdays: [], version: 74, _kkmtRevision: base._kkmtRevision }
  });
  await assert.rejects(
    () => drive.saveJson({
      kocon: "same-a", subject: "同一件名", docType: "estimate",
      expectedRevision: base._kkmtRevision,
      data: { fields: { mKocon: "same-a", subject: "同一件名" }, wdays: [], version: 999, _kkmtRevision: base._kkmtRevision }
    }),
    /他の端末で更新/
  );
  assert.deepEqual(await loadData({ kocon: "same-a", docType: "estimate" }), { fields: { mKocon: "same-a", subject: "同一件名" }, wdays: [], version: 74 });

  const promotionSubject = "画面昇格テスト";
  await drive.saveJson({
    subject: promotionSubject,
    docType: "estimate",
    data: { documentType: "estimate", fields: { mKocon: "", subject: promotionSubject }, wdays: [] }
  });
  let promotionState = await drive.loadJson({ subject: promotionSubject, docType: "estimate" });
  const koconInput = { value: "", disabled: false };
  const subjectInput = { value: promotionSubject };
  const statusElement = { textContent: "", classList: { toggle() {} } };
  const controller = drive.createAutosaveController({
    docType: "estimate",
    rootElement: { addEventListener() {} },
    koconInput,
    fallbackInput: subjectInput,
    statusElement,
    connectButton: { textContent: "", disabled: false },
    collectState: () => clone(promotionState),
    onKoconConfirmed: async ({ kocon }) => {
      const loaded = await drive.loadJson({ kocon, docType: "estimate" });
      if (!loaded) return { confirmed: true, revision: promotionState._kkmtRevision, loaded: false };
      promotionState = loaded;
      return { confirmed: true, revision: loaded._kkmtRevision, loaded: true };
    },
    onSavedRevision: revision => { promotionState._kkmtRevision = revision; }
  });
  koconInput.value = "777";
  promotionState.fields.mKocon = "777";
  assert.equal(await controller.confirmCurrentKocon({ save: true }), true);
  const promotedByController = await drive.loadJson({ kocon: "777", docType: "estimate" });
  assert.equal(promotedByController._kkmtRevision, 2);
  assert.equal(promotedByController.fields.subject, promotionSubject);

  const makeInput = value => ({ value, disabled: false, type: "text", addEventListener() {} });
  const makeStatus = () => ({ textContent: "", classList: { toggle() {} } });
  const makeButton = () => ({ textContent: "", disabled: false, addEventListener() {} });
  const waitForAsyncInit = () => new Promise(resolve => setTimeout(resolve, 60));

  const pendingKocon = "pending-ok";
  let pendingRemote = await drive.saveJson({
    kocon: pendingKocon, subject: "未同期成功", docType: "estimate",
    data: { fields: { mKocon: pendingKocon, subject: "未同期成功" }, wdays: [], version: 1 }
  });
  let pendingState = {
    documentType: "estimate", _kkmtRevision: pendingRemote.revision,
    fields: { mKocon: pendingKocon, subject: "未同期成功" }, wdays: [], version: 2
  };
  const pendingKey = "kkmt_drive_pending_estimate_k_" + pendingKocon;
  localStorage.setItem(pendingKey, JSON.stringify({
    docType: "estimate", kocon: pendingKocon, subject: "未同期成功",
    expectedRevision: pendingRemote.revision, json: JSON.stringify(pendingState)
  }));
  const pendingController = drive.createAutosaveController({
    docType: "estimate",
    rootElement: { addEventListener() {} },
    koconInput: makeInput(pendingKocon),
    fallbackInput: makeInput("未同期成功"),
    statusElement: makeStatus(),
    connectButton: makeButton(),
    collectState: () => clone(pendingState),
    onKoconConfirmed: async () => ({ confirmed: true, revision: pendingState._kkmtRevision, loaded: true }),
    onSavedRevision: revision => { pendingState._kkmtRevision = revision; },
    skipInitialLoad: true
  });
  pendingController.init();
  await waitForAsyncInit();
  assert.equal(pendingState._kkmtRevision, pendingRemote.revision + 1);
  assert.equal(localStorage.getItem(pendingKey), null);

  const conflictKocon = "pending-conflict";
  const conflictV1 = await drive.saveJson({
    kocon: conflictKocon, subject: "未同期競合", docType: "estimate",
    data: { fields: { mKocon: conflictKocon, subject: "未同期競合" }, wdays: [], version: 1 }
  });
  await drive.saveJson({
    kocon: conflictKocon, subject: "未同期競合", docType: "estimate",
    expectedRevision: conflictV1.revision,
    data: { fields: { mKocon: conflictKocon, subject: "未同期競合" }, wdays: [], version: 2, _kkmtRevision: conflictV1.revision }
  });
  const conflictState = {
    documentType: "estimate", _kkmtRevision: conflictV1.revision,
    fields: { mKocon: conflictKocon, subject: "未同期競合" }, wdays: [], version: 99
  };
  const conflictKey = "kkmt_drive_pending_estimate_k_" + conflictKocon;
  localStorage.setItem(conflictKey, JSON.stringify({
    docType: "estimate", kocon: conflictKocon, subject: "未同期競合",
    expectedRevision: conflictV1.revision, json: JSON.stringify(conflictState)
  }));
  let conflictLoadCalled = false;
  const conflictStatus = makeStatus();
  const conflictController = drive.createAutosaveController({
    docType: "estimate",
    rootElement: { addEventListener() {} },
    koconInput: makeInput(conflictKocon),
    fallbackInput: makeInput("未同期競合"),
    statusElement: conflictStatus,
    connectButton: makeButton(),
    collectState: () => clone(conflictState),
    onKoconConfirmed: async () => { conflictLoadCalled = true; return true; }
  });
  conflictController.init();
  await waitForAsyncInit();
  assert.equal(conflictLoadCalled, false);
  assert.notEqual(localStorage.getItem(conflictKey), null);
  assert.match(conflictStatus.textContent, /競合/);

  console.log("Central Drive client checks passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
