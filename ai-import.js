(function (global) {
  "use strict";
  const doc = global.document;

  // AIの返答から JSON 部分だけを取り出す（```json フェンスや前後の説明文があっても読める）。
  function parseAiJson(text) {
    let raw = String(text == null ? "" : text).trim();
    if (!raw) throw new Error("JSONが貼り付けられていません。");
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let data;
    try { data = JSON.parse(raw); }
    catch (_) {
      const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("JSONの形式ではありません。AIの返答のJSON部分を貼り付けてください。");
      try { data = JSON.parse(raw.slice(start, end + 1)); }
      catch (_) { throw new Error("JSONの形式が正しくありません（カッコや「,」の抜けなど）。AIにもう一度JSONだけを出力してもらってください。"); }
    }
    if (data && typeof data === "object" && !Array.isArray(data) && !data.fields && data.data && typeof data.data === "object") data = data.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("JSONの形式ではありません。");
    return data;
  }

  async function copyText(text) {
    try {
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) { await global.navigator.clipboard.writeText(text); return true; }
    } catch (_) {}
    const area = doc.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.cssText = "position:fixed;left:-9999px;top:0";
    doc.body.appendChild(area); area.select();
    let ok = false; try { ok = doc.execCommand("copy"); } catch (_) {}
    area.remove(); return ok;
  }

  // options: { button, title, note, placeholder, promptText, apply(data) => Promise }
  function create(options) {
    let dialog = null;
    function close() {
      if (!dialog) return;
      dialog.remove(); dialog = null;
      if (options.button && options.button.focus) options.button.focus();
    }
    function open() {
      if (dialog) return;
      dialog = doc.createElement("dialog");
      dialog.className = "document-export ai-import";
      dialog.setAttribute("aria-labelledby", "ai-import-title");
      const heading = doc.createElement("h2"); heading.id = "ai-import-title"; heading.textContent = options.title;
      const note = doc.createElement("p"); note.textContent = options.note;
      const copy = doc.createElement("button"); copy.type = "button"; copy.textContent = "AIへの指示文をコピー";
      const area = doc.createElement("textarea"); area.className = "ai-import-text"; area.placeholder = options.placeholder || "{ ... }";
      area.setAttribute("aria-label", "AIが作成したJSON"); area.spellcheck = false;
      const error = doc.createElement("p"); error.className = "ai-import-error"; error.setAttribute("role", "alert");
      const apply = doc.createElement("button"); apply.type = "button"; apply.className = "export-primary"; apply.textContent = "取り込む";
      const cancel = doc.createElement("button"); cancel.type = "button"; cancel.textContent = "キャンセル";
      const actions = doc.createElement("div"); actions.className = "export-actions"; actions.append(apply, copy);
      dialog.append(heading, note, area, error, actions, cancel);
      doc.body.appendChild(dialog);
      copy.addEventListener("click", async () => {
        const ok = await copyText(options.promptText);
        error.textContent = ok ? "指示文をコピーしました。AIに貼り付け、内容（日付・場所・人数など）を書き足して送ってください。" : "コピーできませんでした。";
        error.classList.toggle("ok", ok);
      });
      apply.addEventListener("click", async () => {
        error.textContent = ""; error.classList.remove("ok");
        let data;
        try { data = parseAiJson(area.value); }
        catch (e) { error.textContent = e.message; return; }
        apply.disabled = true; apply.textContent = "取り込み中…";
        try { await options.apply(data); close(); }
        catch (e) { error.textContent = "取り込めませんでした：" + (e && e.message || "形式をご確認ください。"); }
        finally { if (dialog) { apply.disabled = false; apply.textContent = "取り込む"; } }
      });
      cancel.addEventListener("click", close);
      dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
      area.focus();
    }
    if (options.button) options.button.addEventListener("click", open);
    try { if (new URLSearchParams(global.location.search).get("ai") === "1") open(); } catch (_) {}
    return { open, close };
  }

  global.KKMTAiImport = { create, parseAiJson };
})(window);
