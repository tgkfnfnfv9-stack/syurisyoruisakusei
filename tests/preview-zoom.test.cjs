const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "preview-zoom.js"), "utf8");

// Geometry models native scroll bounds and the two actual page layouts:
// a fixed-height desktop preview, and a mobile preview that grows in the page.
// Mutation notifications deliberately include same-value style writes, as a
// browser does, so the observer fallback cannot hide a self-triggering loop.
function fixture(options = {}) {
  const frames = new Map(), resizeObservers = [], mutationObservers = [];
  const pendingMutations = new Set();
  let nextFrame = 1, printing = false;

  class Element {
    constructor(name, parent = null) {
      this.name = name;
      this.parentNode = parent;
      this.dataset = {};
      this.listeners = new Map();
      this.styleWrites = [];
      this.textContent = "";
      this.style = new Proxy({}, {
        get: (values, key) => values[key] || "",
        set: (values, key, value) => {
          values[key] = String(value);
          this.styleWrites.push({ key, value: String(value) });
          mutate(this, "attributes");
          return true;
        }
      });
    }
    contains(element) {
      for (let current = element; current; current = current.parentNode) {
        if (current === this) return true;
      }
      return false;
    }
    addEventListener(type, callback, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ callback, options });
    }
    emit(type, values = {}) {
      const event = {
        target: this, cancelable: true, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...values
      };
      for (const { callback } of this.listeners.get(type) || []) callback(event);
      return event;
    }
    removeAttribute(name) {
      if (name === "data-preview-zoom-active") delete this.dataset.previewZoomActive;
    }
  }

  function mutate(element, type) {
    for (const observer of mutationObservers) {
      if (!observer.target) continue;
      const observesTarget = observer.target === element ||
        (observer.options.subtree && observer.target.contains(element));
      if (observesTarget && observer.options[type === "attributes" ? "attributes" : "childList"]) {
        pendingMutations.add(observer);
      }
    }
  }

  const document = new Element("document"), global = new Element("window");
  const page = new Element("page", document);
  const outside = new Element("form-field", page);
  const preview = new Element("preview", page);
  const stage = new Element("stage", preview), content = new Element("content", stage);
  const status = new Element("status", preview);
  const firstCell = new Element("first-sheet-cell", content);
  const secondCell = new Element("second-sheet-cell", content);
  firstCell.textContent = "見積の手編集内容";
  secondCell.textContent = "報告の表示内容";
  outside.value = "フォーム入力値";
  content.offsetWidth = options.width || 1123;
  content.offsetHeight = options.height || 1520;
  preview.clientWidth = options.viewportWidth || 700;
  const fixedHeight = options.viewportHeight || 500;
  const previewDocumentTop = options.previewTop || 120;
  const previewLeft = options.previewLeft || 50;
  const paddingX = 22, toolbarHeight = 32, bottomPadding = 60;
  let previewScrollLeft = 0, previewScrollTop = 0, documentScrollTop = 0;
  const stageWidth = () => parseFloat(stage.style.width) || content.offsetWidth;
  const stageHeight = () => parseFloat(stage.style.height) || content.offsetHeight;
  Object.defineProperties(preview, {
    clientHeight: { get: () => options.mobile ? stageHeight() + toolbarHeight + bottomPadding : fixedHeight },
    scrollHeight: { get: () => Math.max(preview.clientHeight, stageHeight() + toolbarHeight + bottomPadding) },
    scrollLeft: {
      get() { return previewScrollLeft = Math.min(previewScrollLeft, Math.max(0, stageWidth() + 2 * paddingX - preview.clientWidth)); },
      set(value) { previewScrollLeft = Math.min(Math.max(0, Number(value)), Math.max(0, stageWidth() + 2 * paddingX - preview.clientWidth)); }
    },
    scrollTop: {
      get() { return previewScrollTop = Math.min(previewScrollTop, Math.max(0, preview.scrollHeight - preview.clientHeight)); },
      set(value) { previewScrollTop = Math.min(Math.max(0, Number(value)), Math.max(0, preview.scrollHeight - preview.clientHeight)); }
    }
  });
  const scrollingElement = {};
  Object.defineProperty(scrollingElement, "scrollTop", {
    get: () => documentScrollTop,
    set: value => { documentScrollTop = Math.max(0, Number(value)); }
  });
  function renderedScale() {
    return Number((content.style.transform.match(/^scale\(([^)]+)\)$/) || ["", 1])[1]);
  }
  content.getBoundingClientRect = () => {
    const scale = renderedScale();
    return {
      left: previewLeft + paddingX + Math.max(0, (preview.clientWidth - 2 * paddingX - stageWidth()) / 2) - preview.scrollLeft,
      top: previewDocumentTop + toolbarHeight - scrollingElement.scrollTop - preview.scrollTop,
      width: content.offsetWidth * scale,
      height: content.offsetHeight * scale
    };
  };
  preview.querySelector = selector => ({
    ".preview-zoom-stage": stage,
    ".preview-zoom-content": content,
    "[data-preview-zoom-status]": status
  })[selector] || null;
  document.readyState = options.readyState || "loading";
  document.scrollingElement = scrollingElement;
  document.querySelectorAll = selector => {
    if (selector === ".preview") return [preview];
    if (selector === ".preview[data-preview-zoom-active]") return preview.dataset.previewZoomActive ? [preview] : [];
    if (selector === ".preview-zoom-stage") return [stage];
    if (selector === ".preview-zoom-content") return [content];
    return [];
  };
  global.document = document;
  global.matchMedia = () => ({ matches: printing });
  global.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
  if (options.resizeObserver !== false) {
    global.ResizeObserver = class {
      constructor(callback) { this.callback = callback; resizeObservers.push(this); }
      observe(target) { this.target = target; }
    };
  }
  global.MutationObserver = class {
    constructor(callback) { this.callback = callback; mutationObservers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
  };
  const context = vm.createContext({ window: global });
  vm.runInContext(source, context, { filename: "preview-zoom.js" });
  const api = options.autoStart ? (document.emit("DOMContentLoaded"), null) : global.KKMTPreviewZoom.init(preview);

  function flush(maxCycles = 10) {
    let cycles = 0;
    while (pendingMutations.size || frames.size) {
      assert.ok(++cycles <= maxCycles, "preview layout must settle rather than reschedule itself forever");
      const mutations = [...pendingMutations]; pendingMutations.clear();
      for (const observer of mutations) observer.callback([]);
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback();
    }
    return cycles;
  }
  return {
    global, document, preview, stage, content, status, firstCell, secondCell, outside,
    api, frames, resizeObservers, mutationObservers, mutate, flush,
    printing: value => { printing = value; },
    wheel: (deltaY, extra = {}) => preview.emit("wheel", { deltaY, deltaMode: 0, clientX: 330, clientY: 260, ...extra }),
    touch: (identifier, clientX, clientY = 260, target = firstCell) => ({ identifier, clientX, clientY, target })
  };
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${message || "value"}: ${actual} ≠ ${expected}`);
}
function anchor(f, x = 330, y = 260) {
  const rect = f.content.getBoundingClientRect();
  return { x: (x - rect.left) / f.api.getScale(), y: (y - rect.top) / f.api.getScale() };
}
function assertAnchor(f, expected, x = 330, y = 260) {
  const rect = f.content.getBoundingClientRect();
  close(rect.left + expected.x * f.api.getScale(), x, "horizontal document point remains under the pointer");
  close(rect.top + expected.y * f.api.getScale(), y, "vertical document point remains under the pointer");
}

test("initialization is scoped to valid previews and is idempotent", () => {
  const f = fixture({ autoStart: true });
  assert.equal(f.preview.dataset.previewZoomActive, "true");
  assert.equal(f.status.textContent, "100%");
  assert.equal(f.stage.style.width, "1123px");
  assert.equal(f.stage.style.height, "1520px");
  assert.equal(f.global.KKMTPreviewZoom.init(f.preview), null);
  f.document.emit("DOMContentLoaded");
  assert.equal(f.preview.listeners.get("wheel").length, 1);
  assert.equal(f.global.KKMTPreviewZoom.init(null), null);
  const missing = { dataset: {}, querySelector: () => null };
  assert.equal(f.global.KKMTPreviewZoom.init(missing), null);
  assert.equal(missing.dataset.previewZoomActive, undefined);
  assert.deepEqual([...f.global.listeners.keys()].sort(), ["afterprint", "resize"]);
  assert.deepEqual([...f.document.listeners.keys()], ["DOMContentLoaded"]);
  assert.equal(f.outside.listeners.size, 0, "form and signature controls receive no zoom listeners");
  assert.equal(f.preview.listeners.get("wheel")[0].options.passive, false);
  assert.equal(f.preview.listeners.get("touchmove")[0].options.passive, false);
});

test("wheel up/down use normalized pixel, line and page deltas", () => {
  const up = fixture();
  assert.equal(up.wheel(-100).defaultPrevented, true);
  close(up.api.getScale(), Math.exp(0.2));
  up.wheel(100); close(up.api.getScale(), 1);
  const pixels = fixture(), lines = fixture(), pages = fixture();
  pixels.wheel(80);
  lines.wheel(5, { deltaMode: 1 });
  pages.wheel(0.16, { deltaMode: 2 });
  close(lines.api.getScale(), pixels.api.getScale(), "five lines normalize to 80 pixels");
  close(pages.api.getScale(), pixels.api.getScale(), "page units use the preview viewport height");
  const jump = fixture(); jump.wheel(-1e9);
  close(jump.api.getScale(), Math.exp(0.48), "one event has a bounded delta");
  for (const delta of [0, NaN, Infinity, -Infinity]) {
    const f = fixture();
    assert.equal(f.wheel(delta).defaultPrevented, false);
    assert.equal(f.api.getScale(), 1);
  }
  const noncancelable = fixture();
  assert.equal(noncancelable.wheel(-100, { cancelable: false }).defaultPrevented, false);
  close(noncancelable.api.getScale(), Math.exp(0.2));
});

test("zoom clamps at 20–400% and sizes only the frame from unscaled dimensions", () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.wheel(-1000);
  assert.equal(f.api.getScale(), 4);
  assert.equal(f.status.textContent, "400%");
  assert.equal(f.stage.style.width, "4492px");
  assert.equal(f.stage.style.height, "6080px");
  assert.equal(f.content.offsetWidth, 1123);
  assert.equal(f.content.offsetHeight, 1520);
  for (let i = 0; i < 20; i++) f.wheel(1000);
  assert.equal(f.api.getScale(), 0.2);
  assert.equal(f.status.textContent, "20%");
  assert.equal(f.stage.style.width, "225px");
  assert.equal(f.stage.style.height, "304px");
  const scrollBefore = [f.preview.scrollLeft, f.preview.scrollTop, f.document.scrollingElement.scrollTop];
  f.wheel(1000);
  assert.deepEqual([f.preview.scrollLeft, f.preview.scrollTop, f.document.scrollingElement.scrollTop], scrollBefore);
  assert.equal(f.content.style.width, "", "sheet layout width is never changed to implement screen zoom");
  assert.equal(f.firstCell.textContent, "見積の手編集内容");
  assert.equal(f.secondCell.textContent, "報告の表示内容");
  assert.equal(f.outside.value, "フォーム入力値");
});

test("desktop zoom preserves the pointer anchor using preview scrolling", () => {
  const f = fixture();
  f.preview.scrollLeft = 150; f.preview.scrollTop = 200;
  const point = anchor(f);
  f.wheel(-100);
  assertAnchor(f, point);
  assert.ok(f.preview.scrollLeft > 150);
  assert.ok(f.preview.scrollTop > 200);
  assert.equal(f.document.scrollingElement.scrollTop, 0);
  assert.equal(f.stage.style.width, `${Math.ceil(1123 * f.api.getScale())}px`);
  assert.equal(f.stage.style.height, `${Math.ceil(1520 * f.api.getScale())}px`);
});

test("mobile zoom preserves the anchor through document scrollingElement", () => {
  const f = fixture({ mobile: true, viewportWidth: 390, previewTop: 1100 });
  f.document.scrollingElement.scrollTop = 1000;
  f.preview.scrollLeft = 150;
  const point = anchor(f);
  f.wheel(-100);
  assertAnchor(f, point);
  assert.equal(f.preview.scrollTop, 0);
  assert.ok(f.document.scrollingElement.scrollTop > 1000);
  assert.equal(f.preview.scrollHeight, f.preview.clientHeight);
});

test("one-finger touch retains native scrolling and outside touches do not join a pinch", () => {
  const f = fixture();
  const one = f.touch(1, 300);
  assert.equal(f.preview.emit("touchstart", { touches: [one] }).defaultPrevented, false);
  assert.equal(f.preview.emit("touchmove", { touches: [f.touch(1, 350, 320)] }).defaultPrevented, false);
  assert.equal(f.preview.emit("touchend", { touches: [] }).defaultPrevented, false);
  const outside = f.touch(2, 500, 260, f.outside);
  assert.equal(f.preview.emit("touchstart", { touches: [one, outside] }).defaultPrevented, false);
  assert.equal(f.preview.emit("touchmove", { touches: [f.touch(1, 250), outside] }).defaultPrevented, false);
  assert.equal(f.api.getScale(), 1);
});

test("pinch follows identifiers across touch order changes and distinct sheet elements", () => {
  const f = fixture(); f.preview.scrollLeft = 150; f.preview.scrollTop = 200;
  const point = anchor(f);
  const a = f.touch(11, 280), b = f.touch(22, 380, 260, f.secondCell);
  assert.equal(f.preview.emit("touchstart", { touches: [a, b] }).defaultPrevented, true);
  const move = f.preview.emit("touchmove", { touches: [
    f.touch(99, 900, 500), f.touch(22, 490, 290, f.secondCell), f.touch(11, 290, 290)
  ] });
  assert.equal(move.defaultPrevented, true);
  assert.equal(f.api.getScale(), 2, "a third finger and TouchList order must not replace the original pair");
  assertAnchor(f, point, 390, 290);
  assert.equal(f.status.textContent, "200%");
});

test("replacing a tracked finger and touch cancellation restart the pinch baseline", () => {
  const f = fixture();
  f.preview.emit("touchstart", { touches: [f.touch(1, 280), f.touch(2, 380)] });
  f.preview.emit("touchmove", { touches: [f.touch(1, 230), f.touch(2, 430)] });
  assert.equal(f.api.getScale(), 2);
  f.preview.emit("touchend", { touches: [f.touch(2, 230), f.touch(3, 430)] });
  f.preview.emit("touchmove", { touches: [f.touch(3, 530), f.touch(2, 130)] });
  assert.equal(f.api.getScale(), 4);
  f.preview.emit("touchcancel", { touches: [] });
  f.preview.emit("touchmove", { touches: [f.touch(4, 230), f.touch(5, 430)] });
  assert.equal(f.api.getScale(), 4, "a fresh pair must not use a cancelled distance");
  f.preview.emit("touchmove", { touches: [f.touch(4, 280), f.touch(5, 380)] });
  assert.equal(f.api.getScale(), 2);
  f.preview.emit("touchend", { touches: [f.touch(4, 280)] });
  assert.equal(f.preview.emit("touchmove", { touches: [f.touch(4, 300)] }).defaultPrevented, false);
});

test("coincident touches and noncancelable pinch events stay finite", () => {
  const f = fixture();
  f.preview.emit("touchstart", { touches: [f.touch(1, 330), f.touch(2, 330)] });
  f.preview.emit("touchmove", { touches: [f.touch(1, 280), f.touch(2, 380)] });
  assert.equal(f.api.getScale(), 1);
  const event = f.preview.emit("touchmove", {
    cancelable: false, touches: [f.touch(1, 230), f.touch(2, 430)]
  });
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.api.getScale(), 2);
});

test("Safari GestureEvents suppress native zoom without applying a second scale", () => {
  const f = fixture();
  f.preview.emit("touchstart", { touches: [f.touch(1, 280), f.touch(2, 380)] });
  f.preview.emit("touchmove", { touches: [f.touch(1, 230), f.touch(2, 430)] });
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    assert.equal(f.preview.emit(type, { scale: 5 }).defaultPrevented, true);
    assert.equal(f.api.getScale(), 2);
    assert.equal(f.preview.emit(type, { scale: 5, cancelable: false }).defaultPrevented, false);
  }
});

test("content ResizeObserver handles rebuilt pages and coalesces callbacks", () => {
  const f = fixture(); f.wheel(-100);
  assert.equal(f.resizeObservers.length, 1);
  assert.equal(f.resizeObservers[0].target, f.content, "the observer must not observe its own scaled frame");
  f.content.offsetHeight = 2318;
  f.resizeObservers[0].callback([]);
  f.resizeObservers[0].callback([]);
  f.global.emit("resize");
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.stage.style.height, `${Math.ceil(2318 * f.api.getScale())}px`);
  assert.equal(f.frames.size, 0);
  assert.equal(f.content.offsetHeight, 2318);
});

test("MutationObserver fallback settles after style changes and report rebuilding", () => {
  const f = fixture({ resizeObserver: false });
  assert.equal(f.mutationObservers[0].target, f.content);
  f.flush();
  const transforms = () => f.content.styleWrites.filter(write => write.key === "transform").length;
  assert.equal(transforms(), 1);
  f.api.refresh(); f.flush();
  assert.equal(transforms(), 1, "same-scale refresh must not write a watched style attribute");
  f.wheel(-100); f.flush();
  assert.equal(transforms(), 2, "a real zoom updates the style once and then settles");
  f.content.offsetHeight = 2400;
  f.mutate(f.firstCell, "childList"); f.flush();
  assert.equal(f.stage.style.height, `${Math.ceil(2400 * f.api.getScale())}px`);
  assert.equal(transforms(), 2);
});

test("print layout skips screen dimension writes and afterprint refreshes current scale", () => {
  const f = fixture(); f.wheel(-100);
  const oldHeight = f.stage.style.height, oldTransform = f.content.style.transform;
  f.printing(true); f.content.offsetHeight = 2200;
  f.resizeObservers[0].callback([]); f.flush();
  assert.equal(f.stage.style.height, oldHeight);
  assert.equal(f.content.style.transform, oldTransform);
  f.printing(false); f.global.emit("afterprint"); f.flush();
  assert.equal(f.stage.style.height, `${Math.ceil(2200 * f.api.getScale())}px`);
  assert.equal(f.content.style.transform, oldTransform);
});

test("PDF export unwraps only its clone and retains the live zoom, scroll and edits", () => {
  const live = fixture(); live.preview.scrollLeft = 150; live.preview.scrollTop = 200; live.wheel(-100);
  const clone = fixture();
  Object.assign(clone.stage.style, { width: live.stage.style.width, height: live.stage.style.height });
  clone.content.style.transform = live.content.style.transform;
  clone.preview.scrollLeft = live.preview.scrollLeft; clone.preview.scrollTop = live.preview.scrollTop;
  const before = {
    scale: live.api.getScale(), width: live.stage.style.width, height: live.stage.style.height,
    transform: live.content.style.transform, left: live.preview.scrollLeft, top: live.preview.scrollTop,
    status: live.status.textContent, text: live.firstCell.textContent
  };
  live.global.KKMTPreviewZoom.prepareExport(clone.document);
  assert.equal(clone.preview.dataset.previewZoomActive, undefined);
  assert.equal(clone.preview.style.overflow, "visible");
  assert.equal(clone.preview.scrollLeft, 0); assert.equal(clone.preview.scrollTop, 0);
  assert.equal(clone.stage.style.width, "1123px"); assert.equal(clone.stage.style.height, "auto");
  assert.equal(clone.stage.style.overflow, "visible");
  assert.equal(clone.content.style.transform, "none");
  assert.equal(clone.content.style.position, "static");
  assert.equal(clone.content.style.width, "1123px");
  assert.deepEqual({
    scale: live.api.getScale(), width: live.stage.style.width, height: live.stage.style.height,
    transform: live.content.style.transform, left: live.preview.scrollLeft, top: live.preview.scrollTop,
    status: live.status.textContent, text: live.firstCell.textContent
  }, before);
  live.wheel(-100); assert.ok(live.api.getScale() > before.scale, "live controls remain active after export");
});

test("both PDF paths prepare only html2canvas's clone and print CSS restores natural flow", () => {
  for (const filename of ["報告書メーカー.html", "見積書.html"]) {
    const html = fs.readFileSync(path.join(root, filename), "utf8");
    const application = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
    assert.match(html, /<link[^>]+href="preview-zoom\.css\?/);
    assert.match(html, /<script[^>]+src="preview-zoom\.js\?/);
    assert.match(html, /<script[^>]+src="document-export\.js\?/);
    assert.match(application, /KKMTDocumentExport\.capturePages\(/);
    assert.doesNotMatch(application, /KKMTPreviewZoom\.prepareExport\(document\)/);

  }
  const exporter = fs.readFileSync(path.join(root, "document-export.js"), "utf8");
  assert.match(exporter, /onclone\s*:\s*doc\s*=>\s*\{[^}]*KKMTPreviewZoom\.prepareExport\(doc\)/);
  assert.match(exporter, /copy\.style\.transform="none";copy\.style\.zoom="1"/);
  assert.doesNotMatch(exporter, /KKMTPreviewZoom\.prepareExport\(global\.document\)/);
  const css = fs.readFileSync(path.join(root, "preview-zoom.css"), "utf8");
  assert.match(css, /\.preview\[data-preview-zoom-active\]\s*\{\s*touch-action:pan-x pan-y;/);
  assert.match(css, /\.preview\[data-preview-zoom-active\] \.preview-zoom-stage\s*\{overflow:hidden;/);
  const print = css.slice(css.indexOf("@media print"));
  assert.match(print, /\.preview-zoom-tools\{display:none!important;/);
  assert.match(print, /position:static!important;/);
  assert.match(print, /height:auto!important;/);
  assert.match(print, /transform:none!important;/);
  assert.match(print, /overflow:visible!important;/);
});
