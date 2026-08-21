(function (global) {
  "use strict";

  const CENTRAL_OVERRIDE = global.KKMT_CENTRAL_DRIVE_CONFIG || {};
  const CONFIG = Object.freeze({
    clientId: "568409413492-30m6042kemj3vrt2hog6joh2g2p7lcei.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.file",
    centralBackendUrl: CENTRAL_OVERRIDE.url === undefined
      ? "https://script.google.com/macros/s/AKfycbxTk0OBNZxgn5u1rYDUYnNQwG27sZ2oL_VyhcIVEChKAb3z9nvErLejaH_94N-5iYq3/exec"
      : String(CENTRAL_OVERRIDE.url || ""),
    centralSharedPin: String(CENTRAL_OVERRIDE.pin || "ad5d1bc7"),
    rootFolderName: "小林機械 書類データ",
    estimateFolderName: "見積もり",
    legacyEstimateFolderName: "見積書",
    reportFolderName: "報告書",
    schemaVersion: "2"
  });

  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const FOLDER_CACHE_KEY = "kkmt_drive_folder_ids_v1";
  const PENDING_PREFIX = "kkmt_drive_pending_";
  const SESSION_TOKEN_KEY = "kkmt_drive_session_token_v1";
  const DATA_TYPE_KEY = "_kkmtDocumentType";

  let accessToken = "";
  let accessTokenExpiresAt = 0;
  let tokenClient = null;
  let preparePromise = null;
  let connectPromise = null;
  let connectResolve = null;
  let connectReject = null;
  let centralConnected = false;
  let jsonpSequence = 0;

  class DriveError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "DriveError";
      this.status = status || 0;
    }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalizeKocon = value => String(value == null ? "" : value).trim();
  const normalizeSubject = value => String(value == null ? "" : value).trim();
  const safeFileSegment = value => normalizeSubject(value).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").slice(0, 100);
  function requireDocType(docType) {
    if (!["estimate", "report"].includes(docType)) throw new DriveError("不明な書類種別です。");
    return docType;
  }
  function documentRevision(data) {
    const value = Number(data && data._kkmtRevision);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function comparableDocument(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    const copy = Object.assign({}, data);
    delete copy._kkmtRevision;
    delete copy._kkmtUpdatedAt;
    delete copy[DATA_TYPE_KEY];
    return copy;
  }
  function validateDocumentForSave(data, docType, kocon, subject) {
    requireDocType(docType);
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        !data.fields || typeof data.fields !== "object" || Array.isArray(data.fields)) {
      throw new DriveError("保存データの必須項目が不足しています。");
    }
    const dataType = data.documentType || data[DATA_TYPE_KEY] || "";
    if (dataType && dataType !== docType) throw new DriveError("別の種類の書類データは保存できません。");
    if (docType === "report" && !Array.isArray(data.work)) throw new DriveError("報告書の作業データが不足しています。");
    const objectArrays = docType === "report" ? ["parts","customs","lodges","work"] : ["parts","customs","lodges","wdays"];
    const allArrays = docType === "report" ? [...objectArrays,"workers","activeWorkers"] : [...objectArrays,"excludedItemKeys"];
    for (const key of allArrays) {
      if (key in data && !Array.isArray(data[key])) throw new DriveError(key + " の形式が正しくありません。");
    }
    for (const key of objectArrays) {
      if (Array.isArray(data[key]) && data[key].some(item => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new DriveError(key + " の項目形式が正しくありません。");
      }
    }
    if (docType === "report" && data.work.some(row =>
      "people" in row && (!Array.isArray(row.people) || row.people.some(person => !person || typeof person !== "object" || Array.isArray(person))))) {
      throw new DriveError("作業者データの形式が正しくありません。");
    }
    if (docType === "report") {
      for (const key of ["workers","activeWorkers"]) {
        if (Array.isArray(data[key]) && data[key].some(worker => typeof worker !== "string")) {
          throw new DriveError(key + " の要素形式が正しくありません。");
        }
      }
      const stringKeys = ["id","date","content","start","end","worker"];
      if (data.work.some(row =>
        stringKeys.some(key => key in row && typeof row[key] !== "string") ||
        ("holiday" in row && typeof row.holiday !== "boolean") ||
        ("hours" in row && !["string","number"].includes(typeof row.hours)) ||
        (Array.isArray(row.people) && row.people.some(person =>
          ("worker" in person && typeof person.worker !== "string") ||
          ("hours" in person && !["string","number"].includes(typeof person.hours))
        )))) {
        throw new DriveError("作業データ内の値形式が正しくありません。");
      }
    }
    if ("directEdits" in data && (!data.directEdits || typeof data.directEdits !== "object" || Array.isArray(data.directEdits))) {
      throw new DriveError("直接編集データの形式が正しくありません。");
    }
    const dataKocon = normalizeKocon(data.fields.mKocon || data.fields.estNo);
    const dataSubject = normalizeSubject(data.fields.subject);
    if (normalizeKocon(kocon) !== dataKocon) throw new DriveError("高コン番号と保存データが一致しません。");
    if (normalizeSubject(subject) && normalizeSubject(subject) !== dataSubject) throw new DriveError("件名と保存データが一致しません。");
    if (docType === "report" && "signature" in data) {
      const signature = data.signature || "";
      if (typeof signature !== "string" || signature.length > 5000000 ||
          (signature && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(signature))) {
        throw new DriveError("サイン画像の形式または容量が正しくありません。");
      }
    }
    return data;
  }
  function stampDocumentType(data, docType, revision) {
    requireDocType(docType);
    const stamped = data && typeof data === "object" && !Array.isArray(data) ? Object.assign({}, data) : { value: data };
    stamped[DATA_TYPE_KEY] = docType;
    if (revision != null) {
      stamped._kkmtRevision = revision;
      stamped._kkmtUpdatedAt = new Date().toISOString();
    }
    return stamped;
  }
  function verifyDocumentType(data, docType) {
    requireDocType(docType);
    const inferred = data && typeof data === "object"
      ? (Array.isArray(data.work) || "signature" in data || Array.isArray(data.workers)
          ? "report"
          : (Array.isArray(data.wdays) ? "estimate" : ""))
      : "";
    if (data && ((data[DATA_TYPE_KEY] && data[DATA_TYPE_KEY] !== docType) ||
        (!data[DATA_TYPE_KEY] && inferred && inferred !== docType))) {
      throw new DriveError("別の種類の書類データのため読み込みを中止しました。");
    }
    if (data && typeof data === "object" && !Array.isArray(data) && DATA_TYPE_KEY in data) {
      delete data[DATA_TYPE_KEY];
    }
    return data;
  }
  const escapeQuery = value => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const pendingKey = (docType, kocon, subject) => {
    const identity = normalizeKocon(kocon)
      ? `k_${normalizeKocon(kocon)}`
      : `s_${normalizeSubject(subject)}`;
    return `${PENDING_PREFIX}${docType}_${encodeURIComponent(identity)}`;
  };

  function readJsonStorage(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearSessionToken() {
    accessToken = "";
    accessTokenExpiresAt = 0;
    try {
      if (global.sessionStorage) global.sessionStorage.removeItem(SESSION_TOKEN_KEY);
    } catch (_) {}
  }

  function restoreSessionToken() {
    if (accessToken) return;
    try {
      if (!global.sessionStorage) return;
      const saved = JSON.parse(global.sessionStorage.getItem(SESSION_TOKEN_KEY) || "null");
      if (!saved || !saved.accessToken || Number(saved.expiresAt) <= Date.now() + 5000) {
        global.sessionStorage.removeItem(SESSION_TOKEN_KEY);
        return;
      }
      accessToken = saved.accessToken;
      accessTokenExpiresAt = Number(saved.expiresAt);
    } catch (_) {
      clearSessionToken();
    }
  }

  function rememberSessionToken(response) {
    accessToken = response.access_token;
    const expiresIn = Math.max(60, Number(response.expires_in) || 3600);
    accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    try {
      if (global.sessionStorage) {
        global.sessionStorage.setItem(SESSION_TOKEN_KEY, JSON.stringify({
          accessToken,
          expiresAt: accessTokenExpiresAt
        }));
      }
    } catch (_) {}
  }

  function readFolderCache() {
    const cache = readJsonStorage(FOLDER_CACHE_KEY, {});
    return cache && typeof cache === "object" ? cache : {};
  }

  function writeFolderCache(cache) {
    writeJsonStorage(FOLDER_CACHE_KEY, cache);
  }

  function centralJsonp(parameters) {
    if (!CONFIG.centralBackendUrl) {
      return Promise.reject(new DriveError("共通Driveの接続先が設定されていません。"));
    }
    if (!global.document || !global.document.createElement) {
      return Promise.reject(new DriveError("共通Driveの通信を開始できません。"));
    }
    return new Promise((resolve, reject) => {
      const callback = `__kkmtCentralDrive${Date.now()}_${++jsonpSequence}`;
      const script = global.document.createElement("script");
      const timeout = global.setTimeout(() => {
        cleanup();
        reject(new DriveError("共通Driveの応答がありません。ページを再読み込みして、もう一度お試しください。"));
      }, 15000);
      const cleanup = () => {
        global.clearTimeout(timeout);
        try { delete global[callback]; } catch (_) { global[callback] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      global[callback] = response => {
        cleanup();
        if (!response || response.ok !== true) {
          reject(new DriveError((response && response.error) || "共通Driveでエラーが発生しました。"));
          return;
        }
        resolve(response.result);
      };
      script.async = true;
      script.onerror = () => {
        cleanup();
        reject(new DriveError("共通Driveへ接続できません。通信環境を確認して、もう一度お試しください。"));
      };
      const params = new URLSearchParams(Object.assign({}, parameters, {
        pin: CONFIG.centralSharedPin,
        callback
      }));
      script.src = `${CONFIG.centralBackendUrl}?${params.toString()}`;
      (global.document.head || global.document.documentElement).appendChild(script);
    });
  }

  async function centralPing() {
    const result = await centralJsonp({ action: "ping" });
    centralConnected = !!(result && result.connected);
    if (!centralConnected) throw new DriveError("共通Driveへ接続できませんでした。");
    return result;
  }

  async function centralLoad({ kocon, subject, docType }) {
    requireDocType(docType);
    const result = await centralJsonp({
      action: "load",
      docType,
      kocon: normalizeKocon(kocon),
      subject: normalizeSubject(subject)
    });
    centralConnected = true;
    return result == null ? null : verifyDocumentType(result, docType);
  }

  async function centralSave({ kocon, subject, previousSubject, docType, data, expectedRevision }) {
    requireDocType(docType);
    const normalizedKocon = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    validateDocumentForSave(data, docType, normalizedKocon, normalizedSubject);
    if (!normalizedKocon && !(docType === "estimate" && normalizedSubject)) {
      throw new DriveError(docType === "estimate" ? "高コンまたは件名が空欄のため保存できません。" : "高コンが空欄のため保存できません。");
    }
    const hasExpectedRevision = expectedRevision != null ||
      !!(data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "_kkmtRevision"));
    const expected = hasExpectedRevision
      ? (Number.isSafeInteger(Number(expectedRevision)) && Number(expectedRevision) >= 0
          ? Number(expectedRevision)
          : documentRevision(data))
      : null;
    const requestBody = {
      action: "save",
      pin: CONFIG.centralSharedPin,
      kocon: normalizedKocon,
      subject: normalizedSubject,
      previousSubject: normalizeSubject(previousSubject),
      docType,
      data
    };
    if (expected != null) requestBody.expectedRevision = expected;
    await fetch(CONFIG.centralBackendUrl, {
      method: "POST",
      mode: "no-cors",
      credentials: "include",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(requestBody)
    });
    const loaded = await centralLoad({
      kocon: normalizedKocon,
      subject: normalizedSubject,
      docType
    });
    const loadedRevision = documentRevision(loaded);
    const revisionMatches = expected == null || loadedRevision === expected + 1;
    if (!loaded || !revisionMatches ||
        JSON.stringify(comparableDocument(loaded)) !== JSON.stringify(comparableDocument(data))) {
      throw new DriveError("他の端末で更新されています。最新データを読み込んでから、もう一度保存してください。", 409);
    }
    centralConnected = true;
    return { ok: true, revision: loadedRevision, updatedAt: loaded._kkmtUpdatedAt || "" };
  }

  async function prepare() {
    if (CONFIG.centralBackendUrl) {
      if (centralConnected) return;
      if (preparePromise) return preparePromise;
      preparePromise = centralPing().catch(error => {
        preparePromise = null;
        throw error;
      });
      return preparePromise;
    }
    restoreSessionToken();
    if (tokenClient) return;
    if (preparePromise) return preparePromise;
    preparePromise = (async () => {
      for (let i = 0; i < 100; i += 1) {
        if (global.google && global.google.accounts && global.google.accounts.oauth2) break;
        await sleep(50);
      }
      if (!(global.google && global.google.accounts && global.google.accounts.oauth2)) {
        throw new DriveError("Google認証ライブラリを読み込めませんでした。");
      }
      tokenClient = global.google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.clientId,
        scope: CONFIG.scope,
        callback: response => {
          if (!connectPromise) return;
          if (response && response.access_token) {
            rememberSessionToken(response);
            connectResolve(response);
          } else {
            connectReject(new DriveError((response && response.error_description) || "Google Driveの認証に失敗しました。"));
          }
          connectPromise = null;
          connectResolve = null;
          connectReject = null;
        },
        error_callback: error => {
          if (!connectPromise) return;
          connectReject(new DriveError((error && (error.message || error.type)) || "Google Driveの認証画面を開けませんでした。"));
          connectPromise = null;
          connectResolve = null;
          connectReject = null;
        }
      });
    })().catch(error => {
      preparePromise = null;
      throw error;
    });
    return preparePromise;
  }

  async function connect() {
    if (CONFIG.centralBackendUrl) return centralPing();
    if (isConnected()) return Promise.resolve({ access_token: accessToken });
    if (!tokenClient) {
      return Promise.reject(new DriveError("Google認証の準備中です。少し待ってからもう一度押してください。"));
    }
    if (connectPromise) return connectPromise;
    connectPromise = new Promise((resolve, reject) => {
      connectResolve = resolve;
      connectReject = reject;
    });
    try {
      tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
    } catch (error) {
      connectPromise = null;
      connectResolve = null;
      connectReject = null;
      return Promise.reject(error);
    }
    return connectPromise;
  }

  function isConnected() {
    if (CONFIG.centralBackendUrl) return centralConnected;
    if (!accessToken) return false;
    if (accessTokenExpiresAt && accessTokenExpiresAt <= Date.now() + 5000) {
      clearSessionToken();
      return false;
    }
    return true;
  }

  async function apiFetch(url, options) {
    if (!isConnected()) throw new DriveError("Google Driveへ接続してください。", 401);
    const request = Object.assign({}, options || {});
    request.headers = new Headers(request.headers || {});
    request.headers.set("Authorization", `Bearer ${accessToken}`);
    const response = await fetch(url, request);
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body && body.error && body.error.message ? body.error.message : "";
      } catch (_) {
        try {
          detail = (await response.text()).slice(0, 180);
        } catch (_) {}
      }
      if (response.status === 401) clearSessionToken();
      throw new DriveError(detail || `Google Drive APIエラー（${response.status}）`, response.status);
    }
    if (response.status === 204) return null;
    const type = response.headers.get("content-type") || "";
    return type.includes("application/json") ? response.json() : response.text();
  }

  async function listFiles(query) {
    const params = new URLSearchParams({
      q: query,
      spaces: "drive",
      pageSize: "100",
      fields: "files(id,name,parents,mimeType,trashed,appProperties)"
    });
    const result = await apiFetch(`${DRIVE_API}/files?${params.toString()}`);
    return (result && result.files) || [];
  }

  async function getFileMetadata(fileId) {
    const fields = encodeURIComponent("id,name,parents,mimeType,trashed");
    return apiFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${fields}`);
  }

  async function createMetadata(metadata) {
    return apiFetch(`${DRIVE_API}/files?fields=id,name,parents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata)
    });
  }

  async function resolveFolder(cacheKey, name, parentId) {
    const cache = readFolderCache();
    const cachedId = cache[cacheKey];
    if (cachedId) {
      try {
        const folder = await getFileMetadata(cachedId);
        const validParent = parentId === "root" || (folder.parents || []).includes(parentId);
        if (!folder.trashed && folder.mimeType === FOLDER_MIME && validParent) return cachedId;
      } catch (error) {
        if (!(error instanceof DriveError) || ![403, 404].includes(error.status)) throw error;
      }
      delete cache[cacheKey];
      writeFolderCache(cache);
    }

    const parentClause = `'${escapeQuery(parentId)}' in parents`;
    const query = [
      `name = '${escapeQuery(name)}'`,
      `mimeType = '${FOLDER_MIME}'`,
      parentClause,
      "trashed = false"
    ].join(" and ");
    const found = (await listFiles(query))[0];
    const folder = found || await createMetadata({
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId]
    });
    cache[cacheKey] = folder.id;
    writeFolderCache(cache);
    return folder.id;
  }

  async function getDocumentFolder(docType) {
    requireDocType(docType);
    const rootId = await resolveFolder("root", CONFIG.rootFolderName, "root");
    const name = docType === "estimate" ? CONFIG.estimateFolderName : CONFIG.reportFolderName;
    return resolveFolder(docType, name, rootId);
  }

  async function findDocument(kocon, docType) {
    requireDocType(docType);
    const normalized = normalizeKocon(kocon);
    if (!normalized) return null;
    const folderId = await getDocumentFolder(docType);
    const query = [
      `'${escapeQuery(folderId)}' in parents`,
      "trashed = false",
      "mimeType = 'application/json'",
      `appProperties has { key='kocon' and value='${escapeQuery(normalized)}' }`,
      `appProperties has { key='docType' and value='${escapeQuery(docType)}' }`
    ].join(" and ");
    return (await listFiles(query))[0] || null;
  }

  async function findDocumentBySubject(subject, docType) {
    requireDocType(docType);
    const normalized = normalizeSubject(subject);
    if (!normalized) return null;
    const folderId = await getDocumentFolder(docType);
    const query = [
      `'${escapeQuery(folderId)}' in parents`,
      "trashed = false",
      "mimeType = 'application/json'",
      `appProperties has { key='subjectKey' and value='${escapeQuery(normalized)}' }`,
      `appProperties has { key='docType' and value='${escapeQuery(docType)}' }`
    ].join(" and ");
    const matches = await listFiles(query);
    return matches.find(file => !normalizeKocon(file && file.appProperties && file.appProperties.kocon)) || matches[0] || null;
  }

  async function findDocumentByEmbeddedSubject(subject, docType) {
    const normalized = normalizeSubject(subject);
    if (!normalized) return null;
    const folderId = await getDocumentFolder(docType);
    const query = [
      `'${escapeQuery(folderId)}' in parents`,
      "trashed = false",
      "mimeType = 'application/json'",
      `appProperties has { key='docType' and value='${escapeQuery(docType)}' }`
    ].join(" and ");
    for (const file of await listFiles(query)) {
      try {
        const raw = await apiFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`);
        const data = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (normalizeSubject(data && data.fields && data.fields.subject) === normalized) {
          return { file, data };
        }
      } catch (_) {}
    }
    return null;
  }

  async function findLegacyEstimateDocument(kocon) {
    const normalized = normalizeKocon(kocon);
    if (!normalized) return null;
    const rootId = await resolveFolder("root", CONFIG.rootFolderName, "root");
    const folderQuery = [
      `name = '${escapeQuery(CONFIG.legacyEstimateFolderName)}'`,
      `mimeType = '${FOLDER_MIME}'`,
      `'${escapeQuery(rootId)}' in parents`,
      "trashed = false"
    ].join(" and ");
    const legacyFolder = (await listFiles(folderQuery))[0];
    if (!legacyFolder) return null;
    const fileQuery = [
      `'${escapeQuery(legacyFolder.id)}' in parents`,
      "trashed = false",
      "mimeType = 'application/json'",
      `appProperties has { key='kocon' and value='${escapeQuery(normalized)}' }`,
      "appProperties has { key='docType' and value='estimate' }"
    ].join(" and ");
    return (await listFiles(fileQuery))[0] || null;
  }

  function documentName(kocon, subject, docType) {
    requireDocType(docType);
    const normalizedKocon = normalizeKocon(kocon);
    const normalizedSubject = safeFileSegment(subject);
    if (docType === "estimate") {
      return [
        normalizedKocon ? `高コン${normalizedKocon}` : "",
        normalizedSubject,
        "見積もり"
      ].filter(Boolean).join("_") + ".json";
    }
    return `高コン${normalizedKocon}_報告書.json`;
  }

  function documentProperties(kocon, subject, docType, revision) {
    const properties = {
      docType,
      schemaVersion: CONFIG.schemaVersion,
      revision: String(revision == null ? 0 : revision)
    };
    const normalizedKocon = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    if (normalizedKocon) properties.kocon = normalizedKocon;
    if (normalizedSubject) properties.subjectKey = normalizedSubject;
    return properties;
  }

  async function createJsonDocument(kocon, subject, docType, data, folderId, revision) {
    const metadata = {
      name: documentName(kocon, subject, docType),
      parents: [folderId],
      mimeType: "application/json",
      appProperties: documentProperties(kocon, subject, docType, revision)
    };
    const boundary = `kkmt_drive_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      JSON.stringify(stampDocumentType(data, docType, revision), null, 2),
      `\r\n--${boundary}--`
    ], { type: `multipart/related; boundary=${boundary}` });
    return apiFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,appProperties`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    });
  }

  async function updateJsonDocument(fileId, kocon, subject, docType, data, revision) {
    await apiFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,appProperties`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        name: documentName(kocon, subject, docType),
        appProperties: documentProperties(kocon, subject, docType, revision)
      })
    });
    return apiFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,appProperties`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(stampDocumentType(data, docType, revision), null, 2)
    });
  }

  async function saveJson({ kocon, subject, previousSubject, docType, data, expectedRevision }) {
    if (CONFIG.centralBackendUrl) {
      return centralSave({ kocon, subject, previousSubject, docType, data, expectedRevision });
    }
    throw new DriveError("安全な競合防止のため、共通Driveバックエンド経由で保存してください。", 503);
    /* istanbul ignore next -- direct OAuth writes are disabled because Drive API has no atomic create/update CAS here */
    requireDocType(docType);
    const normalized = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    validateDocumentForSave(data, docType, normalized, normalizedSubject);
    const suppliedRevision = expectedRevision != null ||
      !!(data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "_kkmtRevision"));
    let expected = Number.isSafeInteger(Number(expectedRevision)) && Number(expectedRevision) >= 0
      ? Number(expectedRevision)
      : documentRevision(data);
    if (!normalized && !(docType === "estimate" && normalizedSubject)) {
      throw new DriveError(docType === "estimate" ? "高コンまたは件名が空欄のため保存できません。" : "高コンが空欄のため保存できません。");
    }
    const folderId = await getDocumentFolder(docType);
    let existing = normalized ? await findDocument(normalized, docType) : null;
    if (!existing && normalizedSubject) {
      const bySubject = await findDocumentBySubject(normalizedSubject, docType);
      const candidateKocon = normalizeKocon(bySubject && bySubject.appProperties && bySubject.appProperties.kocon);
      if (!candidateKocon) existing = bySubject;
    }
    if (!existing && previousSubject && normalizeSubject(previousSubject) !== normalizedSubject) {
      const byPreviousSubject = await findDocumentBySubject(previousSubject, docType);
      const candidateKocon = normalizeKocon(byPreviousSubject && byPreviousSubject.appProperties && byPreviousSubject.appProperties.kocon);
      if (!candidateKocon) existing = byPreviousSubject;
    }
    const existingRevision = existing ? Number((existing.appProperties && existing.appProperties.revision) || 0) : 0;
    if (!suppliedRevision && existingRevision > 0) {
      throw new DriveError("旧形式の保存データは、最新版を読み込むまで上書きできません。", 409);
    }
    if (!suppliedRevision) expected = 0;
    if ((existing && existingRevision !== expected) || (!existing && expected !== 0)) {
      throw new DriveError("他の端末で更新されています。最新データを読み込んでから、もう一度保存してください。", 409);
    }
    const nextRevision = expected + 1;
    if (existing) {
      try {
        await updateJsonDocument(existing.id, normalized, normalizedSubject, docType, data, nextRevision);
        return { ok: true, revision: nextRevision };
      } catch (error) {
        if (!(error instanceof DriveError) || error.status !== 404) throw error;
      }
    }
    const created = await createJsonDocument(normalized, normalizedSubject, docType, data, folderId, nextRevision);
    return { ok: true, revision: nextRevision, id: created && created.id };
  }

  async function loadJson({ kocon, subject, docType }) {
    if (CONFIG.centralBackendUrl) {
      return centralLoad({ kocon, subject, docType });
    }
    requireDocType(docType);
    const normalizedKocon = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    const file = (normalizedKocon ? await findDocument(normalizedKocon, docType) : null) ||
      (normalizedSubject ? await findDocumentBySubject(normalizedSubject, docType) : null) ||
      (docType === "estimate" && normalizedKocon ? await findLegacyEstimateDocument(normalizedKocon) : null);
    if (!file && normalizedSubject) {
      const embedded = await findDocumentByEmbeddedSubject(normalizedSubject, docType);
      if (embedded) return verifyDocumentType(embedded.data, docType);
    }
    if (!file) return null;
    const result = await apiFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`);
    if (typeof result === "string") {
      try {
        return verifyDocumentType(JSON.parse(result), docType);
      } catch (_) {
        throw new DriveError("Drive上のJSONデータを読み取れませんでした。");
      }
    }
    return verifyDocumentType(result, docType);
  }

  function storePending(docType, kocon, subject, previousSubject, data, json, expectedRevision) {
    requireDocType(docType);
    const normalized = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    if (!normalized && !(docType === "estimate" && normalizedSubject)) return false;
    return writeJsonStorage(pendingKey(docType, normalized, normalizedSubject), {
      docType,
      kocon: normalized,
      subject: normalizedSubject,
      previousSubject: normalizeSubject(previousSubject),
      expectedRevision: Number.isSafeInteger(Number(expectedRevision)) && Number(expectedRevision) >= 0 ? Number(expectedRevision) : documentRevision(data),
      json: json || JSON.stringify(data),
      updatedAt: new Date().toISOString()
    });
  }

  function removePending(docType, kocon, subject) {
    try {
      if (normalizeKocon(kocon)) localStorage.removeItem(pendingKey(docType, kocon, ""));
      if (normalizeSubject(subject)) localStorage.removeItem(pendingKey(docType, "", subject));
    } catch (_) {}
  }

  function getPendingItems(docTypeFilter) {
    const items = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(PENDING_PREFIX)) continue;
        const item = readJsonStorage(key, null);
        if (item && (item.kocon || (item.docType === "estimate" && item.subject)) && ["estimate", "report"].includes(item.docType) &&
            (!docTypeFilter || item.docType === docTypeFilter)) {
          items.push({ key, item });
        }
      }
    } catch (_) {}
    return items.sort((a, b) => String(a.item.updatedAt || "").localeCompare(String(b.item.updatedAt || "")));
  }

  async function flushPending(docTypeFilter) {
    const results = [];
    for (const entry of getPendingItems(docTypeFilter)) {
      try {
        const data = entry.item.data || JSON.parse(entry.item.json);
        const result = await saveJson({
          kocon: entry.item.kocon,
          subject: entry.item.subject,
          previousSubject: entry.item.previousSubject,
          docType: entry.item.docType,
          data,
          expectedRevision: entry.item.expectedRevision
        });
        try {
          localStorage.removeItem(entry.key);
        } catch (_) {}
        results.push({ ok: true, item: entry.item, result });
      } catch (error) {
        results.push({ ok: false, item: entry.item, error });
        if (error instanceof DriveError && error.status === 401) break;
      }
    }
    return results;
  }

  function createAutosaveController(options) {
    const docType = options.docType;
    const label = docType === "estimate" ? "見積書" : "報告書";
    const root = options.rootElement || document;
    const koconInput = options.koconInput;
    const fallbackInput = options.fallbackInput;
    const statusElement = options.statusElement;
    const connectButton = options.connectButton;
    const collectState = options.collectState;
    const onKoconConfirmed = options.onKoconConfirmed;
    const onIdentityChanging = options.onIdentityChanging;
    const onIdentityChanged = options.onIdentityChanged;
    const onSavedRevision = options.onSavedRevision;
    const debounceMs = options.debounceMs || 550;
    let confirmedKocon = "";
    let activeRevision = documentRevision(collectState());
    const lastSavedJson = new Map();
    let skipNextInitialLoad = !!options.skipInitialLoad;

    let activeKocon = normalizeKocon(koconInput && koconInput.value);
    let activeSubject = normalizeSubject(fallbackInput && fallbackInput.value);
    let timer = null;
    let saveRequested = false;
    let savingPromise = null;
    let commitPromise = null;
    let skipPagehideSave = false;

    function setStatus(message, state) {
      if (!statusElement) return;
      statusElement.textContent = message;
      statusElement.classList.toggle("ok", state === "ok");
      statusElement.classList.toggle("err", state === "error");
    }

    function snapshot() {
      const kocon = normalizeKocon(koconInput && koconInput.value);
      const subject = normalizeSubject(fallbackInput && fallbackInput.value);
      const data = collectState();
      return { kocon, subject, previousSubject: activeSubject, data, expectedRevision: activeRevision, json: JSON.stringify(comparableDocument(data)) };
    }

    function snapshotKey(current) {
      return current.kocon ? `k:${current.kocon}` : (current.subject ? `s:${current.subject}` : "");
    }

    async function saveLoop() {
      if (savingPromise) return savingPromise;
      savingPromise = (async () => {
        while (saveRequested) {
          saveRequested = false;
          const current = snapshot();
          const currentKey = snapshotKey(current);
          const canSaveBySubject = docType === "estimate" && current.subject;
          if (!current.kocon && !canSaveBySubject) {
            setStatus(
              isConnected()
                ? (docType === "estimate" ? "共通Drive接続済み（高コンまたは件名を入力すると自動保存）" : "共通Drive接続済み（高コンを入力すると自動保存）")
                : (docType === "estimate" ? "高コンまたは件名を入力すると共通Driveへ自動保存できます。" : "高コンを入力すると共通Driveへ自動保存できます。"),
              isConnected() ? "ok" : ""
            );
            continue;
          }
          if (!isConnected()) {
            const stored = storePending(docType, current.kocon, current.subject, current.previousSubject, current.data, current.json, current.expectedRevision);
            if (stored) {
              if (current.previousSubject &&
                  (current.kocon || current.previousSubject !== current.subject)) {
                removePending(docType, "", current.previousSubject);
              }
              activeSubject = current.subject;
            }
            setStatus(stored ? "共通Drive未接続（端末内へ一時保存済み）" : "共通Drive未接続（端末内への保存に失敗）", stored ? "" : "error");
            continue;
          }
          if (lastSavedJson.get(currentKey) === current.json) {
            removePending(docType, current.kocon, current.subject);
            continue;
          }
          setStatus(`${label}を共通Driveへ保存中…`);
          try {
            const result = await saveJson({
              kocon: current.kocon,
              subject: current.subject,
              previousSubject: current.previousSubject,
              docType,
              data: current.data,
              expectedRevision: current.expectedRevision
            });
            activeRevision = Number(result && result.revision);
            if (!Number.isSafeInteger(activeRevision) || activeRevision < 0) activeRevision = current.expectedRevision + 1;
            if (onSavedRevision) await onSavedRevision(activeRevision);
            lastSavedJson.set(currentKey, current.json);
            activeSubject = current.subject;
            removePending(docType, current.kocon, current.subject);
            if (current.previousSubject && current.previousSubject !== current.subject) {
              removePending(docType, "", current.previousSubject);
            }
            const time = new Intl.DateTimeFormat("ja-JP", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit"
            }).format(new Date());
            setStatus(`${label}を自動保存しました ${time}`, "ok");
          } catch (error) {
            if (!skipPagehideSave) storePending(docType, current.kocon, current.subject, current.previousSubject, current.data, current.json, current.expectedRevision);
            if (error instanceof DriveError && error.status === 401) {
              connectButton.textContent = "共通Driveに接続";
              setStatus("接続期限が切れました。再接続してください（端末内へ一時保存済み）", "error");
            } else if (error instanceof DriveError && error.status === 409) {
              setStatus("他の端末で更新されています。Driveから最新データを読み込んでください（端末内の変更は保持中）", "error");
            } else {
              setStatus("保存に失敗しました。端末内へ一時保存しました", "error");
            }
            console.error("Central Drive autosave failed", error);
          }
        }
      })().finally(() => {
        savingPromise = null;
        if (saveRequested) saveLoop();
      });
      return savingPromise;
    }

    function markDirty({ immediate = false } = {}) {
      saveRequested = true;
      clearTimeout(timer);
      if (immediate) return saveLoop();
      timer = setTimeout(saveLoop, debounceMs);
      return null;
    }

    async function whenIdle() {
      while (commitPromise) await commitPromise;
      clearTimeout(timer);
      if (saveRequested) await saveLoop();
      if (savingPromise) await savingPromise;
      if (commitPromise || saveRequested || savingPromise) return whenIdle();
      return true;
    }

    async function confirmCurrentKocon({ save = true } = {}) {
      if (commitPromise) return commitPromise;
      commitPromise = (async () => {
        const next = normalizeKocon(koconInput.value);
        const previous = activeKocon;
        const previousConfirmed = confirmedKocon;
        const previousRevision = activeRevision;
        const nextSubject = normalizeSubject(fallbackInput && fallbackInput.value);
        const isSubjectPromotion = docType === "estimate" && !previous && !!next &&
          !!activeSubject && nextSubject === activeSubject;
        let identityHookRan = false;
        koconInput.value = next;

        if (next !== previous && previous) {
          const display = next ? `「${next}」` : "空欄";
          const accepted = global.confirm(`高コンを「${previous}」から${display}に変更します。現在の内容を保存して切り替えますか？`);
          if (!accepted) {
            koconInput.value = previous;
            setStatus("高コンの変更を取り消しました。");
            return false;
          }

          if (onIdentityChanging) await onIdentityChanging({ previous, next });
          identityHookRan = true;
          clearTimeout(timer);
          if (savingPromise) await savingPromise;
          koconInput.value = previous;
          await markDirty({ immediate: true });
          koconInput.value = next;
        }

        if (next !== previous && !identityHookRan && onIdentityChanging) await onIdentityChanging({ previous, next });
        activeKocon = next;
        if (next !== previous) {
          confirmedKocon = "";
          activeRevision = isSubjectPromotion ? previousRevision : 0;
          if (onSavedRevision) await onSavedRevision(activeRevision);
        }
        if (!next) {
          setStatus(docType === "estimate"
            ? "高コンがなくても、件名で共通Driveへ自動保存できます。"
            : "高コンを入力すると共通Driveへ自動保存できます。");
          if (save && docType === "estimate" && normalizeSubject(fallbackInput && fallbackInput.value)) {
            await markDirty({ immediate: true });
          }
          if (next !== previous && onIdentityChanged) await onIdentityChanged({ previous, next });
          return true;
        }

        if (!isConnected()) {
          if (save) await markDirty({ immediate: true });
          if (next !== previous && onIdentityChanged) await onIdentityChanged({ previous, next });
          return true;
        }

        let loadedExisting = false;
        if (onKoconConfirmed && confirmedKocon !== next) {
          koconInput.disabled = true;
          let confirmed = false;
          try {
            const confirmation = await onKoconConfirmed({
              kocon: next,
              isConnected: true,
              setStatus
            });
            confirmed = confirmation !== false;
            loadedExisting = !!(confirmation && confirmation.loaded);
            if (confirmed) {
              const loadedRevision = Number(confirmation && confirmation.revision);
              activeRevision = Number.isSafeInteger(loadedRevision) && loadedRevision >= 0
                ? loadedRevision
                : documentRevision(collectState());
              if (onSavedRevision) await onSavedRevision(activeRevision);
            }
          } catch (error) {
            console.error("Kocon confirmation failed", error);
            setStatus(`${label}データの確認に失敗しました。`, "error");
          } finally {
            koconInput.disabled = false;
          }
          if (!confirmed) {
            koconInput.value = previous;
            activeKocon = previous;
            confirmedKocon = previousConfirmed;
            activeRevision = previousRevision;
            if (onSavedRevision) await onSavedRevision(activeRevision);
            setStatus("切替先のデータを確認できなかったため、高コンを元に戻しました。", "error");
            if (next !== previous && onIdentityChanged) await onIdentityChanged({ previous: next, next: previous });
            return false;
          }
          confirmedKocon = next;
          if (loadedExisting) {
            const loadedSnapshot = snapshot();
            lastSavedJson.set(snapshotKey(loadedSnapshot), loadedSnapshot.json);
            activeSubject = loadedSnapshot.subject;
          }
        }

        if (save && !loadedExisting) await markDirty({ immediate: true });
        if (next !== previous && onIdentityChanged) await onIdentityChanged({ previous, next });
        return true;
      })().finally(() => {
        commitPromise = null;
      });
      return commitPromise;
    }

    function adoptCurrentKocon({ confirmed = false, save = true, revision } = {}) {
      const current = normalizeKocon(koconInput.value);
      koconInput.value = current;
      activeKocon = current;
      activeSubject = normalizeSubject(fallbackInput && fallbackInput.value);
      confirmedKocon = confirmed ? current : "";
      const adoptedRevision = revision == null ? documentRevision(collectState()) : Number(revision);
      activeRevision = Number.isSafeInteger(adoptedRevision) && adoptedRevision >= 0 ? adoptedRevision : 0;
      if (onSavedRevision) onSavedRevision(activeRevision);
      return save ? markDirty({ immediate: true }) : Promise.resolve();
    }

    async function resumeIdentity() {
      if (skipNextInitialLoad) {
        skipNextInitialLoad = false;
        await adoptCurrentKocon({ confirmed: true, save: false });
        setStatus("端末内の下書きを復元しました。共通Driveは自動で上書きしていません。", "ok");
        return true;
      }
      return confirmCurrentKocon();
    }

    function discardCurrent() {
      skipPagehideSave = true;
      clearTimeout(timer);
      saveRequested = false;
      const current = normalizeKocon(koconInput.value);
      const subject = normalizeSubject(fallbackInput && fallbackInput.value);
      removePending(docType, current, subject);
    }

    async function adoptFlushedRevision(results) {
      const currentKocon = normalizeKocon(koconInput && koconInput.value);
      const currentSubject = normalizeSubject(fallbackInput && fallbackInput.value);
      const synced = results.filter(entry => entry.ok && entry.result && Number.isSafeInteger(Number(entry.result.revision))).find(entry =>
        (currentKocon && normalizeKocon(entry.item.kocon) === currentKocon) ||
        (!currentKocon && currentSubject && normalizeSubject(entry.item.subject) === currentSubject)
      );
      if (!synced) return;
      activeRevision = Number(synced.result.revision);
      if (onSavedRevision) await onSavedRevision(activeRevision);
    }

    async function handleConnect() {
      setStatus("共通Driveへ接続中…");
      connectButton.disabled = true;
      try {
        await connect();
        connectButton.textContent = "共通Drive接続済み";
        setStatus("共通Driveへ接続しました。未同期データを確認中…", "ok");
        const results = await flushPending(docType);
        await adoptFlushedRevision(results);
        const failures = results.filter(result => !result.ok);
        if (failures.length) {
          setStatus("未同期データが他の端末の更新と競合しています。先にDriveの最新データを確認してください。", "error");
          return;
        } else if (results.length) {
          setStatus(`${results.length}件の未同期データを保存しました。`, "ok");
        } else {
          setStatus("共通Driveへ接続済み", "ok");
        }
        await resumeIdentity();
      } catch (error) {
        console.error("Central Drive connection failed", error);
        setStatus("共通Driveへ接続できません。通信環境を確認して、もう一度お試しください。", "error");
      } finally {
        connectButton.disabled = false;
      }
    }

    function isKoconTarget(target) {
      return target === koconInput;
    }

    function isFallbackTarget(target) {
      return !!fallbackInput && target === fallbackInput;
    }

    function isSearchTarget(target) {
      return !!(target && target.matches && target.matches("[data-drive-search]"));
    }

    function init() {
      if (!koconInput || !connectButton || typeof collectState !== "function") {
        throw new Error("共通Drive自動保存の初期設定が不足しています。");
      }

      connectButton.disabled = true;
      prepare().then(() => {
        connectButton.disabled = false;
        if (!isConnected()) {
          connectButton.textContent = "共通Driveに接続";
          setStatus("共通Drive未接続");
          return;
        }
        connectButton.textContent = "共通Drive接続済み";
        setStatus("共通Drive接続済み。未同期データを確認中…", "ok");
        flushPending(docType).then(async results => {
          await adoptFlushedRevision(results);
          const failures = results.filter(result => !result.ok);
          if (failures.length) {
            setStatus("未同期データが他の端末の更新と競合しています。先にDriveの最新データを確認してください。", "error");
            return;
          } else if (results.length) {
            setStatus(`${results.length}件の未同期${label}データを保存しました。`, "ok");
          } else {
            setStatus("共通Drive接続済み", "ok");
          }
          await resumeIdentity();
        }).catch(error => {
          console.error("Central Drive session resume failed", error);
          setStatus("接続の再開に失敗しました。接続ボタンを押してください。", "error");
          connectButton.textContent = "共通Driveに接続";
        });
      }).catch(error => {
        console.error("Central Drive failed to initialize", error);
        connectButton.disabled = false;
        connectButton.textContent = "共通Driveに接続";
        setStatus("共通Driveへ接続できません。ページを再読み込みするか、接続ボタンを押してください。", "error");
      });
      connectButton.addEventListener("click", handleConnect);

      ["change", "focusout"].forEach(eventName => {
        koconInput.addEventListener(eventName, () => confirmCurrentKocon({ save: true }));
      });
      koconInput.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        koconInput.blur();
        confirmCurrentKocon({ save: true });
      });

      if (fallbackInput) {
        fallbackInput.addEventListener("input", () => markDirty());
        fallbackInput.addEventListener("change", () => markDirty());
        fallbackInput.addEventListener("focusout", () => markDirty());
      }

      root.addEventListener("change", event => {
        const target = event.target;
        if (isKoconTarget(target) || isFallbackTarget(target) || isSearchTarget(target) || target.type === "file") return;
        if (target.matches("input,select,textarea")) markDirty();
      });
      root.addEventListener("input", event => {
        const target = event.target;
        if (isKoconTarget(target) || isFallbackTarget(target) || isSearchTarget(target) || target.type === "file") return;
        if (target.matches("input,select,textarea,[contenteditable='true']")) markDirty();
      });
      root.addEventListener("focusout", event => {
        const target = event.target;
        if (isKoconTarget(target) || isFallbackTarget(target) || isSearchTarget(target)) return;
        if (target.matches("input[type='text'],input[type='number'],input[type='date'],input[type='time'],textarea,[contenteditable='true']")) {
          markDirty();
        }
      });
      root.addEventListener("keydown", event => {
        const target = event.target;
        if (event.key === "Enter" && !isKoconTarget(target) && !isFallbackTarget(target) && !isSearchTarget(target) && target.matches("input[type='text'],input[type='number']")) {
          markDirty();
        }
      });
      root.addEventListener("click", event => {
        const target = event.target.closest("button");
        if (!target || target === connectButton) return;
        const mutationIds = new Set([
          "addCustom", "addPart", "addWday", "addLodge", "addBlank",
          "addWorker", "addWork", "genBtn", "ssOk", "sigClear"
        ]);
        if (mutationIds.has(target.id) || target.matches(".del,.rowdel,.pdel,.addPerson")) {
          setTimeout(() => markDirty(), 0);
        }
      });

      global.addEventListener("pagehide", () => {
        if (skipPagehideSave) return;
        const current = snapshot();
        const currentKey = snapshotKey(current);
        if (currentKey && lastSavedJson.get(currentKey) !== current.json) {
          storePending(docType, current.kocon, current.subject, current.previousSubject, current.data, current.json, current.expectedRevision);
        }
      });
      return api;
    }

    const api = {
      init,
      markDirty,
      whenIdle,
      confirmCurrentKocon,
      adoptCurrentKocon,
      discardCurrent,
      setStatus,
      getActiveKocon: () => activeKocon
    };
    return api;
  }

  global.KKMT_GOOGLE_DRIVE_CONFIG = CONFIG;
  global.KKMTDrive = Object.freeze({
    CONFIG,
    DriveError,
    prepare,
    connect,
    isConnected,
    findDocument,
    loadJson,
    saveJson,
    flushPending,
    createAutosaveController
  });
})(window);
