(function (global) {
  "use strict";

  // Reads a JSON data file chosen on this device.
  function readJsonFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new global.FileReader();
      reader.onload = () => {
        try { resolve(JSON.parse(reader.result)); }
        catch (_) { reject(new Error("JSONデータを読み取れませんでした。保存したデータファイルを選んでください。")); }
      };
      reader.onerror = () => reject(new Error("ファイルを読み取れませんでした。もう一度選び直してください。"));
      reader.onabort = () => reject(new Error("ファイルの読み込みを中止しました。"));
      reader.readAsText(file);
    });
  }

  // Replaces the form with loaded data. If applying fails part way, the form
  // is restored to what it was before, so a bad file never leaves a half-filled form.
  function createLoader({ rootElement, statusElement, collectState, restoreState, beforeLoad, afterLoad }) {
    let loading = false;
    function setStatus(message, state) {
      if (!statusElement) return;
      statusElement.textContent = message || "";
      statusElement.classList.toggle("ok", state === "ok");
      statusElement.classList.toggle("err", state === "error");
    }
    async function loadDocument({ load, apply, message }) {
      if (loading) return false;
      loading = true;
      const wasInert = rootElement ? rootElement.inert : false;
      if (rootElement) rootElement.inert = true;
      setStatus("データを読み込み中…");
      let previous = null, applying = false;
      try {
        if (beforeLoad) beforeLoad();
        const data = await load();
        previous = JSON.parse(JSON.stringify(collectState()));
        applying = true;
        apply(data);
        if (afterLoad) afterLoad();
        setStatus(message || "データを読み込みました。", "ok");
        return true;
      } catch (error) {
        if (applying && previous && restoreState) {
          try { restoreState(previous); } catch (_) {}
        }
        setStatus(error.message || "読み込みに失敗しました。", "error");
        throw error;
      } finally {
        if (rootElement) rootElement.inert = wasInert;
        loading = false;
      }
    }
    return { loadDocument, setStatus };
  }

  global.KKMTLocalData = { readJsonFile, createLoader };
})(window);
