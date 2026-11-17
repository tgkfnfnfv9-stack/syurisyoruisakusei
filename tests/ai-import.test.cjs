const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const window = { location: { search: "" }, document: {} };
window.window = window;
vm.runInNewContext(fs.readFileSync(path.join(root, "ai-import.js"), "utf8"), { window, URLSearchParams });
const { parseAiJson } = window.KKMTAiImport;

test("AIの返答からJSONを取り出す（フェンス・前後の説明文・data包み）", () => {
  assert.equal(parseAiJson('{"fields":{"subject":"A"}}').fields.subject, "A");
  assert.equal(parseAiJson('```json\n{"fields":{"subject":"B"}}\n```').fields.subject, "B");
  assert.equal(parseAiJson('はい、こちらです。\n{"fields":{"subject":"C"}}\nご確認ください。').fields.subject, "C");
  assert.equal(parseAiJson('{"data":{"fields":{"subject":"D"}}}').fields.subject, "D");
  assert.throws(() => parseAiJson(""), /貼り付けられていません/);
  assert.throws(() => parseAiJson('{"fields": {,}'), /形式が正しくありません/);
  assert.throws(() => parseAiJson("[1,2]"), /JSONの形式ではありません/);
  assert.throws(() => parseAiJson("こんにちは"), /JSONの形式ではありません/);
});

test("両ツールにAI取込ボタン・?ai=1・説明書があり、説明書のサンプルは正しいJSON", () => {
  for (const file of ["見積書.html", "報告書メーカー.html"]) {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(html, /id="aiBtn"[^>]*>🤖 AI取込</);
    assert.match(html, /<script src="ai-import\.js/);
    assert.match(html, /KKMTAiImport\.create\(/);
  }
  const md = fs.readFileSync(path.join(root, "AI_SCHEMA.md"), "utf8");
  const samples = [...md.matchAll(/```json\n(\{[\s\S]*?)```/g)].map(m => JSON.parse(m[1]));
  const estimate = samples.find(s => s.documentType === "estimate");
  const report = samples.find(s => s.documentType === "report");
  assert.ok(estimate && Array.isArray(estimate.wdays) && estimate.fields.subject);
  assert.ok(report && Array.isArray(report.work) && report.work[0].people[0].worker);
  for (const sample of [estimate, report]) assert.equal("workFee" in sample.fields, false, "サンプルは金額を入れない");
});
