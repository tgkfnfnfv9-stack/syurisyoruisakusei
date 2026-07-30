/**
 * 小林機械 書類データ共通バックエンド
 *
 * Webアプリとして「次のユーザーとして実行: 自分（Dean）」で公開します。
 * すべての見積もり・報告書は、このスクリプトを公開したDeanアカウントの
 * Google Driveに保存されます。
 */

const KKMT_CONFIG = Object.freeze({
  sharedPin: "ad5d1bc7",
  rootFolderName: "小林機械 書類データ",
  estimateFolderName: "見積もり",
  reportFolderName: "報告書",
  schemaVersion: "2"
});

function doGet(event) {
  const request = event && event.parameter ? event.parameter : {};
  if (!request.action) {
    return jsonResponse_({
      ok: true,
      service: "小林機械 書類データ共通バックエンド",
      message: "アプリから接続してください。"
    });
  }
  const response = handleRequest_(request);
  return request.callback ? jsonpResponse_(request.callback, response) : jsonResponse_(response);
}

function doPost(event) {
  return jsonResponse_(handleRequest_(parseRequest_(event)));
}

function handleRequest_(request) {
  try {
    verifyPin_(request.pin);
    const action = String(request.action || "");

    if (action === "ping") {
      return { ok: true, result: { connected: true } };
    }
    if (action === "save") {
      return { ok: true, result: saveDocument_(request) };
    }
    if (action === "load") {
      return { ok: true, result: loadDocument_(request) };
    }
    throw new Error("不明な操作です。");
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function parseRequest_(event) {
  if (!event || !event.postData || !event.postData.contents) {
    throw new Error("リクエストが空です。");
  }
  try {
    return JSON.parse(event.postData.contents);
  } catch (_) {
    throw new Error("リクエストを読み取れません。");
  }
}

function verifyPin_(pin) {
  if (String(pin || "") !== KKMT_CONFIG.sharedPin) {
    throw new Error("共通PINが正しくありません。");
  }
}

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonpResponse_(callback, value) {
  const name = String(callback || "");
  if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(name)) {
    return jsonResponse_({ ok: false, error: "コールバック名が正しくありません。" });
  }
  return ContentService
    .createTextOutput(name + "(" + JSON.stringify(value) + ");")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function normalize_(value) {
  return String(value == null ? "" : value).trim();
}

function safeFileSegment_(value) {
  return normalize_(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function requireDocType_(docType) {
  const normalized = String(docType || "");
  if (normalized !== "estimate" && normalized !== "report") {
    throw new Error("不明な書類種別です。");
  }
  return normalized;
}

function getOrCreateFolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function getDocumentFolder_(docType) {
  const type = requireDocType_(docType);
  const root = getOrCreateFolder_(DriveApp.getRootFolder(), KKMT_CONFIG.rootFolderName);
  return getOrCreateFolder_(
    root,
    type === "estimate" ? KKMT_CONFIG.estimateFolderName : KKMT_CONFIG.reportFolderName
  );
}

function stampDocument_(data, docType) {
  const stamped = data && typeof data === "object" && !Array.isArray(data)
    ? Object.assign({}, data)
    : { value: data };
  stamped._kkmtDocumentType = requireDocType_(docType);
  return stamped;
}

function identityFromData_(data) {
  const fields = data && data.fields && typeof data.fields === "object" ? data.fields : {};
  return {
    kocon: normalize_(fields.mKocon || fields.estNo),
    subject: normalize_(fields.subject)
  };
}

function readFileData_(file) {
  try {
    return JSON.parse(file.getBlob().getDataAsString("UTF-8"));
  } catch (_) {
    return null;
  }
}

function listDocuments_(docType) {
  const folder = getDocumentFolder_(docType);
  const files = folder.getFiles();
  const documents = [];
  while (files.hasNext()) {
    const file = files.next();
    if (!/\.json$/i.test(file.getName())) continue;
    const data = readFileData_(file);
    if (!data) continue;
    const stampedType = normalize_(data._kkmtDocumentType);
    if (stampedType && stampedType !== docType) continue;
    const identity = identityFromData_(data);
    documents.push({
      file: file,
      data: data,
      kocon: identity.kocon,
      subject: identity.subject,
      updatedAt: file.getLastUpdated().getTime()
    });
  }
  return documents.sort(function (a, b) {
    return b.updatedAt - a.updatedAt;
  });
}

function findDocument_(docType, kocon, subject) {
  const normalizedKocon = normalize_(kocon);
  const normalizedSubject = normalize_(subject);
  const documents = listDocuments_(docType);
  if (normalizedKocon) {
    const byKocon = documents.find(function (document) {
      return document.kocon === normalizedKocon;
    });
    if (byKocon) return byKocon;
  }
  if (normalizedSubject) {
    return documents.find(function (document) {
      return document.subject === normalizedSubject;
    }) || null;
  }
  return null;
}

function documentName_(kocon, subject, docType) {
  const normalizedKocon = normalize_(kocon);
  const normalizedSubject = safeFileSegment_(subject);
  if (docType === "estimate") {
    return [
      normalizedKocon ? "高コン" + normalizedKocon : "",
      normalizedSubject,
      "見積もり"
    ].filter(Boolean).join("_") + ".json";
  }
  return "高コン" + normalizedKocon + "_報告書.json";
}

function saveDocument_(request) {
  const docType = requireDocType_(request.docType);
  const kocon = normalize_(request.kocon);
  const subject = normalize_(request.subject);
  const previousSubject = normalize_(request.previousSubject);
  if (!kocon && !(docType === "estimate" && subject)) {
    throw new Error(docType === "estimate"
      ? "高コンまたは件名が空欄のため保存できません。"
      : "高コンが空欄のため保存できません。");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const folder = getDocumentFolder_(docType);
    let existing = findDocument_(docType, kocon, subject);
    if (!existing && previousSubject && previousSubject !== subject) {
      existing = findDocument_(docType, "", previousSubject);
    }
    const stamped = stampDocument_(request.data, docType);
    const json = JSON.stringify(stamped, null, 2);
    const name = documentName_(kocon, subject, docType);
    let file;
    if (existing) {
      file = existing.file;
      file.setName(name);
      file.setContent(json);
    } else {
      file = folder.createFile(name, json, MimeType.PLAIN_TEXT);
    }
    return {
      id: file.getId(),
      name: file.getName(),
      updatedAt: new Date().toISOString()
    };
  } finally {
    lock.releaseLock();
  }
}

function loadDocument_(request) {
  const docType = requireDocType_(request.docType);
  const kocon = normalize_(request.kocon);
  const subject = normalize_(request.subject);
  if (!kocon && !subject) throw new Error("検索条件が空です。");
  const existing = findDocument_(docType, kocon, subject);
  return existing ? existing.data : null;
}
