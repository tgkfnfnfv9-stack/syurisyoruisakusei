const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let sequence = 0;
class Iterator {
  constructor(items) { this.items = items; this.index = 0; }
  hasNext() { return this.index < this.items.length; }
  next() { return this.items[this.index++]; }
}
class File {
  constructor(name, content) {
    this.id = `file-${++sequence}`;
    this.name = name;
    this.content = content;
    this.updated = new Date(sequence * 1000);
  }
  getId() { return this.id; }
  getName() { return this.name; }
  setName(name) { this.name = name; return this; }
  setContent(content) { this.content = content; this.updated = new Date(++sequence * 1000); return this; }
  getLastUpdated() { return this.updated; }
  getBlob() { return { getDataAsString: () => this.content }; }
}
class Folder {
  constructor(name) { this.name = name; this.folders = []; this.files = []; }
  getFoldersByName(name) { return new Iterator(this.folders.filter(folder => folder.name === name)); }
  createFolder(name) { const folder = new Folder(name); this.folders.push(folder); return folder; }
  getFiles() { return new Iterator(this.files); }
  createFile(name, content) { const file = new File(name, content); this.files.push(file); return file; }
}
const root = new Folder("root");
const output = value => ({
  value: String(value),
  setMimeType() { return this; },
  getContent() { return this.value; }
});
const context = {
  DriveApp: { getRootFolder: () => root },
  LockService: {
    getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
  },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: output
  },
  MimeType: { PLAIN_TEXT: "text/plain" },
  Object,
  Array,
  String,
  JSON,
  Date,
  Error,
  console
};

const source = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
vm.runInNewContext(source, context, { filename: "Code.gs" });

function request(body) {
  const response = context.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(response.getContent());
}

const pin = "ad5d1bc7";
assert.deepEqual(request({ action: "ping", pin }), { ok: true, result: { connected: true } });
assert.equal(request({ action: "ping", pin: "wrong" }).ok, false);

let result = request({
  action: "save",
  pin,
  docType: "estimate",
  subject: "クラッチ交換",
  data: { fields: { subject: "クラッチ交換", mKocon: "" }, version: 1 }
});
assert.equal(result.ok, true);
const rootFolder = root.folders.find(folder => folder.name === "小林機械 書類データ");
const estimateFolder = rootFolder.folders.find(folder => folder.name === "見積もり");
assert.equal(estimateFolder.files[0].name, "クラッチ交換_見積もり.json");
const estimateId = estimateFolder.files[0].id;

result = request({
  action: "save",
  pin,
  docType: "estimate",
  kocon: "12345",
  subject: "クラッチ交換",
  data: { fields: { subject: "クラッチ交換", mKocon: "12345" }, version: 2 }
});
assert.equal(result.ok, true);
assert.equal(estimateFolder.files.length, 1);
assert.equal(estimateFolder.files[0].id, estimateId);
assert.equal(estimateFolder.files[0].name, "高コン12345_クラッチ交換_見積もり.json");

result = request({ action: "load", pin, docType: "estimate", kocon: "12345" });
assert.equal(result.result.version, 2);
result = request({ action: "load", pin, docType: "estimate", subject: "クラッチ交換" });
assert.equal(result.result.version, 2);

result = request({
  action: "save",
  pin,
  docType: "report",
  kocon: "12345",
  subject: "クラッチ交換",
  data: { fields: { subject: "クラッチ交換", mKocon: "12345" }, work: [] }
});
assert.equal(result.ok, true);
const reportFolder = rootFolder.folders.find(folder => folder.name === "報告書");
assert.equal(reportFolder.files[0].name, "高コン12345_報告書.json");
assert.equal(request({ action: "load", pin, docType: "report", subject: "クラッチ交換" }).result.work.length, 0);
assert.equal(request({ action: "save", pin, docType: "report", subject: "高コンなし", data: {} }).ok, false);

console.log("Apps Script backend checks passed.");
