const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const window = { location: { search: "" }, document: {} };
window.window = window;
window.atob = atob;
window.TextDecoder = TextDecoder;
vm.runInNewContext(fs.readFileSync(path.join(root, "ai-import.js"), "utf8"), { window, URLSearchParams, Uint8Array });
const { parseAiJson, decodeLinkPayload, makeLink } = window.KKMTAiImport;

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

test("AIが作ったリンク（#ai=）のデータを読める：encodeURIComponent・base64url・生JSON・返答文中のリンク", () => {
  const data = { documentType: "estimate", fields: { subject: "研磨機 クラッチ+交換 50%", client: "岡機械" }, wdays: [{ people: "2", hours: "7" }] };
  const json = JSON.stringify(data);
  const link = makeLink("https://example.com/見積書.html#old", data);
  assert.match(link, /^https:\/\/example\.com\/見積書\.html#ai=%7B/);
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(parseAiJson(link)), data, "リンクを貼り付けても読める");
  assert.deepEqual(plain(parseAiJson("できました！\n" + link + "\nタップしてください")), data);
  assert.deepEqual(JSON.parse(decodeLinkPayload(encodeURIComponent(json))), data);
  assert.deepEqual(JSON.parse(decodeLinkPayload(Buffer.from(json).toString("base64url"))), data);
  assert.deepEqual(JSON.parse(decodeLinkPayload(json)), data);
  assert.throws(() => decodeLinkPayload("%%%not-base64%%%"), /読み取れません/);
});
