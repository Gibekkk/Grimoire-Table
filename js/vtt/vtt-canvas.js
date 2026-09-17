// A lightweight 2D-canvas tabletop: background image + 5ft grid + draggable
// tokens + a ruler + AoE shape markers. Built on the browser's native Canvas
// API (no game-engine dependency) to stay consistent with the rest of this
// project's "plain JS modules" approach.
//
// Coordinate spaces:
//   screen  — raw pointer event coordinates relative to the canvas element
//   world   — unzoomed pixels within the map image (screen = world*zoom + pan)
//   grid    — world / gridPx, so token position is resolution-independent
//
// Everything is drawn inside a single ctx.translate/scale so grid lines and
// tokens don't need per-shape zoom math — only pointer hit-testing does.

const FEET_PER_GRID = 5;

export class VttCanvas {
  constructor(container, opts) {
    this.container = container;
    this.opts = opts; // { gridPx, canMoveToken(token), onTokenMoved(token,x,y), onTokenClicked(token), onTokenContextMenu(token,screenX,screenY) }
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.tokens = [];
    this.bgImage = null;
    this.tool = "select"; // select | ruler | shape-rect | shape-circle
    this.drag = null;
    this.ruler = null; // { startWorld, endWorld }
    this.shape = null; // { kind, startWorld, endWorld }
    this._images = new Map(); // cache of loaded token images by src

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

    this._raf = requestAnimationFrame(() => this._loop());
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
  }

  setBackground(base64) {
    if (!base64) { this.bgImage = null; return; }
    const img = new Image();
    img.onload = () => { this.bgImage = img; this._fitToView(); };
    img.src = base64;
  }

  // Skips decoding entirely when the caller already has a loaded Image
  // (e.g. a per-mapId cache) — instant map switching instead of a reload flicker.
  setBackgroundImage(img) {
    this.bgImage = img || null;
    if (img) this._fitToView();
  }

  setTokens(tokens) { this.tokens = tokens; }
  setGridPx(px) { this.gridPx = px || 70; }
  setTool(tool) { this.tool = tool; this.shape = null; this.ruler = null; }

  _fitToView() {
    if (!this.bgImage) return;
    const { clientWidth: w, clientHeight: h } = this.container;
    this.zoom = Math.min(w / this.bgImage.width, h / this.bgImage.height, 1) || 1;
    this.pan = { x: (w - this.bgImage.width * this.zoom) / 2, y: (h - this.bgImage.height * this.zoom) / 2 };
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

  _onPointerDown(e) {
    if (e.button === 2) return; // right-click handled by contextmenu
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
    if (this.tool === "ruler") { this.drag = { type: "ruler" }; this.ruler = { startWorld: world, endWorld: world }; return; }
    if (this.tool.startsWith("shape-")) { this.drag = { type: "shape" }; this.shape = { kind: this.tool === "shape-rect" ? "rect" : "circle", startWorld: world, endWorld: world }; return; }
  }

  _onPointerMove(e) {
    if (!this.drag) return;
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);

    if (this.drag.type === "pan") {
      this.pan = { x: this.drag.startPan.x + (sx - this.drag.startScreen.x), y: this.drag.startPan.y + (sy - this.drag.startScreen.y) };
    } else if (this.drag.type === "token") {
      const grid = this.worldToGrid(world.x, world.y);
      this.drag.token._previewX = grid.x;
      this.drag.token._previewY = grid.y;
    } else if (this.drag.type === "ruler") {
      this.ruler.endWorld = world;
    } else if (this.drag.type === "shape") {
      this.shape.endWorld = world;
    }
  }

  _onPointerUp() {
    if (!this.drag) return;
    if (this.drag.type === "token") {
      const t = this.drag.token;
      const finalX = Math.round((t._previewX ?? t.x) * 4) / 4; // snap to quarter-grid
      const finalY = Math.round((t._previewY ?? t.y) * 4) / 4;
      delete t._previewX; delete t._previewY;
      t.x = finalX; t.y = finalY;
      this.opts.onTokenMoved?.(t, finalX, finalY);
    } else if (this.drag.type === "click") {
      this.opts.onTokenClicked?.(this.drag.token);
    } else if (this.drag.type === "ruler") {
      setTimeout(() => { this.ruler = null; }, 2500);
    } else if (this.drag.type === "shape") {
      setTimeout(() => { this.shape = null; }, 4000);
    }
    this.drag = null;
  }

