(function (global) {
  "use strict";

  const CONFIG = Object.freeze({
    clientId: "568409413492-30m6042kemj3vrt2hog6joh2g2p7lcei.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.file",
    rootFolderName: "小林機械 書類データ",
    estimateFolderName: "見積書",
    reportFolderName: "報告書",
    schemaVersion: "1"
  });

  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const FOLDER_CACHE_KEY = "kkmt_drive_folder_ids_v1";
  const PENDING_PREFIX = "kkmt_drive_pending_";
  const SESSION_TOKEN_KEY = "kkmt_drive_session_token_v1";

  let accessToken = "";
  let accessTokenExpiresAt = 0;
  let tokenClient = null;
  let preparePromise = null;
  let connectPromise = null;
  let connectResolve = null;
  let connectReject = null;

  class DriveError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "DriveError";
      this.status = status || 0;
    }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalizeKocon = value => String(value == null ? "" : value).trim();
  const escapeQuery = value => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const pendingKey = (docType, kocon) =>
    `${PENDING_PREFIX}${docType}_${encodeURIComponent(normalizeKocon(kocon))}`;

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

  async function prepare() {
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

  function connect() {
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
    if (!["estimate", "report"].includes(docType)) throw new DriveError("不明な書類種別です。");
    const rootId = await resolveFolder("root", CONFIG.rootFolderName, "root");
    const name = docType === "estimate" ? CONFIG.estimateFolderName : CONFIG.reportFolderName;
    return resolveFolder(docType, name, rootId);
  }

  async function findDocument(kocon, docType) {
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

  function documentName(kocon, docType) {
    return `高コン${normalizeKocon(kocon)}_${docType === "estimate" ? "見積書" : "報告書"}.json`;
  }

  async function createJsonDocument(kocon, docType, data, folderId) {
    const metadata = {
      name: documentName(kocon, docType),
      parents: [folderId],
      mimeType: "application/json",
      appProperties: {
        kocon: normalizeKocon(kocon),
        docType,
        schemaVersion: CONFIG.schemaVersion
      }
    };
    const boundary = `kkmt_drive_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      JSON.stringify(data, null, 2),
      `\r\n--${boundary}--`
    ], { type: `multipart/related; boundary=${boundary}` });
    return apiFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,appProperties`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    });
  }

  async function updateJsonDocument(fileId, data) {
    return apiFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,appProperties`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(data, null, 2)
    });
  }

  async function saveJson({ kocon, docType, data }) {
    const normalized = normalizeKocon(kocon);
    if (!normalized) throw new DriveError("高コンが空欄のため保存できません。");
    const folderId = await getDocumentFolder(docType);
    const existing = await findDocument(normalized, docType);
    if (existing) {
      try {
        return await updateJsonDocument(existing.id, data);
      } catch (error) {
        if (!(error instanceof DriveError) || error.status !== 404) throw error;
      }
    }
    return createJsonDocument(normalized, docType, data, folderId);
  }

  async function loadJson({ kocon, docType }) {
    const file = await findDocument(kocon, docType);
    if (!file) return null;
    const result = await apiFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`);
    if (typeof result === "string") {
      try {
        return JSON.parse(result);
      } catch (_) {
        throw new DriveError("Drive上のJSONデータを読み取れませんでした。");
      }
    }
    return result;
  }

  function storePending(docType, kocon, data, json) {
    const normalized = normalizeKocon(kocon);
    if (!normalized) return false;
    return writeJsonStorage(pendingKey(docType, normalized), {
      docType,
      kocon: normalized,
      json: json || JSON.stringify(data),
      updatedAt: new Date().toISOString()
    });
  }

  function removePending(docType, kocon) {
    try {
      localStorage.removeItem(pendingKey(docType, kocon));
    } catch (_) {}
  }

  function getPendingItems(docTypeFilter) {
    const items = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(PENDING_PREFIX)) continue;
        const item = readJsonStorage(key, null);
        if (item && item.kocon && ["estimate", "report"].includes(item.docType) &&
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
    const statusElement = options.statusElement;
    const connectButton = options.connectButton;
    const collectState = options.collectState;
    const onKoconConfirmed = options.onKoconConfirmed;
    const debounceMs = options.debounceMs || 550;
    const confirmedKocons = new Set();
    const lastSavedJson = new Map();

    let activeKocon = normalizeKocon(koconInput && koconInput.value);
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
      const data = collectState();
      return { kocon, data, json: JSON.stringify(data) };
    }

    async function saveLoop() {
      if (savingPromise) return savingPromise;
      savingPromise = (async () => {
        while (saveRequested) {
          saveRequested = false;
          const current = snapshot();
          if (!current.kocon) {
            setStatus(
              isConnected()
                ? "Google Drive接続済み（高コンを入力すると自動保存）"
                : "高コンを入力するとGoogle Driveへ自動保存できます。",
              isConnected() ? "ok" : ""
            );
            continue;
          }
          if (!isConnected()) {
            const stored = storePending(docType, current.kocon, current.data, current.json);
            setStatus(stored ? "Google Drive未接続（端末内へ一時保存済み）" : "Google Drive未接続（端末内への保存に失敗）", stored ? "" : "error");
            continue;
          }
          if (lastSavedJson.get(current.kocon) === current.json) {
            removePending(docType, current.kocon);
            continue;
          }
          setStatus(`${label}をGoogle Driveへ保存中…`);
          try {
            await saveJson({ kocon: current.kocon, docType, data: current.data });
            lastSavedJson.set(current.kocon, current.json);
            removePending(docType, current.kocon);
            const time = new Intl.DateTimeFormat("ja-JP", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit"
            }).format(new Date());
            setStatus(`${label}を自動保存しました ${time}`, "ok");
          } catch (error) {
            if (!skipPagehideSave) storePending(docType, current.kocon, current.data, current.json);
            if (error instanceof DriveError && error.status === 401) {
              connectButton.textContent = "Google Driveに接続";
              setStatus("接続期限が切れました。再接続してください（端末内へ一時保存済み）", "error");
            } else {
              setStatus("保存に失敗しました。端末内へ一時保存しました", "error");
            }
            console.error("Google Drive autosave failed", error);
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

    async function confirmCurrentKocon() {
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
          setStatus("高コンを入力するとGoogle Driveへ自動保存できます。");
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
            setStatus("見積書データの確認に失敗しました。", "error");
          } finally {
            koconInput.disabled = false;
          }
          if (confirmed) confirmedKocons.add(next);
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
      if (current) removePending(docType, current);
    }

    async function handleConnect() {
      setStatus("Google Driveへ接続中…");
      connectButton.disabled = true;
      try {
        await connect();
        connectButton.textContent = "Google Drive接続済み";
        setStatus("Google Driveへ接続しました。未同期データを確認中…", "ok");
        const results = await flushPending(docType);
        const failures = results.filter(result => !result.ok);
        if (failures.length) {
          setStatus("一部の未同期データを保存できませんでした。", "error");
        } else if (results.length) {
          setStatus(`${results.length}件の未同期データを保存しました。`, "ok");
        } else {
          setStatus("Google Driveへ接続済み", "ok");
        }
        await confirmCurrentKocon();
      } catch (error) {
        console.error("Google Drive connection failed", error);
        setStatus("Google Driveへ接続できませんでした。もう一度お試しください。", "error");
      } finally {
        connectButton.disabled = false;
      }
    }

    function isKoconTarget(target) {
      return target === koconInput;
    }

    function init() {
      if (!koconInput || !connectButton || typeof collectState !== "function") {
        throw new Error("Google Drive自動保存の初期設定が不足しています。");
      }

      connectButton.disabled = true;
      prepare().then(() => {
        connectButton.disabled = false;
        if (!isConnected()) {
          connectButton.textContent = "Google Driveに接続";
          setStatus("Google Drive未接続");
          return;
        }
        connectButton.textContent = "Google Drive接続済み";
        setStatus("Google Drive接続済み。未同期データを確認中…", "ok");
        flushPending(docType).then(async results => {
          const failures = results.filter(result => !result.ok);
          if (failures.length) {
            setStatus("一部の未同期データを保存できませんでした。", "error");
          } else if (results.length) {
            setStatus(`${results.length}件の未同期${label}データを保存しました。`, "ok");
          } else {
            setStatus("Google Drive接続済み", "ok");
          }
          await confirmCurrentKocon();
        }).catch(error => {
          console.error("Google Drive session resume failed", error);
          setStatus("接続の再開に失敗しました。接続ボタンを押してください。", "error");
          connectButton.textContent = "Google Driveに接続";
        });
      }).catch(error => {
        console.error("Google Identity Services failed to load", error);
        setStatus("Google認証を準備できませんでした。ページを再読み込みしてください。", "error");
      });
      connectButton.addEventListener("click", handleConnect);

      ["change", "focusout"].forEach(eventName => {
        koconInput.addEventListener(eventName, confirmCurrentKocon);
      });
      koconInput.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        koconInput.blur();
        confirmCurrentKocon();
      });

      root.addEventListener("change", event => {
        const target = event.target;
        if (isKoconTarget(target) || target.type === "file") return;
        if (target.matches("input,select,textarea")) markDirty();
      });
      root.addEventListener("focusout", event => {
        const target = event.target;
        if (isKoconTarget(target)) return;
        if (target.matches("input[type='text'],input[type='number'],input[type='date'],input[type='time'],textarea,[contenteditable='true']")) {
          markDirty();
        }
      });
      root.addEventListener("keydown", event => {
        const target = event.target;
        if (event.key === "Enter" && !isKoconTarget(target) && target.matches("input[type='text'],input[type='number']")) {
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
        if (current.kocon && lastSavedJson.get(current.kocon) !== current.json) {
          storePending(docType, current.kocon, current.data, current.json);
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
