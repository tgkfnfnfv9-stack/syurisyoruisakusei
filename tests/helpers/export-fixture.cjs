const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the production export controller with browser APIs at the boundary.
// No Drive connection, file writes, or external browser dependency is needed.
function fixture(options = {}) {
  const downloads = [], revoked = [], objectURLs = new Map(), captures = [];
  const timers = new Set();
  let nextURL = 1;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
      this.style = { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } };
      this.dataset = {}; this.attributes = {}; this.listeners = new Map();
      this.textContent = ""; this.id = ""; this.className = ""; this.disabled = false;
      this.hidden = false; this.inert = false; this.offsetWidth = 1123; this.offsetHeight = 760;
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { this.className += " " + name; },
        remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(" "); }
      };
    }
    appendChild(node) { if (node.parentNode) node.remove(); this.children.push(node); node.parentNode = this; return node; }
    insertBefore(node, before) { if (!before) return this.appendChild(node); if (node.parentNode) node.remove(); const index = this.children.indexOf(before); if (index < 0) throw new Error("Reference node not found"); this.children.splice(index, 0, node); node.parentNode = this; return node; }
    append(...nodes) { nodes.forEach(node => this.appendChild(typeof node === "string" ? Object.assign(new Element("span"), { textContent: node }) : node)); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    removeChild(node) { node.remove(); }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); if (key === "id") this.id = value; if (key === "class") this.className = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback)); }
    async emit(type, extra = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...extra }; return Promise.all((this.listeners.get(type) || []).map(callback => callback(event))); }
    click() { if (this.disabled) return Promise.resolve(); if (this.tagName === "A") downloads.push({ name: this.download, url: this.href, blob: objectURLs.get(this.href) }); return this.emit("click"); }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = null; }
    showModal() { this.open = true; }
    close() { this.open = false; return this.emit("close"); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    matches(selector) {
      if (selector.startsWith("#")) return this.id === selector.slice(1);
      if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
      if (selector.startsWith("[")) { const match = selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/); return !!match && (match[2] === undefined ? this.getAttribute(match[1]) !== null : this.getAttribute(match[1]) === match[2]); }
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    querySelectorAll(selector) { const selectors = selector.split(",").map(item => item.trim()); return this.children.flatMap(child => [...(selectors.some(item => child.matches(item)) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    cloneNode(deep) { const copy = new Element(this.tagName); Object.assign(copy, { textContent: this.textContent, id: this.id, className: this.className, offsetWidth: this.offsetWidth, offsetHeight: this.offsetHeight }); Object.assign(copy.style, this.style); copy.attributes = { ...this.attributes }; copy.dataset = { ...this.dataset }; if (deep) this.children.forEach(child => copy.appendChild(child.cloneNode(true))); return copy; }
    getBoundingClientRect() { return { width: this.offsetWidth, height: this.offsetHeight, left: 0, top: 0 }; }
    get isConnected() { return document.body.contains(this) || document.head.contains(this); }
    set innerHTML(value) { this.replaceChildren(); this._html = value; }
    get innerHTML() { return this._html || ""; }
  }
  const document = new Element("document");
  document.body = new Element("body"); document.head = new Element("head"); document.append(document.head, document.body);
  document.createElement = tag => {
    const element = new Element(tag);
    if (tag === "iframe") element.contentDocument = {
      head: new Element("head"), body: new Element("body"), html: "",
      open() { this.html = ""; }, write(html) { this.html += html; }, close() {},
      createElement: name => new Element(name)
    };
    return element;
  }; document.getElementById = id => document.querySelector("#" + id);
  document.activeElement = null; document.fonts = { ready: Promise.resolve() };
  class TestFile extends Blob { constructor(parts, name, init) { super(parts, init); this.name = name; this.lastModified = 0; } }
  class PDF {
    constructor(init) { this.init = init; this.images = []; this.pages = 1; this.internal = { pageSize: { getWidth: () => 297, getHeight: () => 210 } }; }
    addImage(...args) { this.images.push(args); }
    addPage() { this.pages++; }
    output() { return new Blob([JSON.stringify({ images: this.images, pages: this.pages })], { type: "application/pdf" }); }
  }
  const global = {
    document, console, Blob, File: TestFile, TextEncoder, Uint8Array, ArrayBuffer, Promise,
    performance: { now: () => Date.now() },
    navigator: options.navigator || {},
    URL: { createObjectURL(blob) { const url = "blob:test/" + nextURL++; objectURLs.set(url, blob); return url; }, revokeObjectURL(url) { revoked.push(url); objectURLs.delete(url); } },
    setTimeout(fn, delay) { const timer = setTimeout(fn, (options.realTimers ? delay || 0 : Math.min(delay || 0, 5))); timers.add(timer); return timer; }, clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    requestAnimationFrame(fn) { return setTimeout(fn, 0); }, cancelAnimationFrame: clearTimeout,
    getComputedStyle: element => element.style,
    html2canvas: async (element, init) => { captures.push({ element, init, text: element.textContent }); if (options.render) await options.render(element, init); return { width: 2246, height: 1520, toDataURL: () => "data:image/jpeg;base64," + Buffer.from(element.textContent).toString("base64") }; },
    jspdf: { jsPDF: PDF },
    KKMTPreviewZoom: { prepareExport() {} },
    addEventListener() {}, removeEventListener() {},
    alert(message) { throw new Error("Unexpected alert: " + message); }
  };
  global.window = global;
  const context = vm.createContext(global);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "document-export.js"), "utf8"), context);
  const text = node => [node.textContent, ...node.children.map(text)].join(" ");
  return { api: global.KKMTDocumentExport, global, context, document, Element, downloads, revoked, objectURLs, captures,
    buttons: () => document.querySelectorAll("button"), button: value => document.querySelectorAll("button").find(node => text(node).includes(value)),
    text: () => text(document.body), cleanup() { timers.forEach(clearTimeout); } };
}

function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

module.exports = { fixture, deferred };