  _onWheel(e) {
    e.preventDefault();
    const { x: sx, y: sy } = this._eventPos(e);
    const worldBefore = this.screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    this.zoom = Math.max(0.2, Math.min(4, this.zoom * factor));
    this.pan = { x: sx - worldBefore.x * this.zoom, y: sy - worldBefore.y * this.zoom };
  }

  zoomBy(factor) {
    const { clientWidth: w, clientHeight: h } = this.container;
    const worldBefore = this.screenToWorld(w / 2, h / 2);
    this.zoom = Math.max(0.2, Math.min(4, this.zoom * factor));
    this.pan = { x: w / 2 - worldBefore.x * this.zoom, y: h / 2 - worldBefore.y * this.zoom };
  }

  _onContextMenu(e) {
    e.preventDefault();
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);
    const token = this._tokenAt(world.x, world.y);
    if (token) this.opts.onTokenContextMenu?.(token, e.clientX, e.clientY);
  }

  _getImage(src) {
    if (!src) return null;
    if (this._images.has(src)) return this._images.get(src);
    const img = new Image();
    img.src = src;
    this._images.set(src, img);
    return img;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    this._draw();
  }

  _draw() {
    const ctx = this.ctx;
    const { clientWidth: w, clientHeight: h } = this.container;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0c0d14";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(this.zoom, this.zoom);

    if (this.bgImage) ctx.drawImage(this.bgImage, 0, 0);

    if (this.gridPx && this.bgImage) {
      ctx.strokeStyle = "rgba(198,154,62,0.25)";
      ctx.lineWidth = 1 / this.zoom;
      for (let x = 0; x <= this.bgImage.width; x += this.gridPx) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.bgImage.height); ctx.stroke();
      }
      for (let y = 0; y <= this.bgImage.height; y += this.gridPx) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.bgImage.width, y); ctx.stroke();
      }
    }

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
        ctx.fillStyle = "#e7e3d8"; ctx.font = `${Math.max(10, r * 0.4)}px sans-serif`; ctx.textAlign = "center";
        ctx.fillText(t.name || "", cx, pos.y + size.y + r * 0.5);
      }
    });

    if (this.ruler) {
      const { startWorld, endWorld } = this.ruler;
      ctx.strokeStyle = "#e0b95c"; ctx.lineWidth = 2 / this.zoom; ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
      ctx.beginPath(); ctx.moveTo(startWorld.x, startWorld.y); ctx.lineTo(endWorld.x, endWorld.y); ctx.stroke();
      ctx.setLineDash([]);
      const dist = Math.hypot(endWorld.x - startWorld.x, endWorld.y - startWorld.y) / this.gridPx * FEET_PER_GRID;
      ctx.fillStyle = "#e0b95c"; ctx.font = `${14 / this.zoom}px sans-serif`;
      ctx.fillText(`${Math.round(dist)} ft`, endWorld.x + 8 / this.zoom, endWorld.y);
    }

    if (this.shape) {
      const { kind, startWorld, endWorld } = this.shape;
      ctx.fillStyle = "rgba(63,143,128,0.25)"; ctx.strokeStyle = "#56b8a5"; ctx.lineWidth = 2 / this.zoom;
      if (kind === "rect") {
        const x = Math.min(startWorld.x, endWorld.x), y = Math.min(startWorld.y, endWorld.y);
        const w2 = Math.abs(endWorld.x - startWorld.x), h2 = Math.abs(endWorld.y - startWorld.y);
        ctx.fillRect(x, y, w2, h2); ctx.strokeRect(x, y, w2, h2);
      } else {
        const r = Math.hypot(endWorld.x - startWorld.x, endWorld.y - startWorld.y);
        ctx.beginPath(); ctx.arc(startWorld.x, startWorld.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }

    ctx.restore();
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
