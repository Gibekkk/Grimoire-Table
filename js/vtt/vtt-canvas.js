// A lightweight 2D-canvas tabletop: background image + 5ft grid + draggable
// tokens + a ruler + persistent AoE shapes + fog of war. Built on the browser's
// native Canvas API (no game-engine dependency) to stay consistent with the rest
// of this project's "plain JS modules" approach.
//
// Coordinate spaces:
//   screen  — raw pointer event coordinates relative to the canvas element
//   world   — unzoomed pixels within the map image (screen = world*zoom + pan)
//   grid    — world / gridPx, so token position is resolution-independent
//
// Everything is drawn inside a single ctx.translate/scale so grid lines and
// tokens don't need per-shape zoom math — only pointer hit-testing does.
//
// Mouse: left button selects/drags tokens and shapes (or uses the active tool),
// right button drags to pan — a right click that doesn't move opens the context
// action instead (remove shape, reset ruler, token menu).
//
// Fog of war is a single offscreen bitmap mask (one layer): the Draw Fog brush
// paints into it, the Erase Fog brush clears pixels out of it, so overlapping
// strokes merge into one shape and erasing removes only what the brush touches.
// The mask is exported as a PNG data URL for persistence.
//
// Performance: rendering is event-driven via a dirty flag rather than a
// continuous rAF loop. The canvas only redraws when something changes. Decoded
// images, round token sprites, the fog mask of each visited map and each map's
// pan/zoom are cached in memory (module level, so they survive panel remounts and
// map switches) — a re-render never re-decodes a base64 image.
//
// Fog first: when a map loads, players see the whole map covered by fog until its
// saved mask has been decoded and applied, so a reload / map switch / snapshot
// never flashes what's underneath. A new mask replaces the old one only once it's
// fully decoded.

const FEET_PER_GRID = 5;
const FOG_MASK_PX_PER_GRID = 16; // mask resolution — fog edges are smoothed when scaled up
const FOG_MASK_MAX_DIM = 2048;
const DRAG_THRESHOLD_PX = 4;     // pointer travel below this counts as a click, not a drag
const DEFAULT_MAP_SIZE = { w: 1200, h: 800 };
const PENDING_MOVE_TTL_MS = 8000;  // keep showing a local move this long while the server catches up

// ---- Shared caches ----
// Base64 data URLs can be hundreds of KB; hashing the whole string on every Map
// lookup (per token, per frame) is itself a cost, so key by length + head + tail.
export function imageKey(src) {
  if (!src) return null;
  return src.length < 256 ? src : `${src.length}:${src.slice(0, 48)}:${src.slice(-96)}`;
}
const IMAGE_CACHE_MAX = 300;
const imageCache = new Map(); // key -> { img, ready, waiters: Set<fn> }
function cachedImage(src, onReady) {
  const key = imageKey(src);
  if (!key) return null;
  let entry = imageCache.get(key);
  if (entry) {
    imageCache.delete(key); imageCache.set(key, entry); // LRU bump
    if (!entry.ready && onReady) entry.waiters.add(onReady);
    return entry;
  }
  const img = new Image();
  entry = { img, ready: false, waiters: new Set(onReady ? [onReady] : []) };
  img.decoding = "async";
  img.onload = () => {
    entry.ready = true;
    entry.waiters.forEach(fn => fn(img)); entry.waiters.clear();
  };
  img.onerror = () => { entry.failed = true; entry.waiters.clear(); };
  img.src = src;
  imageCache.set(key, entry);
  if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  return entry;
}
// Resolves with a decoded <img> (shared with the token cache), or null on failure.
export function loadImageCached(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const entry = cachedImage(src, (img) => resolve(img));
    if (entry.ready) resolve(entry.img);
    else if (entry.failed) resolve(null);
    else entry.img.addEventListener("error", () => resolve(null), { once: true });
  });
}
const spriteCache = new Map();     // round token sprites, keyed by image + kind + pixel size
const SPRITE_CACHE_MAX = 400;
const fogCache = new Map();        // viewKey -> { dataUrl, canvas } last mask seen per map
const viewCache = new Map();       // viewKey -> { pan, zoom } so returning to a map keeps your view

export class VttCanvas {
  constructor(container, opts) {
    this.container = container;
    this.opts = opts;
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.tokens = [];
    this.bgImage = null;
    this.tool = "select";
    this.drag = null;
    this.ruler = null;
    this.shape = null;
    this._images = new Map();

    // --- Shape selection ---
    this.selectedShape = null;

    // --- Fog of war (single bitmap mask) ---
    this.fogBrushSize = 3; // brush diameter in grid squares
    this.fogBrushMin = 1;
    this.fogBrushMax = 15;
    this.fogMask = null;
    this.fogMaskCtx = null;
    this._fogMaskSrc = null;     // data URL currently shown in the mask (skips re-applying our own save)
    this._pendingFog = null;     // remote fog update that arrived mid-stroke
    this._fogLoadToken = 0;
    this._hoverWorld = null;

    // --- Default grid size (set by map load, but defaults to 5ft grid) ---
    this.gridPx = 70;
    this.mapSize = null;
    this._isDm = !!opts.isDm;

    // --- Persistent AoE shapes (like tokens, stay until removed) ---
    this.persistentShapes = [];

    // --- Sync / cache state ---
    this._viewKey = null;          // usually the map id; scopes the fog + view caches
    this._fogReady = true;         // false while a map's fog is loading (players see full fog)
    this._pendingMoves = new Map(); // tokenId -> { x, y, until } optimistic local moves
    this._hasSavedView = false;

    // --- Performance: dirty flag (event-driven rendering) ---
    this._dirty = true;
    this._raf = null;

    this.canvas = document.createElement("canvas");
    this.canvas.style.touchAction = "none";
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this._resize = this._resize.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);

