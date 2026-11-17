(function (global) {
  "use strict";
  const doc = global.document;
  const HASH_KEY = "ai";

  function utf8FromBase64(text) {
    let b64 = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    while (b64.length % 4) b64 += "=";
    const binary = global.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new global.TextDecoder("utf-8").decode(bytes);
  }

  // リンクの「#ai=」以降を JSON 文字列に戻す。encodeURIComponent・base64url・生のJSONのどれでも読める。
  function decodeLinkPayload(payload) {
    let text = String(payload == null ? "" : payload).trim();
    if (!text) throw new Error("リンクにデータが入っていません。");
    try { text = decodeURIComponent(text); } catch (_) {}
    text = text.trim();
    if (text.startsWith("{")) return text;
    try { return utf8FromBase64(text); }
    catch (_) { throw new Error("リンクのデータを読み取れません。AIにもう一度リンクを作ってもらうか、JSONを貼り付けてください。"); }
  }

  function payloadFromLink(text) {
    const match = /[#&]ai=([^\s#&]+)/.exec(String(text || ""));
    return match && match[1] !== "1" ? match[1] : null;
  }

  // AIの返答から JSON を取り出す（```json フェンス・前後の説明文・data包み・AIが作ったリンクのどれでも読める）。
  function parseAiJson(text) {
    let raw = String(text == null ? "" : text).trim();
    if (!raw) throw new Error("JSONが貼り付けられていません。");
    if (!raw.startsWith("{")) {
      const linked = payloadFromLink(raw);
      if (linked) raw = decodeLinkPayload(linked);
    }
    raw = raw.replace(/^[\s\S]*?```(?:json)?\s*(?=\{)/i, "").replace(/\s*```[\s\S]*$/, "").trim();
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

  // ツールのURLにデータを付けたリンクを作る（テスト・手動作成用）。
  function makeLink(baseUrl, data) {
    return String(baseUrl).split("#")[0] + "#" + HASH_KEY + "=" + encodeURIComponent(JSON.stringify(data));
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

  // options: { button, title, note, placeholder, promptText, apply(data) => Promise, hasInput() => boolean }
  function create(options) {
    let dialog = null;
    function close() {
      if (!dialog) return;
      dialog.remove(); dialog = null;
      if (options.button && options.button.focus) options.button.focus();
    }
    function open(initialError) {
      if (dialog) return;
      dialog = doc.createElement("dialog");
      dialog.className = "document-export ai-import";
      dialog.setAttribute("aria-labelledby", "ai-import-title");
      const heading = doc.createElement("h2"); heading.id = "ai-import-title"; heading.textContent = options.title;
      const note = doc.createElement("p"); note.textContent = options.note;
      const clip = doc.createElement("button"); clip.type = "button"; clip.className = "export-primary"; clip.textContent = "📋 コピーしたAIの返答を取り込む";
      const area = doc.createElement("textarea"); area.className = "ai-import-text"; area.placeholder = options.placeholder || "{ ... }";
      area.setAttribute("aria-label", "AIが作成したJSON"); area.spellcheck = false;
      const error = doc.createElement("p"); error.className = "ai-import-error"; error.setAttribute("role", "alert");
      const apply = doc.createElement("button"); apply.type = "button"; apply.textContent = "貼り付けた内容を取り込む";
      const copy = doc.createElement("button"); copy.type = "button"; copy.textContent = "AIへの指示文をコピー";
      const cancel = doc.createElement("button"); cancel.type = "button"; cancel.textContent = "キャンセル";
      const or = doc.createElement("p"); or.className = "ai-import-or"; or.textContent = "または、下に貼り付け";
      const actions = doc.createElement("div"); actions.className = "export-actions"; actions.append(apply, copy);
      dialog.append(heading, note, clip, or, area, error, actions, cancel);
      doc.body.appendChild(dialog);
      const say = (message, ok) => { error.textContent = message || ""; error.classList.toggle("ok", !!ok); };
      async function run(text, busyButton, label) {
        say("");
        let data;
        try { data = parseAiJson(text); }
        catch (e) { say(e.message); return; }
        busyButton.disabled = true; busyButton.textContent = "取り込み中…";
        try { await options.apply(data); close(); }
        catch (e) { say("取り込めませんでした：" + (e && e.message || "形式をご確認ください。")); }
        finally { if (dialog) { busyButton.disabled = false; busyButton.textContent = label; } }
      }
      clip.addEventListener("click", async () => {
        let text = "";
        try {
          if (!global.navigator.clipboard || !global.navigator.clipboard.readText) throw new Error("unsupported");
          text = await global.navigator.clipboard.readText();
        } catch (_) {
          say("クリップボードを読めませんでした。AIの返答を下の欄に貼り付けて「貼り付けた内容を取り込む」を押してください。");
          area.focus(); return;
        }
        if (!text.trim()) { say("クリップボードが空です。AIの返答（JSONまたはリンク）をコピーしてから押してください。"); return; }
        area.value = text;
        await run(text, clip, "📋 コピーしたAIの返答を取り込む");
      });
      apply.addEventListener("click", () => run(area.value, apply, "貼り付けた内容を取り込む"));
      copy.addEventListener("click", async () => {
        const ok = await copyText(options.promptText);
        say(ok ? "指示文をコピーしました。AIに貼り付け、内容（日付・場所・人数など）を書き足して送ってください。返ってきたリンクを押せば完成です。" : "コピーできませんでした。", ok);
      });
      cancel.addEventListener("click", close);
      dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
      if (initialError) say(initialError);
    }

    // AIが作ったリンク（…#ai=データ）で開かれたら、そのまま取り込む。
    async function importFromLocation() {
      let payload = null;
      try { payload = payloadFromLink(global.location.hash); } catch (_) {}
      if (!payload) return false;
      // 再読み込みで二重に取り込まないよう、先にURLからデータを消す。
      try { global.history.replaceState(null, "", global.location.pathname + global.location.search); } catch (_) {}
      let data;
      try { data = parseAiJson(decodeLinkPayload(payload)); }
      catch (e) { open(e.message); return false; }
      if (options.hasInput && options.hasInput() &&
          !global.confirm("AIが作成したデータで、現在の入力内容を置き換えます。よろしいですか？")) return false;
      try { await options.apply(data); return true; }
      catch (e) { open("取り込めませんでした：" + (e && e.message || "形式をご確認ください。")); return false; }
    }

    if (options.button) options.button.addEventListener("click", () => open());
    const ready = importFromLocation().then(done => {
      if (!done) { try { if (new URLSearchParams(global.location.search).get("ai") === "1") open(); } catch (_) {} }
      return done;
    });
    return { open, close, ready };
  }

  global.KKMTAiImport = { create, parseAiJson, decodeLinkPayload, makeLink };
})(window);
