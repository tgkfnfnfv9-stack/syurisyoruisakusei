const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const storage = new Map();
const session = new Map();
const localStorage = {
  get length() { return storage.size; },
  key: index => [...storage.keys()][index] ?? null,
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key)
};
const sessionStorage = {
  getItem: key => session.has(key) ? session.get(key) : null,
  setItem: (key, value) => session.set(key, String(value)),
  removeItem: key => session.delete(key)
};

const window = { addEventListener() {}, confirm: () => true, sessionStorage };
window.window = window;
window.KKMT_CENTRAL_DRIVE_CONFIG = { url: "" };
window.google = {
  accounts: {
    oauth2: {
      initTokenClient: options => ({
        requestAccessToken: () => options.callback({ access_token: "test-access-token", expires_in: 3600 })
      })
    }
  }
};

const context = {
  window,
  localStorage,
  fetch: async () => { throw new Error("Direct Drive API writes must not run"); },
  Headers,
  URLSearchParams,
  Blob,
  Response,
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

vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "google-drive.js"), "utf8"), context, {
  filename: "google-drive.js"
});

(async () => {
  const drive = window.KKMTDrive;
  await drive.prepare();
  await drive.connect();
  assert.equal(drive.isConnected(), true);
  await assert.rejects(
    () => drive.saveJson({
      kocon: "12345",
      subject: "安全確認",
      docType: "estimate",
      expectedRevision: 0,
      data: { documentType: "estimate", fields: { mKocon: "12345", subject: "安全確認" }, wdays: [] }
    }),
    /共通Driveバックエンド経由/
  );
  assert.ok(![...storage.values()].some(value => value.includes("test-access-token")));
  assert.ok([...session.values()].some(value => value.includes("test-access-token")));
  console.log("Direct OAuth write safety check passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

