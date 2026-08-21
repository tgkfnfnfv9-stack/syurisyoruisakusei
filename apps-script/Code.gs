/**
 * 小林機械 書類データ共通バックエンド
 *
 * Webアプリとして「次のユーザーとして実行: 自分」で公開します。
 * すべての見積もり・報告書は、このスクリプトを公開したアカウントの
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
  try {
    return jsonResponse_(handleRequest_(parseRequest_(event)));
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
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

function documentRevision_(data) {
  const value = Number(data && data._kkmtRevision);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validateDocumentData_(data, docType, kocon, subject) {
  const type = requireDocType_(docType);
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      !data.fields || typeof data.fields !== "object" || Array.isArray(data.fields)) {
    throw new Error("保存データの必須項目が不足しています。");
  }
  const dataType = String(data.documentType || data._kkmtDocumentType || "");
  if (dataType && dataType !== type) throw new Error("別の種類の書類データは保存できません。");
  if (type === "report" && !Array.isArray(data.work)) throw new Error("報告書の作業データが不足しています。");
  const arrays = type === "report"
    ? ["parts","customs","lodges","work","workers","activeWorkers"]
    : ["parts","customs","lodges","wdays"];
  arrays.forEach(function (key) {
    if (key in data && !Array.isArray(data[key])) throw new Error(key + " の形式が正しくありません。");
  });
  const fieldsKocon = normalize_(data.fields.mKocon || data.fields.estNo);
  const fieldsSubject = normalize_(data.fields.subject);
  if (normalize_(kocon) !== fieldsKocon) throw new Error("高コン番号と保存データが一致しません。");
  if (normalize_(subject) && normalize_(subject) !== fieldsSubject) throw new Error("件名と保存データが一致しません。");
  if (type === "report" && "signature" in data) {
    const signature = data.signature || "";
    if (typeof signature !== "string" || signature.length > 5000000 ||
        (signature && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(signature))) {
      throw new Error("サイン画像の形式または容量が正しくありません。");
    }
  }
  return data;
}

function stampDocument_(data, docType, revision) {
  const stamped = data && typeof data === "object" && !Array.isArray(data)
    ? Object.assign({}, data)
    : { value: data };
  stamped._kkmtDocumentType = requireDocType_(docType);
  if (revision != null) {
    stamped._kkmtRevision = revision;
    stamped._kkmtUpdatedAt = new Date().toISOString();
  }
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
    return byKocon || null;
  }
  if (normalizedSubject) {
    const matches = documents.filter(function (document) {
      return document.subject === normalizedSubject;
    });
    return matches.find(function (document) { return !document.kocon; }) || matches[0] || null;
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
  validateDocumentData_(request.data, docType, kocon, subject);
  if (!kocon && !(docType === "estimate" && subject)) {
    throw new Error(docType === "estimate"
      ? "高コンまたは件名が空欄のため保存できません。"
      : "高コンが空欄のため保存できません。");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const folder = getDocumentFolder_(docType);
    let existing = kocon
      ? findDocument_(docType, kocon, "")
      : null;
    if (!existing && subject) {
      const bySubject = findDocument_(docType, "", subject);
      if (bySubject && !bySubject.kocon) existing = bySubject;
    }
    if (!existing && previousSubject && previousSubject !== subject) {
      const byPreviousSubject = findDocument_(docType, "", previousSubject);
      if (byPreviousSubject && !byPreviousSubject.kocon) existing = byPreviousSubject;
    }
    const expectedRevisionValue = Number(request.expectedRevision);
    const hasExpectedRevision = request.expectedRevision != null ||
      !!(request.data && typeof request.data === "object" && Object.prototype.hasOwnProperty.call(request.data, "_kkmtRevision"));
    const existingRevision = existing ? documentRevision_(existing.data) : 0;
    if (!hasExpectedRevision && existingRevision > 0) {
      throw new Error("CONFLICT: 旧形式の保存データは、最新版を読み込むまで上書きできません。");
    }
    const expectedRevision = hasExpectedRevision
      ? (Number.isSafeInteger(expectedRevisionValue) && expectedRevisionValue >= 0 ? expectedRevisionValue : documentRevision_(request.data))
      : 0;
    if ((existing && existingRevision !== expectedRevision) || (!existing && expectedRevision !== 0)) {
      throw new Error("CONFLICT: 他の端末で更新されています。最新データを読み込んでください。");
    }
    const nextRevision = expectedRevision + 1;
    const stamped = stampDocument_(request.data, docType, nextRevision);
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
      revision: nextRevision,
      updatedAt: stamped._kkmtUpdatedAt
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
