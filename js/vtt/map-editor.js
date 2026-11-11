// Editing an existing map: name, picture, size, and a live grid. Used by the VTT
// (floating over the real map) and by the Map Workshop (a dialog with a preview).
//
// Tokens store their position and size in grid squares, so they grow and shrink with
// the grid on their own. To keep them where they stand: on a map with a picture, a new
// grid or size moves each token to the same spot on the picture, and fog (stored
// against the picture) stays put with them. On a blank map there's nothing to line up
// with, so the map grows with its squares and tokens keep their squares.
import { db } from "../db.js";
import { h, toast, escapeHtml } from "../util.js";
import { compressImageToBase64, IMAGE_PRESETS } from "../image-utils.js";
import { VttCanvas, loadImageCached } from "./vtt-canvas.js";
import { confirmDialog } from "../dialogs.js";

export const GRID_MIN = 20, GRID_MAX = 300;
const SIZE_MIN = 200, SIZE_MAX = 8000;
const COMMIT_DELAY_MS = 350; // a slider drag becomes one save per pause, not one per pixel
const EPS = 1e-6;

const layoutOf = (map) => ({ gridPx: map.gridPx || 70, widthPx: map.widthPx || 1200, heightPx: map.heightPx || 800 });
const near = (a, b) => Math.abs(a - b) < EPS;

// Whole-square tokens stay on whole squares; anything else keeps the drop grid of quarter squares
function snap(v, whole) {
  return Math.max(0, whole ? Math.round(v) : Math.round(v * 4) / 4);
}

// One editing session. Every position is worked out from where it was when the session
// began, so dragging a slider back and forth can't build up rounding errors, and Undo
// lands exactly where it started. A token someone moves meanwhile is rebased on its new spot.
export function createMapLayoutSession({ campaignId, map, tokens, shapes, onChange }) {
  let base = layoutOf(map), saved = { ...base }, next = { ...base };
  let hasPicture = !!map.backgroundBase64;
  let timer = null;
  let tokenRecs = new Map(), shapeRecs = new Map();

  const factor = (l) => hasPicture
    ? { fx: (l.widthPx / base.widthPx) * (base.gridPx / l.gridPx), fy: (l.heightPx / base.heightPx) * (base.gridPx / l.gridPx) }
    : { fx: 1, fy: 1 };

  function recFor(recs, id, x, y) {
    let rec = recs.get(id);
    const unchanged = rec && ((near(x, rec.lastX) && near(y, rec.lastY)) || (near(x, rec.prevX) && near(y, rec.prevY)));
    if (!unchanged) {
      const f = factor(saved);
      rec = { x: x / f.fx, y: y / f.fy, wholeX: near(x, Math.round(x)), wholeY: near(y, Math.round(y)), lastX: x, lastY: y, prevX: x, prevY: y };
      recs.set(id, rec);
    }
    return rec;
  }
  function tokenAt(t, f) {
    const rec = recFor(tokenRecs, t.id, t.x, t.y);
    return { rec, x: snap(rec.x * f.fx, rec.wholeX), y: snap(rec.y * f.fy, rec.wholeY) };
  }
  // Cones are placed by their point of origin, other shapes by x/y
  const shapeKeys = (s) => s.kind === "cone" ? ["originX", "originY"] : ["x", "y"];
  function shapeAt(s, f) {
    const [kx, ky] = shapeKeys(s);
    const rec = recFor(shapeRecs, s.id, s[kx], s[ky]);
    return { rec, kx, ky, x: rec.x * f.fx, y: rec.y * f.fy };
  }

  function commit() {
    clearTimeout(timer); timer = null;
    const f = factor(next);
    const tokenMoves = [], shapeMoves = [];
    tokens().forEach(t => {
      if (t.grappledBy) return; // follows its grappler
      const { rec, x, y } = tokenAt(t, f);
      if (!near(x, t.x) || !near(y, t.y)) tokenMoves.push({ id: t.id, x, y });
      rec.prevX = rec.lastX; rec.prevY = rec.lastY; rec.lastX = x; rec.lastY = y;
    });
    shapes().forEach(s => {
      const { rec, kx, ky, x, y } = shapeAt(s, f);
      if (!near(x, s[kx]) || !near(y, s[ky])) shapeMoves.push({ id: s.id, [kx]: x, [ky]: y });
      rec.prevX = rec.lastX; rec.prevY = rec.lastY; rec.lastX = x; rec.lastY = y;
    });
    const changed = next.gridPx !== saved.gridPx || next.widthPx !== saved.widthPx || next.heightPx !== saved.heightPx;
    if (!changed && !tokenMoves.length && !shapeMoves.length) return;
    saved = { ...next };
    db.maps.updateLayout(campaignId, map.id, { patch: { ...next }, tokens: tokenMoves, shapes: shapeMoves }).catch(err => {
      console.error(err);
      toast("Couldn't save the map layout", "error");
    });
  }

  return {
    get layout() { return { ...next }; },
    get hasPicture() { return hasPicture; },
    get original() { return { ...base }; },
    set(partial) {
      const out = { ...next, ...partial };
      // A blank map keeps its squares when the grid changes
      if (!hasPicture && partial.gridPx && partial.widthPx == null) {
        const k = partial.gridPx / next.gridPx;
        out.widthPx = Math.round(next.widthPx * k);
        out.heightPx = Math.round(next.heightPx * k);
      }
      next = out;
      onChange?.(next);
      clearTimeout(timer);
      timer = setTimeout(commit, COMMIT_DELAY_MS);
    },
    undo() { next = { ...base }; onChange?.(next); commit(); },
    flush() { if (timer) commit(); },
    // A new picture starts a fresh baseline: tokens keep their squares on it
    rebase(updated) {
      this.flush();
      base = layoutOf(updated); saved = { ...base }; next = { ...base };
      hasPicture = !!updated.backgroundBase64;
      tokenRecs = new Map(); shapeRecs = new Map();
      onChange?.(next);
    },
    // Where things appear right now, for showing an unsaved change instantly
    previewToken(t) {
      if (t.grappledBy) return null;
      const { x, y } = tokenAt(t, factor(next));
      return { x, y };
    },
    previewShape(s) {
      const { kx, ky, x, y } = shapeAt(s, factor(next));
      return { [kx]: x, [ky]: y };
    }
  };
}

