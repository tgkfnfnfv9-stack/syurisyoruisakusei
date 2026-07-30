(function (global) {
  "use strict";

  const CENTRAL_OVERRIDE = global.KKMT_CENTRAL_DRIVE_CONFIG || {};
  const CONFIG = Object.freeze({
    clientId: "568409413492-30m6042kemj3vrt2hog6joh2g2p7lcei.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.file",
    centralBackendUrl: CENTRAL_OVERRIDE.url === undefined
      ? "https://script.google.com/macros/s/AKfycbwv8C_-IKb3eoQARwYuumCohba_z5Lyq4t3aKZvYPTbbtMTz3VvEhOuhnFaY-j1SODa/exec"
      : String(CENTRAL_OVERRIDE.url || ""),
    centralSharedPin: String(CENTRAL_OVERRIDE.pin || "ad5d1bc7"),
    rootFolderName: "小林機械 書類データ",
    estimateFolderName: "見積もり",
    legacyEstimateFolderName: "見積書",
    reportFolderName: "報告書",
    schemaVersion: "1"
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
  function stampDocumentType(data, docType) {
    requireDocType(docType);
    const stamped = data && typeof data === "object" && !Array.isArray(data) ? Object.assign({}, data) : { value: data };
    stamped[DATA_TYPE_KEY] = docType;
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
      return Promise.reject(new DriveError("Dean共通Driveの接続先が設定されていません。"));
    }
    if (!global.document || !global.document.createElement) {
      return Promise.reject(new DriveError("Dean共通Driveの通信を開始できません。"));
    }
    return new Promise((resolve, reject) => {
      const callback = `__kkmtCentralDrive${Date.now()}_${++jsonpSequence}`;
      const script = global.document.createElement("script");
      const timeout = global.setTimeout(() => {
        cleanup();
        reject(new DriveError("Dean共通Driveの応答がありません。Googleへログイン後、もう一度お試しください。"));
      }, 15000);
      const cleanup = () => {
        global.clearTimeout(timeout);
        try { delete global[callback]; } catch (_) { global[callback] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      global[callback] = response => {
        cleanup();
        if (!response || response.ok !== true) {
          reject(new DriveError((response && response.error) || "Dean共通Driveでエラーが発生しました。"));
          return;
        }
        resolve(response.result);
      };
      script.async = true;
      script.onerror = () => {
        cleanup();
        reject(new DriveError("Dean共通Driveへ接続できません。Googleへログインしているか確認してください。"));
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
    if (!centralConnected) throw new DriveError("Dean共通Driveへ接続できませんでした。");
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

  async function centralSave({ kocon, subject, previousSubject, docType, data }) {
    requireDocType(docType);
    const normalizedKocon = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    if (!normalizedKocon && !(docType === "estimate" && normalizedSubject)) {
      throw new DriveError(docType === "estimate" ? "高コンまたは件名が空欄のため保存できません。" : "高コンが空欄のため保存できません。");
    }
    await fetch(CONFIG.centralBackendUrl, {
      method: "POST",
      mode: "no-cors",
      credentials: "include",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        action: "save",
        pin: CONFIG.centralSharedPin,
        kocon: normalizedKocon,
        subject: normalizedSubject,
        previousSubject: normalizeSubject(previousSubject),
        docType,
        data
      })
    });
    const loaded = await centralLoad({
      kocon: normalizedKocon,
      subject: normalizedSubject,
      docType
    });
    if (JSON.stringify(loaded) !== JSON.stringify(data)) {
      throw new DriveError("Dean共通Driveへの保存確認に失敗しました。");
    }
    centralConnected = true;
    return { ok: true };
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
    return (await listFiles(query))[0] || null;
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

  function documentProperties(kocon, subject, docType) {
    const properties = {
      docType,
      schemaVersion: CONFIG.schemaVersion
    };
    const normalizedKocon = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    if (normalizedKocon) properties.kocon = normalizedKocon;
    if (normalizedSubject) properties.subjectKey = normalizedSubject;
    return properties;
  }

  async function createJsonDocument(kocon, subject, docType, data, folderId) {
    const metadata = {
      name: documentName(kocon, subject, docType),
      parents: [folderId],
      mimeType: "application/json",
      appProperties: documentProperties(kocon, subject, docType)
    };
    const boundary = `kkmt_drive_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      JSON.stringify(stampDocumentType(data, docType), null, 2),
      `\r\n--${boundary}--`
    ], { type: `multipart/related; boundary=${boundary}` });
    return apiFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,appProperties`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    });
  }

  async function updateJsonDocument(fileId, kocon, subject, docType, data) {
    await apiFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,appProperties`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        name: documentName(kocon, subject, docType),
        appProperties: documentProperties(kocon, subject, docType)
      })
    });
    return apiFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,appProperties`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(stampDocumentType(data, docType), null, 2)
    });
  }

  async function saveJson({ kocon, subject, previousSubject, docType, data }) {
    if (CONFIG.centralBackendUrl) {
      return centralSave({ kocon, subject, previousSubject, docType, data });
    }
    requireDocType(docType);
    const normalized = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    if (!normalized && !(docType === "estimate" && normalizedSubject)) {
      throw new DriveError(docType === "estimate" ? "高コンまたは件名が空欄のため保存できません。" : "高コンが空欄のため保存できません。");
    }
    const folderId = await getDocumentFolder(docType);
    let existing = normalized ? await findDocument(normalized, docType) : null;
    if (!existing && normalizedSubject) existing = await findDocumentBySubject(normalizedSubject, docType);
    if (!existing && previousSubject && normalizeSubject(previousSubject) !== normalizedSubject) {
      existing = await findDocumentBySubject(previousSubject, docType);
    }
    if (existing) {
      try {
        return await updateJsonDocument(existing.id, normalized, normalizedSubject, docType, data);
      } catch (error) {
        if (!(error instanceof DriveError) || error.status !== 404) throw error;
      }
    }
    return createJsonDocument(normalized, normalizedSubject, docType, data, folderId);
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

  function storePending(docType, kocon, subject, previousSubject, data, json) {
    requireDocType(docType);
    const normalized = normalizeKocon(kocon);
    const normalizedSubject = normalizeSubject(subject);
    if (!normalized && !(docType === "estimate" && normalizedSubject)) return false;
    return writeJsonStorage(pendingKey(docType, normalized, normalizedSubject), {
      docType,
      kocon: normalized,
      subject: normalizedSubject,
      previousSubject: normalizeSubject(previousSubject),
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
        await saveJson({
          kocon: entry.item.kocon,
          subject: entry.item.subject,
          previousSubject: entry.item.previousSubject,
          docType: entry.item.docType,
          data
        });
        try {
          localStorage.removeItem(entry.key);
        } catch (_) {}
        results.push({ ok: true, item: entry.item });
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
    const debounceMs = options.debounceMs || 550;
    const confirmedKocons = new Set();
    const lastSavedJson = new Map();

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
      return { kocon, subject, previousSubject: activeSubject, data, json: JSON.stringify(data) };
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
                ? (docType === "estimate" ? "Dean共通Drive接続済み（高コンまたは件名を入力すると自動保存）" : "Dean共通Drive接続済み（高コンを入力すると自動保存）")
                : (docType === "estimate" ? "高コンまたは件名を入力するとDean共通Driveへ自動保存できます。" : "高コンを入力するとDean共通Driveへ自動保存できます。"),
              isConnected() ? "ok" : ""
            );
            continue;
          }
          if (!isConnected()) {
            const stored = storePending(docType, current.kocon, current.subject, current.previousSubject, current.data, current.json);
            setStatus(stored ? "Dean共通Drive未接続（端末内へ一時保存済み）" : "Dean共通Drive未接続（端末内への保存に失敗）", stored ? "" : "error");
            continue;
          }
          if (lastSavedJson.get(currentKey) === current.json) {
            removePending(docType, current.kocon, current.subject);
            continue;
          }
          setStatus(`${label}をDean共通Driveへ保存中…`);
          try {
            await saveJson({
              kocon: current.kocon,
              subject: current.subject,
              previousSubject: current.previousSubject,
              docType,
              data: current.data
            });
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
            if (!skipPagehideSave) storePending(docType, current.kocon, current.subject, current.previousSubject, current.data, current.json);
            if (error instanceof DriveError && error.status === 401) {
              connectButton.textContent = "Dean共通Driveに接続";
              setStatus("接続期限が切れました。再接続してください（端末内へ一時保存済み）", "error");
            } else {
              setStatus("保存に失敗しました。端末内へ一時保存しました", "error");
            }
            console.error("Dean central Drive autosave failed", error);
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

    async function confirmCurrentKocon({ save = true } = {}) {
      if (commitPromise) return commitPromise;
      commitPromise = (async () => {
        const next = normalizeKocon(koconInput.value);
        const previous = activeKocon;
        koconInput.value = next;

        if (next !== previous && previous) {
          const display = next ? `「${next}」` : "空欄";
          const accepted = global.confirm(`高コンを「${previous}」から${display}に変更します。現在の内容を保存して切り替えますか？`);
          if (!accepted) {
            koconInput.value = previous;
            setStatus("高コンの変更を取り消しました。");
            return false;
          }
        }

        activeKocon = next;
        if (!next) {
          setStatus(docType === "estimate"
            ? "高コンがなくても、件名でDean共通Driveへ自動保存できます。"
            : "高コンを入力するとDean共通Driveへ自動保存できます。");
          if (save && docType === "estimate" && normalizeSubject(fallbackInput && fallbackInput.value)) {
            await markDirty({ immediate: true });
          }
          return true;
        }

        if (onKoconConfirmed && !confirmedKocons.has(next)) {
          koconInput.disabled = true;
          let confirmed = false;
          try {
            confirmed = (await onKoconConfirmed({
              kocon: next,
              isConnected: isConnected(),
              setStatus
            })) !== false;
          } catch (error) {
            console.error("Kocon confirmation failed", error);
            setStatus(`${label}データの確認に失敗しました。`, "error");
          } finally {
            koconInput.disabled = false;
          }
          if (confirmed) {
            confirmedKocons.add(next);
            if (save && isConnected()) await markDirty({ immediate: true });
          }
        }

        return true;
      })().finally(() => {
        commitPromise = null;
      });
      return commitPromise;
    }

    function adoptCurrentKocon({ confirmed = false, save = true } = {}) {
      const current = normalizeKocon(koconInput.value);
      koconInput.value = current;
      activeKocon = current;
      if (confirmed && current) confirmedKocons.add(current);
      return save ? markDirty({ immediate: true }) : Promise.resolve();
    }

    function discardCurrent() {
      skipPagehideSave = true;
      clearTimeout(timer);
      saveRequested = false;
      const current = normalizeKocon(koconInput.value);
      const subject = normalizeSubject(fallbackInput && fallbackInput.value);
      removePending(docType, current, subject);
    }

    async function handleConnect() {
      setStatus("Dean共通Driveへ接続中…");
      connectButton.disabled = true;
      try {
        await connect();
        connectButton.textContent = "Dean共通Drive接続済み";
        setStatus("Dean共通Driveへ接続しました。未同期データを確認中…", "ok");
        const results = await flushPending(docType);
        const failures = results.filter(result => !result.ok);
        if (failures.length) {
          setStatus("一部の未同期データを保存できませんでした。", "error");
        } else if (results.length) {
          setStatus(`${results.length}件の未同期データを保存しました。`, "ok");
        } else {
          setStatus("Dean共通Driveへ接続済み", "ok");
        }
        await confirmCurrentKocon();
      } catch (error) {
        console.error("Dean central Drive connection failed", error);
        setStatus("Dean共通Driveへ接続できませんでした。Googleへログイン後、もう一度お試しください。", "error");
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
        throw new Error("Dean共通Drive自動保存の初期設定が不足しています。");
      }

      connectButton.disabled = true;
      prepare().then(() => {
        connectButton.disabled = false;
        if (!isConnected()) {
          connectButton.textContent = "Dean共通Driveに接続";
          setStatus("Dean共通Drive未接続");
          return;
        }
        connectButton.textContent = "Dean共通Drive接続済み";
        setStatus("Dean共通Drive接続済み。未同期データを確認中…", "ok");
        flushPending(docType).then(async results => {
          const failures = results.filter(result => !result.ok);
          if (failures.length) {
            setStatus("一部の未同期データを保存できませんでした。", "error");
          } else if (results.length) {
            setStatus(`${results.length}件の未同期${label}データを保存しました。`, "ok");
          } else {
            setStatus("Dean共通Drive接続済み", "ok");
          }
          await confirmCurrentKocon();
        }).catch(error => {
          console.error("Dean central Drive session resume failed", error);
          setStatus("接続の再開に失敗しました。接続ボタンを押してください。", "error");
          connectButton.textContent = "Dean共通Driveに接続";
        });
      }).catch(error => {
        console.error("Dean central Drive failed to initialize", error);
        setStatus("Dean共通Driveへ接続できません。Googleへログイン後、接続ボタンを押してください。", "error");
      });
      connectButton.addEventListener("click", handleConnect);

      ["change", "focusout"].forEach(eventName => {
        koconInput.addEventListener(eventName, () => confirmCurrentKocon({ save: false }));
      });
      koconInput.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        koconInput.blur();
        confirmCurrentKocon({ save: false });
      });

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
          storePending(docType, current.kocon, current.subject, current.previousSubject, current.data, current.json);
        }
      });
      return api;
    }

    const api = {
      init,
      markDirty,
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
