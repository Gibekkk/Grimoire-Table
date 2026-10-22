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
// Performance: rendering is event-driven via a dirty flag rather than a
// continuous rAF loop. The canvas only redraws when something changes.

const FEET_PER_GRID = 5;

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

    // --- Fog of war ---
    this.fogs = [];
    this.fogCursorSize = 3;
    this.fogCursorMin = 1;
    this.fogCursorMax = 15;
    this._isDm = !!opts.isDm;
    this._fogCursorWorld = null;

    // --- Persistent AoE shapes (like tokens, stay until removed) ---
    this.persistentShapes = [];

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

    this._resizeObserver = new ResizeObserver(this._resize);
    this._resizeObserver.observe(this.container);
    this._resize();

    this.canvas.addEventListener("pointerdown", this._onPointerDown);
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this._onContextMenu);

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
    if (!base64) { this.bgImage = null; this._markDirty(); return; }
    const img = new Image();
    img.onload = () => { this.bgImage = img; this._fitToView(); };
    img.src = base64;
  }

  setBackgroundImage(img) {
    this.bgImage = img || null;
    if (img) this._fitToView();
    this._markDirty();
  }

  setTokens(tokens) { this.tokens = tokens; this._markDirty(); }
  setGridPx(px) { this.gridPx = px || 70; this._markDirty(); }
  setTool(tool) {
    this.tool = tool;
    this.shape = null;
    this.ruler = null;
    this._updateCursor();
    this._markDirty();
  }

  // --- Fog API ---
  setFogs(fogs) { this.fogs = fogs || []; this._markDirty(); }
  setFogCursorSize(size) {
    this.fogCursorSize = Math.max(this.fogCursorMin, Math.min(this.fogCursorMax, size));
    this._updateCursor();
    this._markDirty();
  }
  getFogCursorSize() { return this.fogCursorSize; }
  getFogCursorMin() { return this.fogCursorMin; }
  getFogCursorMax() { return this.fogCursorMax; }
  isDm() { return this._isDm; }

  _updateCursor() {
    if (!this.canvas) return;
    this.canvas.style.cursor = this.tool === "fog" ? "crosshair" : "grab";
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
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      const t = this.tokens[i];
      const tw = this.gridToWorld(t.x, t.y);
      const size = this.gridToWorld(t.w || 1, t.h || 1);
      if (worldX >= tw.x && worldX <= tw.x + size.x && worldY >= tw.y && worldY <= tw.y + size.y) return t;
    }
    return null;
  }

  // --- Pointer handlers ---

  _onPointerDown(e) {
    if (e.button === 2) return;
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);

    if (this.tool === "select") {
      const token = this._tokenAt(world.x, world.y);
      if (token && this.opts.canMoveToken(token)) {
        this.drag = { type: "token", token, startWorld: world, origGrid: { x: token.x, y: token.y } };
        return;
      }
      if (!token) { this.drag = { type: "pan", startScreen: { x: sx, y: sy }, startPan: { ...this.pan } }; return; }
      this.drag = { type: "click", token };
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

    if (this.tool === "fog") {
      const grid = this.worldToGrid(world.x, world.y);
      const id = "fog_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      this.drag = { type: "fog-place", fog: { id, x: grid.x, y: grid.y, radius: this.fogCursorSize } };
      this._markDirty();
      return;
    }
  }

  _onPointerMove(e) {
    if (!this.drag) return;
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);

    if (this.drag.type === "pan") {
      this.pan = { x: this.drag.startPan.x + (sx - this.drag.startScreen.x), y: this.drag.startPan.y + (sy - this.drag.startScreen.y) };
      this._markDirty();
    } else if (this.drag.type === "token") {
      const grid = this.worldToGrid(world.x, world.y);
      this.drag.token._previewX = grid.x;
      this.drag.token._previewY = grid.y;
      this._markDirty();
    } else if (this.drag.type === "ruler") {
      this.ruler.endWorld = world;
      this._markDirty();
    } else if (this.drag.type === "shape") {
      this.shape.endWorld = world;
      this._markDirty();
    } else if (this.drag.type === "shape-cone") {
      this.shape.endWorld = world;
      this._markDirty();
    } else if (this.tool === "fog") {
      this._fogCursorWorld = world;
      this._markDirty();
    }
  }

  _onPointerUp() {
    if (!this.drag) return;

    if (this.drag.type === "token") {
      const t = this.drag.token;
      const finalX = Math.round((t._previewX ?? t.x) * 4) / 4;
      const finalY = Math.round((t._previewY ?? t.y) * 4) / 4;
      delete t._previewX; delete t._previewY;
      t.x = finalX; t.y = finalY;
      this.opts.onTokenMoved?.(t, finalX, finalY);
      this._markDirty();
    } else if (this.drag.type === "click") {
      this.opts.onTokenClicked?.(this.drag.token);
    } else if (this.drag.type === "ruler") {
      this.ruler = null;
      this._markDirty();
    } else if (this.drag.type === "shape") {
      // Make persistent shape (rect or circle)
      const { kind, startWorld, endWorld } = this.shape;
      if (kind === "rect") {
        const w2 = Math.abs(endWorld.x - startWorld.x) / this.gridPx;
        const h2 = Math.abs(endWorld.y - startWorld.y) / this.gridPx;
        if (w2 > 0.1 && h2 > 0.1) {
          this.addPersistentShape({
            id: "shape_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
            kind: "rect",
            x: startWorld.x / this.gridPx,
            y: startWorld.y / this.gridPx,
            w: w2,
            h: h2
          });
        }
      } else {
        const r = Math.hypot(endWorld.x - startWorld.x, endWorld.y - startWorld.y) / this.gridPx;
        if (r > 0.1) {
          this.addPersistentShape({
            id: "shape_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
            kind: "circle",
            x: startWorld.x / this.gridPx,
            y: startWorld.y / this.gridPx,
            radius: r
          });
        }
      }
      this.shape = null;
      this._markDirty();
    } else if (this.drag.type === "shape-cone") {
      // Make persistent cone shape
      const { origin, endWorld } = this.shape;
      const dx = endWorld.x - origin.x;
      const dy = endWorld.y - origin.y;
      const dist = Math.hypot(dx, dy) / this.gridPx;
      if (dist > 0.1) {
        const angle = Math.atan2(dy, dx);
        this.addPersistentShape({
          id: "shape_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
          kind: "cone",
          originX: origin.x / this.gridPx,
          originY: origin.y / this.gridPx,
          angle: angle,
          distance: dist
        });
      }
      this.shape = null;
      this._markDirty();
    } else if (this.drag.type === "fog-place") {
      this.opts.onFogPlaced?.(this.drag.fog);
    }
    this.drag = null;
  }

  _onWheel(e) {
    e.preventDefault();
    if (this.tool === "fog") {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.setFogCursorSize(this.fogCursorSize * factor);
      return;
    }
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

  _onContextMenu(e) {
    e.preventDefault();
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);

    // Fog tool: right-click on fog to remove
    if (this.tool === "fog") {
      for (let i = this.fogs.length - 1; i >= 0; i--) {
        const f = this.fogs[i];
        const fx = this.gridToWorld(f.x, 0);
        const fy = this.gridToWorld(f.y, 0);
        const fr = this.gridToWorld(f.radius, 0);
        if (Math.hypot(world.x - fx, world.y - fy) <= fr) {
          this.opts.onFogRemoved?.(f);
          return;
        }
      }
      return;
    }

    // Persistent shapes: right-click to remove
    if (this.tool === "shape-rect" || this.tool === "shape-circle" || this.tool === "shape-cone") {
      for (let i = this.persistentShapes.length - 1; i >= 0; i--) {
        const s = this.persistentShapes[i];
        if (this._pointInShape(world.x, world.y, s)) {
          this.removePersistentShape(s);
          return;
        }
      }
      return;
    }

    const token = this._tokenAt(world.x, world.y);
    if (token) this.opts.onTokenContextMenu?.(token, e.clientX, e.clientY);
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
      const r = this.gridToWorld(shape.radius, 0);
      return Math.hypot(px - pos.x, py - pos.y) <= r;
    }
    if (shape.kind === "cone") {
      const origin = this.gridToWorld(shape.originX, shape.originY);
      const dx = Math.cos(shape.angle) * shape.distance * this.gridPx;
      const dy = Math.sin(shape.angle) * shape.distance * this.gridPx;
      const endX = origin.x + dx;
      const endY = origin.y + dy;
      const spread = shape.distance * 0.5; // cone half-angle spread
      const spreadRad = Math.atan2(spread * this.gridPx, shape.distance * this.gridPx);
      return this._pointInCone(px, py, origin.x, origin.y, endX, endY, spreadRad);
    }
    return false;
  }

  _pointInCone(px, py, ox, oy, ex, ey, halfAngle) {
    const dx = ex - ox;
    const dy = ey - oy;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const dx2 = px - ox;
    const dy2 = py - oy;
    const d2 = Math.hypot(dx2, dy2);
    if (d2 > dist * 1.1) return false;
    let angleDiff = Math.abs(angle - Math.atan2(dy2, dx2));
    if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
    return angleDiff <= halfAngle;
  }

  _getImage(src) {
    if (!src) return null;
    if (this._images.has(src)) return this._images.get(src);
    const img = new Image();
    img.src = src;
    this._images.set(src, img);
    return img;
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

    // Background
    if (this.bgImage) {
      ctx.drawImage(this.bgImage, 0, 0);
    }

    // Grid — improved contrast (always draw if we have a grid size)
    if (this.gridPx) {
      ctx.strokeStyle = "rgba(198,154,62,0.4)";
      ctx.lineWidth = 1 / this.zoom;
      // Determine grid bounds: use bg image dimensions if available, else the visible area
      const bgW = this.bgImage?.width ?? (w / this.zoom) * 3;
      const bgH = this.bgImage?.height ?? (h / this.zoom) * 3;
      for (let x = 0; x <= bgW; x += this.gridPx) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bgH); ctx.stroke();
      }
      for (let y = 0; y <= bgH; y += this.gridPx) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bgW, y); ctx.stroke();
      }
    }

    // Tokens
    this.tokens.forEach(t => {
      const gx = t._previewX ?? t.x, gy = t._previewY ?? t.y;
      const pos = this.gridToWorld(gx, gy);
      const size = this.gridToWorld(t.w || 1, t.h || 1);
      if (t.kind === "component") {
        const img = this._getImage(t.imageBase64);
        if (img?.complete && img.naturalWidth) ctx.drawImage(img, pos.x, pos.y, size.x, size.y);
        else { ctx.fillStyle = "rgba(198,154,62,0.35)"; ctx.fillRect(pos.x, pos.y, size.x, size.y); }
        if (t.isCover) {
          ctx.strokeStyle = "#56b8a5"; ctx.lineWidth = 2 / this.zoom;
          ctx.strokeRect(pos.x, pos.y, size.x, size.y);
        }
      } else {
        const cx = pos.x + size.x / 2, cy = pos.y + size.y / 2, r = Math.min(size.x, size.y) / 2;
        const img = this._getImage(t.imageBase64);
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        if (img?.complete && img.naturalWidth) ctx.drawImage(img, pos.x, pos.y, size.x, size.y);
        else { ctx.fillStyle = t.kind === "npc" ? "#9a3838" : "#3f8f80"; ctx.fillRect(pos.x, pos.y, size.x, size.y); }
        ctx.restore();
        ctx.strokeStyle = t.kind === "npc" ? "#c24b4b" : "#c69a3e";
        ctx.lineWidth = 2 / this.zoom;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        if (!img || !img.naturalWidth) {
          ctx.fillStyle = "#fff"; ctx.font = `${r}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText((t.name || "?")[0].toUpperCase(), cx, cy);
        }
        // Token name — improved contrast with text shadow
        ctx.fillStyle = "#fff"; ctx.font = `bold ${Math.max(10, r * 0.4)}px sans-serif`; ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 4;
        ctx.fillText(t.name || "", cx, pos.y + size.y + r * 0.5);
        ctx.shadowBlur = 0;
      }
    });

    // Ruler
    if (this.ruler) {
      const { startWorld, endWorld } = this.ruler;
      ctx.strokeStyle = "#e0b95c"; ctx.lineWidth = 2 / this.zoom; ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
      ctx.beginPath(); ctx.moveTo(startWorld.x, startWorld.y); ctx.lineTo(endWorld.x, endWorld.y); ctx.stroke();
      ctx.setLineDash([]);
      const dist = Math.hypot(endWorld.x - startWorld.x, endWorld.y - startWorld.y) / this.gridPx * FEET_PER_GRID;
      ctx.fillStyle = "#e0b95c"; ctx.font = `bold ${14 / this.zoom}px sans-serif`;
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
      ctx.fillText(`${Math.round(dist)} ft`, endWorld.x + 8 / this.zoom, endWorld.y);
      ctx.shadowBlur = 0;
    }

    // Persistent shapes
    this._drawPersistentShapes();

    // Temporary shape preview (being drawn right now)
    if (this.shape) {
      this._drawShapePreview();
    }

    // Fog cursor
    if (this.tool === "fog" && this._fogCursorWorld) {
      const cx = this._fogCursorWorld.x;
      const cy = this._fogCursorWorld.y;
      const r = this.gridToWorld(this.fogCursorSize, 0);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      const feet = Math.round(this.fogCursorSize * FEET_PER_GRID);
      ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.font = `bold ${11 / this.zoom}px sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 3;
      ctx.fillText(`${feet} ft`, cx, cy + r + 14 / this.zoom);
      ctx.shadowBlur = 0;
    }

    // Fog of war overlay
    if (this.fogs && this.fogs.length > 0) {
      this._drawFogOverlay();
    }

    ctx.restore();
  }

  _drawFogOverlay() {
    const ctx = this.ctx;
    const isPlayer = !this._isDm;
    for (const fog of this.fogs) {
      const center = this.gridToWorld(fog.x, fog.y);
      const radius = fog.radius * this.gridPx;
      const cx = center.x;
      const cy = center.y;
      // Skip invalid radii
      if (radius <= 0) continue;
      if (isPlayer) {
        // Players: nearly opaque black (fog of war)
        ctx.fillStyle = "rgba(0,0,0,0.95)";
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
      } else {
        // DM: very light translucent overlay so the map is still clearly visible
        ctx.fillStyle = "rgba(0,0,0,0.12)";
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
        // Bright gold border so the DM can clearly see fog boundaries
        ctx.strokeStyle = "rgba(224,185,92,0.7)";
        ctx.lineWidth = 2.5 / this.zoom;
        ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        // Outer glow ring
        ctx.strokeStyle = "rgba(224,185,92,0.15)";
        ctx.lineWidth = 8 / this.zoom;
        ctx.beginPath(); ctx.arc(cx, cy, radius + 2 / this.zoom, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  _drawPersistentShapes() {
    const ctx = this.ctx;
    for (const shape of this.persistentShapes) {
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
        ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
        ctx.fillText(`${feetW}×${feetH} ft`, pos.x + size.x / 2, pos.y + size.y + 16 / this.zoom);
        ctx.shadowBlur = 0;
      } else if (shape.kind === "circle") {
        const pos = this.gridToWorld(shape.x, shape.y);
        const r = this.gridToWorld(shape.radius, 0);
        ctx.fillStyle = "rgba(63,143,128,0.25)";
        ctx.strokeStyle = "#56b8a5";
        ctx.lineWidth = 2 / this.zoom;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        // Size label
        const feet = Math.round(shape.radius * FEET_PER_GRID);
        ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
        ctx.fillText(`${feet} ft radius`, pos.x, pos.y + r + 16 / this.zoom);
        ctx.shadowBlur = 0;
      } else if (shape.kind === "cone") {
        this._drawCone(shape);
      }
    }
  }

  _drawCone(shape) {
    const ctx = this.ctx;
    const origin = this.gridToWorld(shape.originX, shape.originY);
    const length = shape.distance * this.gridPx;
    const dx = Math.cos(shape.angle) * length;
    const dy = Math.sin(shape.angle) * length;
    const endX = origin.x + dx;
    const endY = origin.y + dy;
    const spread = shape.distance * 0.4; // half-angle spread in grid units
    const spreadRad = Math.atan2(spread * this.gridPx, length);

    // Calculate arc points
    const startAngle = shape.angle - spreadRad;
    const endAngle = shape.angle + spreadRad;

    ctx.fillStyle = "rgba(63,143,128,0.25)";
    ctx.strokeStyle = "#56b8a5";
    ctx.lineWidth = 2 / this.zoom;

    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(endX, endY);
    ctx.arc(origin.x, origin.y, length, shape.angle, shape.angle, false);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Size label
    const feet = Math.round(shape.distance * FEET_PER_GRID);
    const degrees = Math.round(spreadRad * 2 * (180 / Math.PI));
    const labelX = origin.x + Math.cos(shape.angle) * length * 0.6;
    const labelY = origin.y + Math.sin(shape.angle) * length * 0.6;
    ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
    ctx.fillText(`${feet} ft, ${degrees}°`, labelX, labelY);
    ctx.shadowBlur = 0;
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
      ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
      ctx.fillText(`${feetW}×${feetH} ft`, x + w2 / 2, y + h2 + 16 / this.zoom);
      ctx.shadowBlur = 0;
    } else if (kind === "circle") {
      const r = Math.hypot(endWorld.x - startWorld.x, endWorld.y - startWorld.y);
      ctx.fillStyle = "rgba(63,143,128,0.25)"; ctx.strokeStyle = "#56b8a5"; ctx.lineWidth = 2 / this.zoom;
      ctx.beginPath(); ctx.arc(startWorld.x, startWorld.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const feet = Math.round((r / this.gridPx) * FEET_PER_GRID);
      ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
      ctx.fillText(`${feet} ft radius`, startWorld.x, startWorld.y + r + 16 / this.zoom);
      ctx.shadowBlur = 0;
    } else if (kind === "cone") {
      const { origin, endWorld } = this.shape;
      const dx = endWorld.x - origin.x;
      const dy = endWorld.y - origin.y;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const spread = Math.min(dist * 0.4, 10 * this.gridPx);
      const spreadRad = Math.atan2(spread, dist);
      const startAngle = angle - spreadRad;
      const endAngle = angle + spreadRad;

      ctx.fillStyle = "rgba(63,143,128,0.25)";
      ctx.strokeStyle = "#56b8a5";
      ctx.lineWidth = 2 / this.zoom;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(origin.x + Math.cos(startAngle) * dist, origin.y + Math.sin(startAngle) * dist);
      ctx.arc(origin.x, origin.y, dist, startAngle, endAngle);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      const feet = Math.round((dist / this.gridPx) * FEET_PER_GRID);
      const degrees = Math.round(spreadRad * 2 * (180 / Math.PI));
      const labelX = origin.x + Math.cos(angle) * dist * 0.6;
      const labelY = origin.y + Math.sin(angle) * dist * 0.6;
      ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
      ctx.fillText(`${feet} ft, ${degrees}°`, labelX, labelY);
      ctx.shadowBlur = 0;
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
    cancelAnimationFrame(this._raf);
    this._resizeObserver.disconnect();
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    this.canvas.remove();
  }
}