// Compressed picture plus its real size (the compressor reports 0 when it hits its last resort)
async function preparePicture(file) {
  const result = await compressImageToBase64(file, IMAGE_PRESETS.mapBackground);
  if (result.width && result.height) return result;
  const img = await loadImageCached(result.dataUrl);
  return { ...result, width: img?.naturalWidth || 1200, height: img?.naturalHeight || 800 };
}

// The form itself. `session` holds grid and size; name and picture save directly.
export function renderMapForm(host, { campaignId, map, session, onDone }) {
  let picture = map.backgroundBase64 || null;
  host.innerHTML = "";
  host.classList.add("map-form");

  const head = h("div", { class: "map-form-head" }, `<h4>Edit map</h4>`);
  if (onDone) {
    const x = h("button", { class: "icon-btn", title: "Close (Esc)", type: "button" }, "✕");
    x.addEventListener("click", onDone);
    head.appendChild(x);
  }
  host.appendChild(head);

  // Name
  const name = h("input", { type: "text", value: map.name || "", placeholder: "Map name", "aria-label": "Map name" });
  const saveName = () => {
    const v = name.value.trim();
    if (!v) { name.value = map.name || ""; return; }
    if (v === map.name) return;
    map = { ...map, name: v };
    db.maps.update(campaignId, map.id, { name: v });
  };
  name.addEventListener("change", saveName);
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
  host.appendChild(h("label", {}, "Name"));
  host.appendChild(name);

  // Picture
  host.appendChild(h("label", {}, "Picture"));
  const picRow = h("div", { class: "map-form-pic" });
  const thumb = h("div", { class: "map-form-thumb" });
  const picBtns = h("div", { class: "map-form-pic-btns" });
  const file = h("input", { type: "file", accept: "image/*", style: "display:none;" });
  const replace = h("button", { class: "btn sm", type: "button" });
  const remove = h("button", { class: "btn sm ghost", type: "button" }, "Remove");
  [file, replace, remove].forEach(el => picBtns.appendChild(el));
  picRow.appendChild(thumb); picRow.appendChild(picBtns);
  host.appendChild(picRow);

  function drawPicture() {
    thumb.innerHTML = picture ? `<img src="${escapeHtml(picture)}" alt="">` : `<span class="meta">None</span>`;
    replace.textContent = picture ? "Replace…" : "Add picture…";
    remove.style.display = picture ? "" : "none";
  }
  async function setPicture(patch) {
    await db.maps.update(campaignId, map.id, patch);
  }
  replace.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    replace.disabled = true;
    replace.textContent = "Saving…";
    try {
      const pic = await preparePicture(f);
      session.flush();
      const patch = { backgroundBase64: pic.dataUrl, widthPx: pic.width, heightPx: pic.height };
      map = { ...map, gridPx: session.layout.gridPx, ...patch };
      picture = pic.dataUrl;
      session.rebase(map);
      setPicture(patch).catch(err => { console.error(err); toast("Couldn't save that picture", "error"); });
      drawPicture(); drawLayout();
      toast("Picture updated. Tokens kept their squares; check the grid size against it.");
    } catch (err) {
      console.error(err);
      toast("Couldn't read that image", "error");
      drawPicture();
    } finally {
      replace.disabled = false;
    }
  });
  remove.addEventListener("click", async () => {
    if (!await confirmDialog("Remove this map's picture? Tokens and fog stay.", { okLabel: "Remove", danger: true })) return;
    session.flush();
    map = { ...map, ...session.layout, backgroundBase64: null };
    picture = null;
    session.rebase(map);
    setPicture({ backgroundBase64: null }).catch(err => { console.error(err); toast("Couldn't remove the picture", "error"); });
    drawPicture(); drawLayout();
  });

  // Grid
  host.appendChild(h("label", {}, "Grid size (pixels per 5 ft square)"));
  const gridRow = h("div", { class: "map-form-grid" });
  const minus = h("button", { class: "icon-btn", type: "button", title: "1 px smaller" }, "−");
  const slider = h("input", { type: "range", min: GRID_MIN, max: GRID_MAX, class: "fog-slider", "aria-label": "Grid size slider" });
  const plus = h("button", { class: "icon-btn", type: "button", title: "1 px bigger" }, "+");
  const gridNum = h("input", { type: "number", min: GRID_MIN, max: GRID_MAX, "aria-label": "Grid size in pixels" });
  [minus, slider, plus, gridNum].forEach(el => gridRow.appendChild(el));
  host.appendChild(gridRow);
  const setGrid = (v) => {
    const px = Math.max(GRID_MIN, Math.min(GRID_MAX, Math.round(v) || GRID_MIN));
    session.set({ gridPx: px });
    drawLayout();
  };
  slider.addEventListener("input", () => setGrid(+slider.value));
  gridNum.addEventListener("change", () => setGrid(+gridNum.value));
  minus.addEventListener("click", () => setGrid(session.layout.gridPx - 1));
  plus.addEventListener("click", () => setGrid(session.layout.gridPx + 1));

  // Calibrating against a picture that has squares drawn on it
  const fit = h("div", { class: "map-form-fit" });
  const fitNum = h("input", { type: "number", min: "1", placeholder: "20", "aria-label": "Squares across the picture" });
  const fitBtn = h("button", { class: "btn sm ghost", type: "button" }, "Fit grid");
  fit.appendChild(h("span", { class: "meta" }, "Picture is"));
  fit.appendChild(fitNum);
  fit.appendChild(h("span", { class: "meta" }, "squares wide"));
  fit.appendChild(fitBtn);
  fitBtn.addEventListener("click", () => {
    const n = parseFloat(fitNum.value);
    if (n > 0) setGrid(session.layout.widthPx / n);
  });
  host.appendChild(fit);

  // Size
  host.appendChild(h("label", {}, "Map size (pixels)"));
  const sizeRow = h("div", { class: "map-form-size" });
  const w = h("input", { type: "number", min: SIZE_MIN, max: SIZE_MAX, "aria-label": "Map width in pixels" });
  const hh = h("input", { type: "number", min: SIZE_MIN, max: SIZE_MAX, "aria-label": "Map height in pixels" });
  const lockWrap = h("label", { class: "map-form-lock" });
  const lock = h("input", { type: "checkbox" });
  lockWrap.appendChild(lock); lockWrap.appendChild(document.createTextNode(" Keep shape"));
  sizeRow.appendChild(w); sizeRow.appendChild(h("span", { class: "meta" }, "×")); sizeRow.appendChild(hh); sizeRow.appendChild(lockWrap);
  host.appendChild(sizeRow);
  const clampSize = (v) => Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(v) || SIZE_MIN));
  const setSize = (changed) => {
    const cur = session.layout;
    const nw = clampSize(+w.value), nh = clampSize(+hh.value);
    const patch = { widthPx: nw, heightPx: nh };
    if (lock.checked) {
      if (changed === "w") patch.heightPx = clampSize(nw * cur.heightPx / cur.widthPx);
      else patch.widthPx = clampSize(nh * cur.widthPx / cur.heightPx);
    }
    session.set(patch);
    drawLayout();
  };
  w.addEventListener("change", () => setSize("w"));
  hh.addEventListener("change", () => setSize("h"));

  const readout = h("div", { class: "map-form-readout" });
  host.appendChild(readout);
  const hint = h("p", { class: "hint" });
  host.appendChild(hint);

  const foot = h("div", { class: "map-form-foot" });
  const undo = h("button", { class: "btn sm ghost", type: "button" }, "Undo grid & size");
  undo.addEventListener("click", () => { session.undo(); drawLayout(); });
  foot.appendChild(undo);
  if (onDone) {
    const done = h("button", { class: "btn sm primary", type: "button" }, "Done");
    done.addEventListener("click", onDone);
    foot.appendChild(done);
  }
  host.appendChild(foot);

  function drawLayout() {
    const l = session.layout, o = session.original;
    slider.value = l.gridPx;
    if (document.activeElement !== gridNum) gridNum.value = l.gridPx;
    if (document.activeElement !== w) w.value = l.widthPx;
    if (document.activeElement !== hh) hh.value = l.heightPx;
    readout.textContent = `${l.gridPx} px = 5 ft • ${+(l.widthPx / l.gridPx).toFixed(1)} × ${+(l.heightPx / l.gridPx).toFixed(1)} squares`;
    fit.style.display = session.hasPicture ? "" : "none";
    lock.checked = lock.dataset.touched ? lock.checked : session.hasPicture;
    hint.textContent = session.hasPicture
      ? "Tokens resize with the grid and stay on the same spot on the picture."
      : "Tokens resize with the grid and keep their squares.";
    undo.disabled = l.gridPx === o.gridPx && l.widthPx === o.widthPx && l.heightPx === o.heightPx;
  }
  lock.addEventListener("change", () => { lock.dataset.touched = "1"; });
  drawPicture();
  drawLayout();
  return { saveName };
}

