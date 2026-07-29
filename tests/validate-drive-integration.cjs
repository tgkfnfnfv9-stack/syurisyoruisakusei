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
  assert.match(html, /accounts\.google\.com\/gsi\/client/);
  assert.match(html, /<script src="google-drive\.js"><\/script>/);
}

new vm.Script(drive, { filename: "google-drive.js" });
assert.match(drive, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
assert.match(drive, /appProperties/);
assert.match(drive, /schemaVersion/);
assert.doesNotMatch(drive, /client[_A-Z-]?secret/i);
assert.doesNotMatch(drive, /localStorage\.(?:setItem|getItem)\([^\n]*(?:access[_A-Z-]?token|client[_A-Z-]?secret)/i);

const estimateApp = inlineScripts(estimate).at(-1);
const reportApp = inlineScripts(report).at(-1);
assert.doesNotMatch(estimateApp, /setInterval\s*\(/);
assert.doesNotMatch(reportApp, /setInterval\s*\(/);
assert.match(estimateApp, /docType:"estimate"/);
assert.match(reportApp, /docType:"report"/);
assert.match(estimateApp, /<div class="k">高コン<\/div><div class="v" contenteditable>\$\{esc\(\$\("mKocon"\)\.value\.trim\(\)\)\}<\/div>/);
assert.match(reportApp, /<div class="k">高コン<\/div><div class="v" contenteditable>\$\{esc\(\$\("mKocon"\)\.value\.trim\(\)\)\}<\/div>/);
assert.match(estimateApp, /if\(!fields\.mKocon&&fields\.estNo\)fields\.mKocon=fields\.estNo/);
assert.match(reportApp, /if\(!fields\.mKocon&&fields\.estNo\)fields\.mKocon=fields\.estNo/);
assert.match(estimateApp, /const kocon=\(\$\("mKocon"\)\.value\|\|""\)\.trim\(\)/);
assert.match(reportApp, /loadJson\(\{kocon,docType:"estimate"\}\)/);
assert.doesNotMatch(reportApp, /loadJson\(\{kocon,docType:"report"\}\)/);

const sectionSeven = report.match(/<h2><span class="n">7<\/span>[\s\S]*?<\/section>/);
assert.ok(sectionSeven, "report section 7 must exist");
assert.doesNotMatch(sectionSeven[0], /id="mKocon"/);

console.log("Google Drive integration checks passed.");
