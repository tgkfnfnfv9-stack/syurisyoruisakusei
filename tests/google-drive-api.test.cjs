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

const files = new Map();
let sequence = 0;
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json" }
});

async function driveFetch(url, options = {}) {
  const parsed = new URL(url);
  const method = options.method || "GET";

  if (parsed.pathname === "/drive/v3/files" && method === "GET") {
    const query = parsed.searchParams.get("q") || "";
    const matches = [];
    for (const file of files.values()) {
      if (file.trashed) continue;
      if (query.includes("application/vnd.google-apps.folder")) {
        const name = (query.match(/name = '([^']+)'/) || [])[1];
        const parent = (query.match(/'([^']+)' in parents/) || [])[1];
        if (file.mimeType.includes("folder") && file.name === name && file.parents.includes(parent)) matches.push(file);
      } else if (query.includes("appProperties has")) {
        const values = [...query.matchAll(/value='([^']+)'/g)].map(match => match[1]);
        const parent = (query.match(/'([^']+)' in parents/) || [])[1];
        if (file.parents.includes(parent) &&
            file.appProperties?.kocon === values[0] &&
            file.appProperties?.docType === values[1]) {
          matches.push(file);
        }
      }
    }
    return jsonResponse({ files: matches });
  }

  const metadataMatch = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
  if (metadataMatch && method === "GET" && parsed.searchParams.get("alt") === "media") {
    const file = files.get(metadataMatch[1]);
    return file ? jsonResponse(file.data) : jsonResponse({ error: { message: "not found" } }, 404);
  }
  if (metadataMatch && method === "GET") {
    const file = files.get(metadataMatch[1]);
    return file ? jsonResponse(file) : jsonResponse({ error: { message: "not found" } }, 404);
  }
  if (metadataMatch && method === "PATCH") {
    const file = files.get(metadataMatch[1]);
    if (!file) return jsonResponse({ error: { message: "not found" } }, 404);
    Object.assign(file, JSON.parse(options.body));
    return jsonResponse(file);
  }

  if (parsed.pathname === "/drive/v3/files" && method === "POST") {
    const metadata = JSON.parse(options.body);
    const file = {
      id: `file-${++sequence}`,
      name: metadata.name,
      mimeType: metadata.mimeType,
      parents: metadata.parents,
      trashed: false
    };
    files.set(file.id, file);
    return jsonResponse(file);
  }

  if (parsed.pathname === "/upload/drive/v3/files" && method === "POST") {
    const multipart = await options.body.text();
    const parts = multipart.split(/\r\n--[^\r]+/);
    const metadata = JSON.parse(parts[0].split("\r\n\r\n")[1]);
    const data = JSON.parse(parts[1].split("\r\n\r\n")[1]);
    const file = { id: `file-${++sequence}`, ...metadata, trashed: false, data };
    files.set(file.id, file);
    return jsonResponse(file);
  }

  const uploadMatch = parsed.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
  if (uploadMatch && method === "PATCH") {
    const file = files.get(uploadMatch[1]);
    if (!file) return jsonResponse({ error: { message: "not found" } }, 404);
    file.data = JSON.parse(options.body);
    return jsonResponse(file);
  }

  throw new Error(`Unhandled request: ${method} ${url}`);
}

const window = { addEventListener() {}, confirm: () => true };
window.window = window;
window.google = {
  accounts: {
    oauth2: {
      initTokenClient: options => ({
        requestAccessToken: () => options.callback({ access_token: "test-access-token", expires_in: 3600 })
      })
    }
  }
};
window.sessionStorage = sessionStorage;

const context = {
  window,
  localStorage,
  fetch: driveFetch,
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

  await drive.saveJson({ kocon: "12345", docType: "estimate", data: { version: 1 } });
  await drive.saveJson({ kocon: "12345", docType: "estimate", data: { version: 2 } });
  await drive.saveJson({ kocon: "12345", docType: "report", data: { version: 10 } });

  assert.deepEqual(await drive.loadJson({ kocon: "12345", docType: "estimate" }), { version: 2 });
  assert.deepEqual(await drive.loadJson({ kocon: "12345", docType: "report" }), { version: 10 });

  const documents = [...files.values()].filter(file => file.appProperties);
  assert.equal(documents.length, 2);
  assert.equal(documents.find(file => file.appProperties.docType === "estimate").name, "高コン12345_見積もり.json");
  assert.equal(documents.find(file => file.appProperties.docType === "report").name, "高コン12345_報告書.json");
  assert.equal(documents.find(file => file.appProperties.docType === "estimate").data._kkmtDocumentType, "estimate");
  assert.equal(documents.find(file => file.appProperties.docType === "report").data._kkmtDocumentType, "report");
  assert.equal([...files.values()].some(file => file.mimeType.includes("folder") && file.name === "見積もり"), true);
  assert.equal([...files.values()].some(file => file.mimeType.includes("folder") && file.name === "報告書"), true);
  await assert.rejects(
    () => drive.saveJson({ kocon: "12345", docType: "other", data: {} }),
    /不明な書類種別/
  );
  await drive.saveJson({ kocon: "wrong-type", docType: "report", data: { work: [] } });
  const wrongTypeFile = documents.find(file => file.appProperties.kocon === "wrong-type") ||
    [...files.values()].find(file => file.appProperties?.kocon === "wrong-type");
  wrongTypeFile.data = { wdays: [] };
  await assert.rejects(
    () => drive.loadJson({ kocon: "wrong-type", docType: "report" }),
    /別の種類の書類データ/
  );
  assert.ok(![...storage.values()].some(value => value.includes("test-access-token")));
  assert.ok([...session.values()].some(value => value.includes("test-access-token")));

  localStorage.setItem("kkmt_drive_pending_estimate_200", JSON.stringify({
    docType: "estimate",
    kocon: "200",
    json: JSON.stringify({ version: 20 }),
    updatedAt: "2026-07-30T00:00:00.000Z"
  }));
  localStorage.setItem("kkmt_drive_pending_report_300", JSON.stringify({
    docType: "report",
    kocon: "300",
    json: JSON.stringify({ version: 30 }),
    updatedAt: "2026-07-30T00:00:01.000Z"
  }));
  const estimateFlush = await drive.flushPending("estimate");
  assert.equal(estimateFlush.length, 1);
  assert.equal(localStorage.getItem("kkmt_drive_pending_estimate_200"), null);
  assert.notEqual(localStorage.getItem("kkmt_drive_pending_report_300"), null);
  assert.deepEqual(await drive.loadJson({ kocon: "200", docType: "estimate" }), { version: 20 });

  const restoredWindow = { addEventListener() {}, confirm: () => true, sessionStorage };
  restoredWindow.window = restoredWindow;
  restoredWindow.google = window.google;
  const restoredContext = {
    ...context,
    window: restoredWindow
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "google-drive.js"), "utf8"), restoredContext, {
    filename: "google-drive-restored.js"
  });
  await restoredWindow.KKMTDrive.prepare();
  assert.equal(restoredWindow.KKMTDrive.isConnected(), true);

  console.log("Google Drive API mock checks passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