// The Map Workshop's dialog: the form beside a live preview of the map and its tokens.
export function openMapEditorDialog(campaignId, map) {
  const overlay = h("div", { class: "modal-overlay" });
  const box = h("div", { class: "modal-box map-editor-dialog" });
  const formHost = h("div", {});
  const stage = h("div", { class: "map-editor-preview" });
  box.appendChild(formHost); box.appendChild(stage);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const canvas = new VttCanvas(stage, { canMoveToken: () => false, canMoveShape: () => false, isDm: true, currentUid: null });
  let tokens = [], shapes = [], shownBg;
  const draw = () => {
    canvas.setTokens(tokens.map(t => { const p = session.previewToken(t); return p ? { ...t, ...p } : t; }));
    canvas.setPersistentShapes(shapes.map(s => ({ ...s, ...session.previewShape(s) })));
  };
  const session = createMapLayoutSession({
    campaignId, map, tokens: () => tokens, shapes: () => shapes,
    onChange: (l) => { canvas.setMapSize(l.widthPx, l.heightPx); canvas.setGridPx(l.gridPx); draw(); }
  });
  canvas.setViewKey(`workshop:${campaignId}:${map.id}`);
  canvas.setMapSize(session.layout.widthPx, session.layout.heightPx);
  canvas.setGridPx(session.layout.gridPx);

  function showPicture(bg) {
    if (bg === shownBg) return;
    shownBg = bg;
    if (!bg) { canvas.setBackgroundImage(null); canvas._fitToView(); return; }
    loadImageCached(bg).then(img => { if (shownBg === bg && img) { canvas.setBackgroundImage(img); canvas._fitToView(); } });
  }
  showPicture(map.backgroundBase64 || null);

  const unsubs = [
    db.tokens.subscribe(campaignId, map.id, (t) => { tokens = t; draw(); }),
    db.shapes.subscribe(campaignId, map.id, (s) => { shapes = s; draw(); }),
    db.fogMask.subscribe(campaignId, map.id, (doc) => canvas.setFogMask(doc?.dataUrl || null, doc?.dataUrl ? [] : map.fogs || [])),
    db.maps.subscribe(campaignId, map.id, (m) => { if (m) showPicture(m.backgroundBase64 || null); })
  ];

  const form = renderMapForm(formHost, { campaignId, map, session, onDone: () => close() });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    form.saveName();
    session.flush();
    unsubs.forEach(u => u());
    canvas.dispose();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".ctx-menu")) close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  return close;
}
