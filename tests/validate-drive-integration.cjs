const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const estimate = read("見積書.html");
const report = read("報告書メーカー.html");
const drive = read("google-drive.js");

function ids(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(Boolean);
}

for (const [name, html] of [["見積書.html", estimate], ["報告書メーカー.html", report]]) {
  const allIds = ids(html);
  const duplicates = [...new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index))];
  assert.deepEqual(duplicates, [], `${name}: duplicate ids: ${duplicates.join(", ")}`);
  assert.equal(allIds.filter(id => id === "mKocon").length, 1, `${name}: mKocon must appear exactly once`);
  assert.equal(allIds.filter(id => id === "estNo").length, 0, `${name}: legacy estNo input must be removed`);
  inlineScripts(html).forEach((script, index) => {
    new vm.Script(script, { filename: `${name}:inline-${index + 1}` });
  });
  assert.doesNotMatch(html, /accounts\.google\.com\/gsi\/client/);
  assert.match(html, /<script src="google-drive\.js\?v=20260730-7"><\/script>/);
}

new vm.Script(drive, { filename: "google-drive.js" });
assert.match(drive, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
assert.match(drive, /https:\/\/script\.google\.com\/macros\/s\/AKfycbwv8C_-IKb3eoQARwYuumCohba_z5Lyq4t3aKZvYPTbbtMTz3VvEhOuhnFaY-j1SODa\/exec/);
assert.match(drive, /centralSharedPin: String\(CENTRAL_OVERRIDE\.pin \|\| "ad5d1bc7"\)/);
assert.match(drive, /mode: "no-cors"/);
assert.match(drive, /centralJsonp/);
assert.match(drive, /appProperties/);
assert.match(drive, /schemaVersion/);
assert.doesNotMatch(drive, /client[_A-Z-]?secret/i);
assert.doesNotMatch(drive, /localStorage\.(?:setItem|getItem)\([^\n]*(?:access[_A-Z-]?token|client[_A-Z-]?secret)/i);
assert.match(drive, /SESSION_TOKEN_KEY/);
assert.match(drive, /global\.sessionStorage/);
assert.match(drive, /flushPending\(docType\)/);
assert.doesNotMatch(drive, /const results = await flushPending\(\)/);

const estimateApp = inlineScripts(estimate).at(-1);
const reportApp = inlineScripts(report).at(-1);
const estimateDriveCard = estimate.match(/<section class="card drive-card">[\s\S]*?<\/section>/);
const reportDriveCard = report.match(/<section class="card drive-card">[\s\S]*?<\/section>/);
assert.ok(estimateDriveCard, "estimate Drive card must exist");
assert.ok(reportDriveCard, "report Drive card must exist");
assert.match(estimateDriveCard[0], /id="mKocon"[\s\S]*id="subject"/);
assert.match(reportDriveCard[0], /id="mKocon"[\s\S]*id="subject"/);
assert.match(estimateDriveCard[0], /高コン番号・件名は上の入力欄を使用します。/);
assert.match(reportDriveCard[0], /高コン番号・件名は上の入力欄を使用します。/);
assert.doesNotMatch(estimateApp, /setInterval\s*\(/);
assert.doesNotMatch(reportApp, /setInterval\s*\(/);
assert.match(estimateApp, /docType:"estimate"/);
assert.match(reportApp, /docType:"report"/);
assert.match(estimate, /id="driveSearchEstimateBtn"/);
assert.match(report, /id="driveSearchReportBtn"/);
assert.match(estimate, /id="driveSearchModeKocon"/);
assert.match(estimate, /id="driveSearchModeSubject"/);
assert.match(report, /id="driveSearchModeKocon"/);
assert.match(report, /id="driveSearchModeSubject"/);
assert.doesNotMatch(estimate, /id="driveSearchKocon"/);
assert.doesNotMatch(estimate, /id="driveSearchSubject"/);
assert.doesNotMatch(report, /id="driveSearchKocon"/);
assert.doesNotMatch(report, /id="driveSearchSubject"/);
assert.match(report, /id="driveImportEstimateBtn"/);
assert.doesNotMatch(estimate, /id="genBtn"/);
assert.doesNotMatch(report, /id="genBtn"/);
assert.doesNotMatch(estimateApp, /\$\("genBtn"\)\.addEventListener/);
assert.doesNotMatch(reportApp, /\$\("genBtn"\)\.addEventListener/);
assert.match(estimateApp, /function scheduleLivePreview\(\)/);
assert.match(reportApp, /function scheduleLivePreview\(\)/);
assert.match(estimateApp, /liveForm\.addEventListener\("input",scheduleLivePreview\)/);
assert.match(reportApp, /liveForm\.addEventListener\("input",scheduleLivePreview\)/);
assert.match(reportApp, /replace\(\/\\n\/g,"<br>"\)/);
assert.match(estimateApp, /onKoconConfirmed:autoLoadEstimateFromDrive/);
assert.match(reportApp, /onKoconConfirmed:autoLoadReportFromDrive/);
assert.match(estimateApp, /fallbackInput:\$\("subject"\)/);
assert.match(reportApp, /fallbackInput:\$\("subject"\)/);
assert.match(estimateApp, /docType:"estimate"/);
assert.match(reportApp, /docType:"report"/);
assert.match(estimateApp, /"見積もり"\]\.join\("_"\)/);
assert.match(reportApp, /"報告書"\]\.join\("_"\)/);
assert.match(drive, /estimateFolderName: "見積もり"/);
assert.match(drive, /_kkmtDocumentType/);
assert.match(drive, /findDocumentBySubject/);
assert.match(drive, /findDocumentByEmbeddedSubject/);
assert.match(drive, /subjectKey/);
assert.match(drive, /previousSubject/);
assert.match(estimateApp, /const byKocon=\$\("driveSearchModeKocon"\)\.checked/);
assert.match(reportApp, /const byKocon=\$\("driveSearchModeKocon"\)\.checked/);
assert.match(estimateApp, /const input=\$\(byKocon\?"mKocon":"subject"\)/);
assert.match(reportApp, /const input=\$\(byKocon\?"mKocon":"subject"\)/);
assert.match(estimateApp, /\$\("driveSearchEstimateBtn"\)\.addEventListener\("click",searchEstimateFromDrive\)/);
assert.match(reportApp, /\$\("driveSearchReportBtn"\)\.addEventListener\("click",searchReportFromDrive\)/);
assert.match(estimateApp, /loadJson\(\{kocon,docType:"estimate"\}\)/);
assert.match(reportApp, /loadJson\(\{kocon,docType:"report"\}\)/);
assert.match(estimate, /<h2>高コン／見積もり番号・共通Drive<\/h2>/);
assert.match(report, /<h2>高コン／見積もり番号・共通Drive<\/h2>/);
assert.match(estimateDriveCard[0], /id="driveLoginBtn"[\s\S]*>Googleにログイン<\/a>/);
assert.match(reportDriveCard[0], /id="driveLoginBtn"[\s\S]*>Googleにログイン<\/a>/);
assert.match(estimateDriveCard[0], /target="_blank" rel="noopener"/);
assert.match(reportDriveCard[0], /target="_blank" rel="noopener"/);
assert.doesNotMatch(estimate, /\.drive-card\{\s*border-color:/);
assert.doesNotMatch(report, /\.drive-card\{\s*border-color:/);
assert.match(estimateApp, /<div class="k">見積番号<\/div><div class="v" contenteditable>\$\{esc\(\$\("mKocon"\)\.value\.trim\(\)\)\}<\/div>/);
assert.match(reportApp, /<div class="k">見積番号<\/div><div class="v" contenteditable>\$\{esc\(\$\("mKocon"\)\.value\.trim\(\)\)\}<\/div>/);
assert.match(estimateApp, /if\(!fields\.mKocon&&fields\.estNo\)fields\.mKocon=fields\.estNo/);
assert.match(reportApp, /if\(!fields\.mKocon&&fields\.estNo\)fields\.mKocon=fields\.estNo/);
assert.match(estimateApp, /const kocon=\(\$\("mKocon"\)\.value\|\|""\)\.trim\(\)/);
assert.match(reportApp, /loadJson\(\{kocon,docType:"estimate"\}\)/);
assert.match(drive, /adoptCurrentKocon\(\{ confirmed = false, save = true \} = \{\}\)/);
assert.match(drive, /confirmCurrentKocon\(\{ save = true \} = \{\}\)/);
assert.match(drive, /confirmCurrentKocon\(\{ save: false \}\)/);
assert.match(drive, /if \(save && isConnected\(\)\) await markDirty\(\{ immediate: true \}\)/);
assert.match(drive, /isKoconTarget\(target\) \|\| isFallbackTarget\(target\) \|\| isSearchTarget\(target\)/);
assert.match(drive, /root\.addEventListener\("input"/);
assert.match(estimateApp, /function autosaveFromEvent\(event\)\{ const id=event&&event\.target&&event\.target\.id; if\(id==="mKocon"\|\|id==="subject"\)return; autosave\(\); \}/);
assert.match(reportApp, /function autosaveFromEvent\(event\)\{ const id=event&&event\.target&&event\.target\.id; if\(id==="mKocon"\|\|id==="subject"\)return; autosave\(\); \}/);
assert.match(estimateApp, /_app\.addEventListener\("input",autosaveFromEvent\); _app\.addEventListener\("change",autosaveFromEvent\)/);
assert.match(reportApp, /_app\.addEventListener\("input",autosaveFromEvent\); _app\.addEventListener\("change",autosaveFromEvent\)/);
assert.match(estimate, /google-drive\.js\?v=20260730-7/);
assert.match(report, /google-drive\.js\?v=20260730-7/);

const sectionSeven = report.match(/<h2><span class="n">7<\/span>[\s\S]*?<\/section>/);
assert.ok(sectionSeven, "report section 7 must exist");
assert.doesNotMatch(sectionSeven[0], /id="mKocon"/);

console.log("Google Drive integration checks passed.");