    this._resizeObserver = new ResizeObserver(this._resize);
    this._resizeObserver.observe(this.container);
    this._resize();

    this.canvas.addEventListener("pointerdown", this._onPointerDown);
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    this.canvas.addEventListener("pointerleave", this._onPointerLeave);
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this._onContextMenu);

    this._ensureFogMask();

    // Start event-driven render loop
    this._markDirty();
  }

  // Tell the canvas it needs to redraw. Always schedules — never skips.
  // Multiple calls before the frame fires are coalesced into one draw.
  _markDirty() {
    if (this._raf) return; // already scheduled this frame
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._draw();
    });
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._markDirty();
  }

  setBackground(base64) {
    if (!base64) { this.setBackgroundImage(null); return; }
    loadImageCached(base64).then(img => { if (img) this.setBackgroundImage(img); });
  }

  setBackgroundImage(img) {
    const changed = this.bgImage !== (img || null);
    this.bgImage = img || null;
    this._ensureFogMask();
    if (img && changed && !this._hasSavedView) { this._fitToView(); this._hasSavedView = true; }
    this._markDirty();
  }

  // Scope fog/view caches to a map. Restores that map's last pan/zoom and shows its
  // last known fog instantly; players get full fog until the live mask is applied.
  setViewKey(key) {
    if (this._viewKey) viewCache.set(this._viewKey, { pan: { ...this.pan }, zoom: this.zoom });
    this._viewKey = key || null;
    const saved = key ? viewCache.get(key) : null;
    this._hasSavedView = !!saved;
    if (saved) { this.pan = { ...saved.pan }; this.zoom = saved.zoom; }
    this._pendingMoves.clear();
    this.selectedShape = null;
    const cachedFog = key ? fogCache.get(key) : null;
    this._ensureFogMask();
    this.fogMaskCtx.clearRect(0, 0, this.fogMask.width, this.fogMask.height);
    this._fogLoadToken++;
    if (cachedFog) {
      this.fogMaskCtx.drawImage(cachedFog.canvas, 0, 0, this.fogMask.width, this.fogMask.height);
      this._fogMaskSrc = cachedFog.dataUrl;
      this._fogReady = true;
    } else {
      this._fogMaskSrc = undefined;
      this._fogReady = false;
    }
    this._markDirty();
  }

  // Incoming token list from the server. Local drag previews and recent moves that
  // the server hasn't confirmed yet are kept, so a slow round trip (or a snapshot
  // for a different token) never snaps a token back to its old square.
  setTokens(tokens) {
    const dragging = this.drag?.type === "token" ? this.drag.token : null;
    const now = Date.now();
    const next = (tokens || []).map(t => {
      const p = this._pendingMoves.get(t.id);
      let out = t;
      if (p) {
        if ((t.x === p.x && t.y === p.y) || now > p.until) this._pendingMoves.delete(t.id);
        else out = { ...t, x: p.x, y: p.y };
      }
      if (dragging && dragging.id === t.id) {
        out = { ...out, _previewX: dragging._previewX, _previewY: dragging._previewY };
        this.drag.token = out;
      }
      return out;
    });
    this.tokens = next;
    this._markDirty();
  }
  setGridPx(px) { this.gridPx = px || 70; this._ensureFogMask(); this._markDirty(); }
  setMapSize(w, h) {
    this.mapSize = w && h ? { w, h } : null;
    this._ensureFogMask();
    this._markDirty();
  }
  setTool(tool) {
    this.tool = tool;
    this.shape = null;
    this.ruler = null;
    this._updateCursor();
    this._markDirty();
  }

  // --- Fog API ---
  getFogBrushSize() { return this.fogBrushSize; }
  getFogBrushMin() { return this.fogBrushMin; }
  getFogBrushMax() { return this.fogBrushMax; }
  setFogBrushSize(size) {
    this.fogBrushSize = Math.max(this.fogBrushMin, Math.min(this.fogBrushMax, size));
    this._markDirty();
  }
  isDm() { return this._isDm; }

  _isFogTool(tool = this.tool) { return tool === "draw-fog" || tool === "erase-fog"; }

  // World size the fog mask covers: the background image, else the map's stored size.
  _worldSize() {
    if (this.bgImage) return { w: this.bgImage.width, h: this.bgImage.height };
    return this.mapSize || DEFAULT_MAP_SIZE;
  }

  // (Re)creates the mask canvas to match the current world size. Existing fog is
  // carried over (stretched) so a late-loading background doesn't wipe it.
  _ensureFogMask() {
    const world = this._worldSize();
    let scale = FOG_MASK_PX_PER_GRID / (this.gridPx || 70);
    scale = Math.min(scale, FOG_MASK_MAX_DIM / Math.max(world.w, world.h));
    const mw = Math.max(1, Math.round(world.w * scale));
    const mh = Math.max(1, Math.round(world.h * scale));
    if (this.fogMask && this.fogMask.width === mw && this.fogMask.height === mh) {
      this._fogScale = scale;
      return;
    }
    const next = document.createElement("canvas");
    next.width = mw; next.height = mh;
    const nctx = next.getContext("2d");
    if (this.fogMask) nctx.drawImage(this.fogMask, 0, 0, mw, mh);
    this.fogMask = next;
    this.fogMaskCtx = nctx;
    this._fogScale = scale;
  }

  // Replaces the fog with a saved mask (PNG data URL). Legacy maps stored fog as
  // an array of circles/strokes; when there's no mask yet those are rasterized in.
  setFogMask(dataUrl, legacyFogs = []) {
    if (this.drag && this._isFogTool(this.drag.type)) {
      this._pendingFog = { dataUrl, legacyFogs };
      return;
    }
    if (dataUrl && dataUrl === this._fogMaskSrc) { this._fogReady = true; this._markDirty(); return; }
    this._ensureFogMask();
    const ctx = this.fogMaskCtx;
    const loadToken = ++this._fogLoadToken;
    if (!dataUrl) {
      this._fogMaskSrc = null;
      ctx.clearRect(0, 0, this.fogMask.width, this.fogMask.height);
      this._rasterizeLegacyFogs(legacyFogs);
      this._fogReady = true;
      this._rememberFog(null);
      this._markDirty();
      return;
    }
    // Decode off-screen first; the old mask stays visible until the new one is ready.
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (loadToken !== this._fogLoadToken) return; // a newer update superseded this one
      this._ensureFogMask();
      this.fogMaskCtx.clearRect(0, 0, this.fogMask.width, this.fogMask.height);
      this.fogMaskCtx.drawImage(img, 0, 0, this.fogMask.width, this.fogMask.height);
      this._fogMaskSrc = dataUrl;
      this._fogReady = true;
      this._rememberFog(dataUrl);
      this._markDirty();
    };
    img.onerror = () => { if (loadToken === this._fogLoadToken) { this._fogReady = true; this._markDirty(); } };
    img.src = dataUrl;
  }

  // Keep a copy of the current mask for this map so switching back is instant.
  _rememberFog(dataUrl) {
    if (!this._viewKey || !this.fogMask) return;
    const copy = document.createElement("canvas");
    copy.width = this.fogMask.width; copy.height = this.fogMask.height;
    copy.getContext("2d").drawImage(this.fogMask, 0, 0);
    fogCache.set(this._viewKey, { dataUrl, canvas: copy });
    if (fogCache.size > 30) fogCache.delete(fogCache.keys().next().value);
  }

  isFogReady() { return this._fogReady; }

  _rasterizeLegacyFogs(fogs) {
    if (!fogs?.length) return;
    const ctx = this.fogMaskCtx;
    const s = this.gridPx * this._fogScale; // grid units -> mask px
    ctx.save();
    ctx.fillStyle = ctx.strokeStyle = "#000";
    ctx.lineCap = ctx.lineJoin = "round";
    for (const f of fogs) {
      if (f.kind === "stroke") {
        if (!f.points?.length) continue;
        ctx.lineWidth = (f.size || this.fogBrushSize) * s;
        ctx.beginPath();
        ctx.moveTo(f.points[0].x * s, f.points[0].y * s);
        f.points.forEach(p => ctx.lineTo(p.x * s, p.y * s));
        ctx.stroke();
      } else if (f.radius > 0) {
        ctx.beginPath(); ctx.arc(f.x * s, f.y * s, f.radius * s, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  clearFog() {
    this._fogLoadToken++;
    this._fogMaskSrc = null;
    this.fogMaskCtx?.clearRect(0, 0, this.fogMask.width, this.fogMask.height);
    this._fogReady = true;
    this._rememberFog(null);
    this._markDirty();
  }

  exportFogMask() {
    if (!this.fogMask) return null;
    const dataUrl = this.fogMask.toDataURL("image/png");
    this._fogMaskSrc = dataUrl;
    this._rememberFog(dataUrl);
    return dataUrl;
  }

  // Paints (or erases) one brush segment into the mask, in world coordinates.
  _paintFog(from, to, erase) {
    const ctx = this.fogMaskCtx;
    if (!ctx) return;
    const s = this._fogScale;
    ctx.save();
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.fillStyle = ctx.strokeStyle = "#000";
    ctx.lineWidth = this.fogBrushSize * this.gridPx * s;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    if (from.x === to.x && from.y === to.y) {
      ctx.arc(to.x * s, to.y * s, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(from.x * s, from.y * s);
      ctx.lineTo(to.x * s, to.y * s);
      ctx.stroke();
    }
    ctx.restore();
    this._markDirty();
  }

  // True when the world point is covered by fog (used to hide fogged tokens from players).
  _isFogged(worldX, worldY) {
    if (!this.fogMaskCtx) return false;
    const mx = Math.floor(worldX * this._fogScale), my = Math.floor(worldY * this._fogScale);
    if (mx < 0 || my < 0 || mx >= this.fogMask.width || my >= this.fogMask.height) return false;
    return this.fogMaskCtx.getImageData(mx, my, 1, 1).data[3] > 127;
  }

  _updateCursor() {
    if (!this.canvas) return;
    if (this.drag?.type === "pan") this.canvas.style.cursor = "grabbing";
    else if (this.drag?.type === "token" || this.drag?.type === "shape-drag") this.canvas.style.cursor = "grabbing";
    else if (this._isFogTool()) this.canvas.style.cursor = "none"; // brush outline is drawn instead
    else if (this.tool !== "select") this.canvas.style.cursor = "crosshair";
    else this.canvas.style.cursor = "";
  }

  // --- Persistent shapes API ---
  setPersistentShapes(shapes) { this.persistentShapes = shapes || []; this._markDirty(); }
  addPersistentShape(shape) {
    this.persistentShapes = [...this.persistentShapes, shape];
    this._markDirty();
    this.opts.onPersistentShapeAdded?.(shape);
  }
  removePersistentShape(shape) {
    this.persistentShapes = this.persistentShapes.filter(s => s.id !== shape.id);
    if (this.selectedShape?.id === shape.id) this.selectedShape = null;
    this._markDirty();
    this.opts.onPersistentShapeRemoved?.(shape);
  }

  _fitToView() {
    if (!this.bgImage) return;
    const { clientWidth: w, clientHeight: h } = this.container;
    this.zoom = Math.min(w / this.bgImage.width, h / this.bgImage.height, 1) || 1;
    this.pan = { x: (w - this.bgImage.width * this.zoom) / 2, y: (h - this.bgImage.height * this.zoom) / 2 };
    this._markDirty();
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.pan.x) / this.zoom, y: (sy - this.pan.y) / this.zoom };
  }
  worldToGrid(wx, wy) { return { x: wx / this.gridPx, y: wy / this.gridPx }; }
  gridToWorld(gx, gy) { return { x: gx * this.gridPx, y: gy * this.gridPx }; }

  _eventPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _tokenAt(worldX, worldY) {
    // Players can't pick (or discover) tokens hidden under fog
    if (!this._isDm && this._isFogged(worldX, worldY)) return null;
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      const t = this.tokens[i];
      const tw = this.gridToWorld(t.x, t.y);
      const size = this.gridToWorld(t.w || 1, t.h || 1);
      if (worldX >= tw.x && worldX <= tw.x + size.x && worldY >= tw.y && worldY <= tw.y + size.y) return t;
    }
    return null;
  }

  _shapeAt(worldX, worldY) {
    // Search in reverse so the topmost shape is selected first
    for (let i = this.persistentShapes.length - 1; i >= 0; i--) {
      const s = this.persistentShapes[i];
      if (this._pointInShape(worldX, worldY, s)) return s;
    }
    return null;
  }

  // --- Pointer handlers ---

  _onPointerDown(e) {
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);

    // Right (or middle) button: drag to pan; a click without movement becomes a context action
    if (e.button === 2 || e.button === 1) {
      this.drag = { type: "pan", button: e.button, startScreen: { x: sx, y: sy }, startPan: { ...this.pan }, moved: false };
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === "select") {
      const token = this._tokenAt(world.x, world.y);
      if (token) {
        this.selectedShape = null;
        if (this.opts.canMoveToken(token)) {
          // Remember where inside the token it was grabbed so it doesn't snap its corner to the pointer
          const tw = this.gridToWorld(token.x, token.y);
          this.drag = {
            type: "token", token, startScreen: { x: sx, y: sy }, moved: false,
            grabOffset: { x: world.x - tw.x, y: world.y - tw.y }
          };
        } else {
          this.drag = { type: "click", token };
        }
        this._markDirty();
        return;
      }
      const shape = this._shapeAt(world.x, world.y);
      if (shape && this._canMoveShape(shape)) {
        this.selectedShape = shape;
        const origGrid = shape.kind === "cone" ? { x: shape.originX, y: shape.originY } : { x: shape.x, y: shape.y };
        this.drag = { type: "shape-drag", shape, startWorld: world, startScreen: { x: sx, y: sy }, origGrid, moved: false };
        this._markDirty();
        return;
      }
      this.selectedShape = null;
      // Touch has no right button, so a finger on empty map still pans
      if (e.pointerType === "touch") {
        this.drag = { type: "pan", button: 0, startScreen: { x: sx, y: sy }, startPan: { ...this.pan }, moved: false };
      }
      this._markDirty();
      return;
    }

    if (this.tool === "ruler") {
      this.drag = { type: "ruler" };
      this.ruler = { startWorld: world, endWorld: world };
      this._markDirty();
      return;
    }

    if (this.tool === "shape-rect" || this.tool === "shape-circle") {
      this.drag = { type: "shape" };
      this.shape = { kind: this.tool === "shape-rect" ? "rect" : "circle", startWorld: world, endWorld: world };
      this._markDirty();
      return;
    }

    if (this.tool === "shape-cone") {
      this.drag = { type: "shape-cone" };
      this.shape = { kind: "cone", origin: { ...world }, endWorld: { ...world } };
      this._markDirty();
      return;
    }

    if (this._isFogTool() && this._isDm) {
      if (!this._fogReady) return; // the saved mask is still loading; don't paint over it
      this.drag = { type: this.tool, last: world };
      this._paintFog(world, world, this.tool === "erase-fog");
      return;
    }
  }

  _onPointerMove(e) {
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);

    if (this._isFogTool()) {
      this._hoverWorld = world;
      this._markDirty();
    }
    if (!this.drag) return;

    if (this.drag.startScreen && !this.drag.moved &&
        Math.hypot(sx - this.drag.startScreen.x, sy - this.drag.startScreen.y) > DRAG_THRESHOLD_PX) {
      this.drag.moved = true;
      this._updateCursor();
    }

    if (this.drag.type === "pan") {
      if (!this.drag.moved) return;
      this.pan = { x: this.drag.startPan.x + (sx - this.drag.startScreen.x), y: this.drag.startPan.y + (sy - this.drag.startScreen.y) };
      this._markDirty();
    } else if (this.drag.type === "token") {
      if (!this.drag.moved) return;
      const { grabOffset } = this.drag;
      const grid = this.worldToGrid(world.x - grabOffset.x, world.y - grabOffset.y);
      this.drag.token._previewX = grid.x;
      this.drag.token._previewY = grid.y;
      this._markDirty();
    } else if (this.drag.type === "ruler") {
      this.ruler.endWorld = world;
      this._markDirty();
    } else if (this.drag.type === "shape") {
      this.shape.endWorld = world;
      // Circle: drag distance = diameter, center = midpoint
      if (this.shape.kind === "circle") {
        this.shape._centerWorld = {
          x: (this.shape.startWorld.x + this.shape.endWorld.x) / 2,
          y: (this.shape.startWorld.y + this.shape.endWorld.y) / 2
        };
        this.shape._diameter = Math.hypot(
          this.shape.endWorld.x - this.shape.startWorld.x,
          this.shape.endWorld.y - this.shape.startWorld.y
        );
      }
      this._markDirty();
    } else if (this.drag.type === "shape-cone") {
      // Equilateral triangle: apex at the drag start, drag length = side length, drag direction = axis
      this.shape._dist = Math.hypot(world.x - this.shape.origin.x, world.y - this.shape.origin.y);
      this.shape._angle = Math.atan2(world.y - this.shape.origin.y, world.x - this.shape.origin.x);
      this.shape.endWorld = world;
      this._markDirty();
    } else if (this.drag.type === "draw-fog" || this.drag.type === "erase-fog") {
      const last = this.drag.last;
      if (Math.hypot(world.x - last.x, world.y - last.y) > 1) {
        this._paintFog(last, world, this.drag.type === "erase-fog");
        this.drag.last = world;
      }
    } else if (this.drag.type === "shape-drag") {
      if (!this.drag.moved) return;
      const { shape, startWorld, origGrid } = this.drag;
      const dx = (world.x - startWorld.x) / this.gridPx;
      const dy = (world.y - startWorld.y) / this.gridPx;
      if (shape.kind === "cone") {
        shape.originX = origGrid.x + dx;
        shape.originY = origGrid.y + dy;
      } else {
        shape.x = origGrid.x + dx;
        shape.y = origGrid.y + dy;
      }
      this._markDirty();
    }
  }

  _onPointerLeave() {
    if (this._hoverWorld) { this._hoverWorld = null; this._markDirty(); }
  }

  _onPointerUp(e) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;

    if (drag.type === "pan") {
      if (!drag.moved && drag.button === 2) this._handleContextClick(e);
    } else if (drag.type === "token") {
      const t = drag.token;
      if (!drag.moved) {
        this.opts.onTokenClicked?.(t);
      } else {
        const finalX = Math.round((t._previewX ?? t.x) * 4) / 4;
        const finalY = Math.round((t._previewY ?? t.y) * 4) / 4;
        delete t._previewX; delete t._previewY;
        t.x = finalX; t.y = finalY;
        this._pendingMoves.set(t.id, { x: finalX, y: finalY, until: Date.now() + PENDING_MOVE_TTL_MS });
        this.opts.onTokenMoved?.(t, finalX, finalY);
      }
    } else if (drag.type === "click") {
      this.opts.onTokenClicked?.(drag.token);
    } else if (drag.type === "shape-drag") {
      // A plain click keeps the shape selected (Delete removes it); a drag persists the move
      if (drag.moved) {
        this.opts.onPersistentShapeMoved?.(drag.shape);
        this.selectedShape = null;
      }
    } else if (drag.type === "shape") {
      // Make persistent shape (rect or circle)
      const { kind, startWorld, endWorld } = this.shape;
      if (kind === "rect") {
        // Always produce positive width/height regardless of drag direction
        const x = Math.min(startWorld.x, endWorld.x);
        const y = Math.min(startWorld.y, endWorld.y);
        const w2 = Math.abs(endWorld.x - startWorld.x) / this.gridPx;
        const h2 = Math.abs(endWorld.y - startWorld.y) / this.gridPx;
        if (w2 > 0.1 && h2 > 0.1) {
          this.addPersistentShape({
            id: "shape_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
            kind: "rect",
            x: x / this.gridPx,
            y: y / this.gridPx,
            w: w2,
            h: h2,
            ownerUid: this.opts.currentUid
          });
        }
      } else {
        // Circle: use diameter drag → radius = diameter / 2, center = midpoint
        const diameter = this.shape._diameter || 0;
        const center = this.shape._centerWorld || startWorld;
        const radius = diameter / 2 / this.gridPx;
        if (radius > 0.1) {
          this.addPersistentShape({
            id: "shape_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
            kind: "circle",
            x: center.x / this.gridPx,
            y: center.y / this.gridPx,
            radius: radius,
            ownerUid: this.opts.currentUid
          });
        }
      }
      this.shape = null;
    } else if (drag.type === "shape-cone") {
      // Make persistent cone shape (equilateral triangle, side length stored in grid units)
      const { origin, _dist, _angle } = this.shape;
      const dist = (_dist || 0) / this.gridPx;
      if (dist > 0.1) {
        this.addPersistentShape({
          id: "shape_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
          kind: "cone",
          originX: origin.x / this.gridPx,
          originY: origin.y / this.gridPx,
          angle: _angle ?? 0,
          distance: dist,
          ownerUid: this.opts.currentUid
        });
      }
      this.shape = null;
    } else if (drag.type === "draw-fog" || drag.type === "erase-fog") {
      this.opts.onFogChanged?.(this.exportFogMask());
      if (this._pendingFog) {
        const { dataUrl, legacyFogs } = this._pendingFog;
        this._pendingFog = null;
        this.setFogMask(dataUrl, legacyFogs);
      }
    }
    this._updateCursor();
    this._markDirty();
  }

  _onWheel(e) {
    e.preventDefault();
    this._hasSavedView = true;
    const { x: sx, y: sy } = this._eventPos(e);
    const worldBefore = this.screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    this.zoom = Math.max(0.2, Math.min(4, this.zoom * factor));
    this.pan = { x: sx - worldBefore.x * this.zoom, y: sy - worldBefore.y * this.zoom };
    this._markDirty();
  }

  zoomBy(factor) {
    const { clientWidth: w, clientHeight: h } = this.container;
    const worldBefore = this.screenToWorld(w / 2, h / 2);
    this.zoom = Math.max(0.2, Math.min(4, this.zoom * factor));
    this.pan = { x: w / 2 - worldBefore.x * this.zoom, y: h / 2 - worldBefore.y * this.zoom };
    this._markDirty();
  }

  // The native menu is always suppressed: right button is pan, and a right
  // click that doesn't move is handled on pointerup (_handleContextClick).
  _onContextMenu(e) {
    e.preventDefault();
  }

  _handleContextClick(e) {
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);

    // Persistent shapes: right-click to remove (any tool)
    const shape = this._shapeAt(world.x, world.y);
    if (shape && this._canMoveShape(shape)) {
      this.removePersistentShape(shape);
      return;
    }

    // Reset ruler on right-click
    if (this.ruler) {
      this.ruler = null;
      this._markDirty();
      return;
    }

    const token = this._tokenAt(world.x, world.y);
    if (token) this.opts.onTokenContextMenu?.(token, e.clientX, e.clientY);
  }

  // Equilateral cone: apex at the origin, both edges `length` long at ±30° from
  // the aim direction, so the far edge is `length` long too — all three sides equal.
  _coneVertices(ox, oy, angle, length) {
    const a1 = angle - Math.PI / 6, a2 = angle + Math.PI / 6;
    return [
      { x: ox, y: oy },
      { x: ox + Math.cos(a1) * length, y: oy + Math.sin(a1) * length },
      { x: ox + Math.cos(a2) * length, y: oy + Math.sin(a2) * length }
    ];
  }

  _shapeCone(shape) {
    const origin = this.gridToWorld(shape.originX, shape.originY);
    return this._coneVertices(origin.x, origin.y, shape.angle, shape.distance * this.gridPx);
  }

  // Check if a point is inside a persistent shape
  _pointInShape(px, py, shape) {
    if (shape.kind === "rect") {
      const pos = this.gridToWorld(shape.x, shape.y);
      const size = this.gridToWorld(shape.w, shape.h);
      return px >= pos.x && px <= pos.x + size.x && py >= pos.y && py <= pos.y + size.y;
    }
    if (shape.kind === "circle") {
      const pos = this.gridToWorld(shape.x, shape.y);
      const r = shape.radius * this.gridPx;
      return Math.hypot(px - pos.x, py - pos.y) <= r;
    }
    if (shape.kind === "cone") {
      const [a, b, c] = this._shapeCone(shape);
      return this._pointInTriangle(px, py, a.x, a.y, b.x, b.y, c.x, c.y);
    }
    return false;
  }

  // Check if the current user can move this shape
  _canMoveShape(shape) {
    if (this._isDm) return true;
    // Legacy shapes without ownerUid are treated as DM-owned (player can move them)
    if (shape.ownerUid == null) return true;
    return shape.ownerUid === this.opts.currentUid;
  }

  _pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
    const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
    const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
    const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  }

  _getImage(src) {
    const entry = cachedImage(src, () => this._markDirty());
    return entry?.ready ? entry.img : null;
  }

  // Pre-rendered round token (clipped portrait or initial + ring) at a device-pixel
  // size bucket, so a frame is one drawImage per token instead of clip/arc/stroke.
  _tokenSprite(t, diameterPx) {
    const bucket = Math.max(16, Math.min(1024, Math.pow(2, Math.ceil(Math.log2(diameterPx)))));
    const img = this._getImage(t.imageBase64);
    const key = `${t.kind}|${img ? imageKey(t.imageBase64) : "letter:" + (t.name || "?")[0]}|${bucket}`;
    let sprite = spriteCache.get(key);
    if (sprite) return sprite;
    const c = document.createElement("canvas");
    c.width = c.height = bucket;
    const g = c.getContext("2d");
    const r = bucket / 2, ring = Math.max(2, bucket / 28);
    g.save();
    g.beginPath(); g.arc(r, r, r - ring / 2, 0, Math.PI * 2); g.closePath(); g.clip();
    if (img) {
      // cover-fit the portrait into the circle
      const s = Math.max(bucket / img.naturalWidth, bucket / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      g.drawImage(img, (bucket - w) / 2, (bucket - h) / 2, w, h);
    } else {
      g.fillStyle = t.kind === "npc" ? "#9a3838" : "#3f8f80";
      g.fillRect(0, 0, bucket, bucket);
      g.fillStyle = "#fff"; g.font = `${Math.round(r)}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText((t.name || "?")[0].toUpperCase(), r, r + bucket * 0.03);
    }
    g.restore();
    g.strokeStyle = t.kind === "npc" ? "#c24b4b" : "#c69a3e";
    g.lineWidth = ring;
    g.beginPath(); g.arc(r, r, r - ring / 2, 0, Math.PI * 2); g.stroke();
    if (img || !t.imageBase64) {   // don't cache the placeholder while a portrait is still decoding
      spriteCache.set(key, c);
      if (spriteCache.size > SPRITE_CACHE_MAX) spriteCache.delete(spriteCache.keys().next().value);
    }
    return c;
  }

  // --- Rendering ---

  _draw() {
    const ctx = this.ctx;
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return; // container not ready yet — wait for next resize
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0c0d14";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(this.zoom, this.zoom);

    // Visible world rectangle (for culling grid lines and tokens)
    const view = { x0: -this.pan.x / this.zoom, y0: -this.pan.y / this.zoom, x1: (w - this.pan.x) / this.zoom, y1: (h - this.pan.y) / this.zoom };
    const world = this._worldSize();
    // Players see nothing but fog until this map's fog has loaded
    const fogPending = !this._isDm && !this._fogReady;

    // Background
    if (this.bgImage) {
      ctx.drawImage(this.bgImage, 0, 0);
    }

    // Grid — one batched path, only the visible lines
    if (this.gridPx && !fogPending) {
      const gp = this.gridPx;
      const gw = this.bgImage?.width ?? Math.max(world.w, view.x1);
      const gh = this.bgImage?.height ?? Math.max(world.h, view.y1);
      const xs = Math.max(0, Math.floor(view.x0 / gp) * gp), xe = Math.min(gw, view.x1);
      const ys = Math.max(0, Math.floor(view.y0 / gp) * gp), ye = Math.min(gh, view.y1);
      const y0 = Math.max(0, view.y0), y1 = Math.min(gh, view.y1);
      const x0 = Math.max(0, view.x0), x1 = Math.min(gw, view.x1);
      ctx.beginPath();
      for (let x = xs; x <= xe; x += gp) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
      for (let y = ys; y <= ye; y += gp) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
      ctx.strokeStyle = "rgba(198,154,62,0.4)";
      ctx.lineWidth = 1 / this.zoom;
      ctx.stroke();
    }

    // Tokens
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (!fogPending) this.tokens.forEach(t => {
      const gx = t._previewX ?? t.x, gy = t._previewY ?? t.y;
      const pos = this.gridToWorld(gx, gy);
      const size = this.gridToWorld(t.w || 1, t.h || 1);
      if (pos.x > view.x1 || pos.y > view.y1 || pos.x + size.x < view.x0 || pos.y + size.y + this.gridPx < view.y0) return;
      if (t.kind === "component") {
        const img = this._getImage(t.imageBase64);
        if (img) ctx.drawImage(img, pos.x, pos.y, size.x, size.y);
        else { ctx.fillStyle = "rgba(198,154,62,0.35)"; ctx.fillRect(pos.x, pos.y, size.x, size.y); }
        if (t.isCover) {
          ctx.strokeStyle = "#56b8a5"; ctx.lineWidth = 2 / this.zoom;
          ctx.strokeRect(pos.x, pos.y, size.x, size.y);
        }
      } else {
        const d = Math.min(size.x, size.y);
        const cx = pos.x + size.x / 2, cy = pos.y + size.y / 2, r = d / 2;
        const sprite = this._tokenSprite(t, d * this.zoom * dpr);
        ctx.drawImage(sprite, cx - r, cy - r, d, d);
        // Label size is capped so Huge/Gargantuan tokens don't get giant names
        const labelPx = Math.max(10, Math.min(r * 0.4, this.gridPx * 0.3));
        ctx.font = `bold ${labelPx}px sans-serif`; ctx.textAlign = "center";
        ctx.lineWidth = Math.max(2, labelPx / 4); ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineJoin = "round";
        ctx.strokeText(t.name || "", cx, pos.y + size.y + labelPx);
        ctx.fillStyle = "#fff";
        ctx.fillText(t.name || "", cx, pos.y + size.y + labelPx);
      }
    });

    // Fog of war — one merged layer above tokens. Opaque for players, see-through for the DM.
    if (fogPending) {
      ctx.fillStyle = "#000";
      ctx.fillRect(Math.min(0, view.x0), Math.min(0, view.y0), Math.max(world.w, view.x1) - Math.min(0, view.x0), Math.max(world.h, view.y1) - Math.min(0, view.y0));
    } else if (this.fogMask) {
      ctx.save();
      ctx.globalAlpha = this._isDm ? 0.5 : 1;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fogMask, 0, 0, world.w, world.h);
      ctx.restore();
    }

    // Ruler
    if (this.ruler) {
      const { startWorld, endWorld } = this.ruler;
      ctx.strokeStyle = "#e0b95c"; ctx.lineWidth = 2 / this.zoom; ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
      ctx.beginPath(); ctx.moveTo(startWorld.x, startWorld.y); ctx.lineTo(endWorld.x, endWorld.y); ctx.stroke();
      ctx.setLineDash([]);
      const dist = Math.hypot(endWorld.x - startWorld.x, endWorld.y - startWorld.y) / this.gridPx * FEET_PER_GRID;
      ctx.fillStyle = "#e0b95c"; ctx.font = `bold ${14 / this.zoom}px sans-serif`; ctx.textAlign = "left";
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
      ctx.fillText(`${Math.round(dist)} ft`, endWorld.x + 8 / this.zoom, endWorld.y);
      ctx.shadowBlur = 0;
    }

    // Persistent shapes
    if (!fogPending) this._drawPersistentShapes();

    // Temporary shape preview (being drawn right now)
    if (this.shape) {
      this._drawShapePreview();
    }

    // Fog brush outline
    if (this._isFogTool() && this._hoverWorld && this._isDm) {
      const { x: cx, y: cy } = this._hoverWorld;
      const r = this.fogBrushSize * this.gridPx / 2;
      ctx.strokeStyle = this.tool === "erase-fog" ? "rgba(255,120,120,0.9)" : "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  _drawPersistentShapes() {
    const ctx = this.ctx;
    for (const shape of this.persistentShapes) {
      // Draw highlight for selected shape
      if (this.selectedShape && this.selectedShape.id === shape.id) {
        this._drawShapeHighlight(shape);
      }
      if (shape.kind === "rect") {
        const pos = this.gridToWorld(shape.x, shape.y);
        const size = this.gridToWorld(shape.w, shape.h);
        ctx.fillStyle = "rgba(63,143,128,0.25)";
        ctx.strokeStyle = "#56b8a5";
        ctx.lineWidth = 2 / this.zoom;
        ctx.fillRect(pos.x, pos.y, size.x, size.y);
        ctx.strokeRect(pos.x, pos.y, size.x, size.y);
        // Size label
        const feetW = Math.round(shape.w * FEET_PER_GRID);
        const feetH = Math.round(shape.h * FEET_PER_GRID);
        this._shapeLabel(`${feetW}×${feetH} ft`, pos.x + size.x / 2, pos.y + size.y + 16 / this.zoom);
      } else if (shape.kind === "circle") {
        const pos = this.gridToWorld(shape.x, shape.y);
        const r = shape.radius * this.gridPx;
        ctx.fillStyle = "rgba(63,143,128,0.25)";
        ctx.strokeStyle = "#56b8a5";
        ctx.lineWidth = 2 / this.zoom;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        // Size label
        const feet = Math.round(shape.radius * FEET_PER_GRID);
        this._shapeLabel(`${feet} ft radius`, pos.x, pos.y + r + 16 / this.zoom);
      } else if (shape.kind === "cone") {
        this._drawConeTriangle(this._shapeCone(shape), `${Math.round(shape.distance * FEET_PER_GRID)} ft`);
      }
    }
  }

  _shapeLabel(text, x, y) {
    const ctx = this.ctx;
    ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
  }

  _drawConeTriangle([a, b, c], label) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(63,143,128,0.25)";
    ctx.strokeStyle = "#56b8a5";
    ctx.lineWidth = 2 / this.zoom;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Label at the centroid
    this._shapeLabel(label, (a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3);
  }

  _drawShapeHighlight(shape) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
    ctx.strokeStyle = "#e0b95c";
    ctx.lineWidth = 2 / this.zoom;
    const pad = 3 / this.zoom;
    if (shape.kind === "rect") {
      const pos = this.gridToWorld(shape.x, shape.y);
      const size = this.gridToWorld(shape.w, shape.h);
      ctx.strokeRect(pos.x - pad, pos.y - pad, size.x + pad * 2, size.y + pad * 2);
    } else if (shape.kind === "circle") {
      const pos = this.gridToWorld(shape.x, shape.y);
      const r = shape.radius * this.gridPx;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, r + pad, 0, Math.PI * 2); ctx.stroke();
    } else if (shape.kind === "cone") {
      const [a, b, c] = this._shapeCone(shape);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.lineWidth = 4 / this.zoom;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawShapePreview() {
    const ctx = this.ctx;
    const { kind, startWorld, endWorld } = this.shape;

    if (kind === "rect") {
      const x = Math.min(startWorld.x, endWorld.x), y = Math.min(startWorld.y, endWorld.y);
      const w2 = Math.abs(endWorld.x - startWorld.x), h2 = Math.abs(endWorld.y - startWorld.y);
      ctx.fillStyle = "rgba(63,143,128,0.25)"; ctx.strokeStyle = "#56b8a5"; ctx.lineWidth = 2 / this.zoom;
      ctx.fillRect(x, y, w2, h2); ctx.strokeRect(x, y, w2, h2);
      const feetW = Math.round((w2 / this.gridPx) * FEET_PER_GRID);
      const feetH = Math.round((h2 / this.gridPx) * FEET_PER_GRID);
      this._shapeLabel(`${feetW}×${feetH} ft`, x + w2 / 2, y + h2 + 16 / this.zoom);
    } else if (kind === "circle") {
      const diameter = this.shape._diameter || 0;
      const center = this.shape._centerWorld || startWorld;
      const r = diameter / 2;
      ctx.fillStyle = "rgba(63,143,128,0.25)"; ctx.strokeStyle = "#56b8a5"; ctx.lineWidth = 2 / this.zoom;
      ctx.beginPath(); ctx.arc(center.x, center.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const feet = Math.round((r / this.gridPx) * FEET_PER_GRID);
      this._shapeLabel(`${feet} ft radius`, center.x, center.y + r + 16 / this.zoom);
    } else if (kind === "cone") {
      const { origin, _dist = 0, _angle = 0 } = this.shape;
      const feet = Math.round(_dist / this.gridPx * FEET_PER_GRID);
      this._drawConeTriangle(this._coneVertices(origin.x, origin.y, _angle, _dist), `${feet} ft`);
    }
  }

  // Bounding-box overlap check used for auto cover application.
  tokenOverlapsCover(token) {
    const tw = this.gridToWorld(token.x, token.y);
    const tsize = this.gridToWorld(token.w || 1, token.h || 1);
    const cx1 = tw.x, cy1 = tw.y, cx2 = tw.x + tsize.x, cy2 = tw.y + tsize.y;
    for (const other of this.tokens) {
      if (other.id === token.id || other.kind !== "component" || !other.isCover) continue;
      const ow = this.gridToWorld(other.x, other.y);
      const osize = this.gridToWorld(other.w || 1, other.h || 1);
      const ox1 = ow.x, oy1 = ow.y, ox2 = ow.x + osize.x, oy2 = ow.y + osize.y;
      if (cx1 < ox2 && cx2 > ox1 && cy1 < oy2 && cy2 > oy1) return other.coverType || "half";
    }
    return null;
  }

  dispose() {
    if (this._viewKey) viewCache.set(this._viewKey, { pan: { ...this.pan }, zoom: this.zoom });
    cancelAnimationFrame(this._raf);
    this._resizeObserver.disconnect();
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    this.canvas.remove();
  }
}
