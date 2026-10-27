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

    // --- Shape selection ---
    this.selectedShape = null;

    // --- Fog of war ---
    this.fogs = [];
    this.fogCursorSize = 3;
    this.fogCursorMin = 1;
    this.fogCursorMax = 15;
    this.fogBrushSize = 3;
    this.fogBrushMin = 1;
    this.fogBrushMax = 15;

    // --- Default grid size (set by map load, but defaults to 5ft grid) ---
    this.gridPx = 70;
    this._isDm = !!opts.isDm;
    this._fogCursorWorld = null;

    // Live fog drawing layer
    this.fogCanvas = null;
    this.fogCtx = null;
    this.liveFogStrokes = []; // [{ points: [{x,y}, ...] }]
    this._currentStroke = null;

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

    // Fog drawing canvas — separate layer for live freeform fog
    this._initFogCanvas();

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

  _initFogCanvas() {
    const fc = document.createElement("canvas");
    fc.style.position = "absolute";
    fc.style.top = "0";
    fc.style.left = "0";
    fc.style.pointerEvents = "none";
    fc.style.touchAction = "none";
    this.container.appendChild(fc);
    this.fogCanvas = fc;
    this.fogCtx = fc.getContext("2d");
    this._resizeFogCanvas();
  }

  _resizeFogCanvas() {
    if (!this.fogCanvas) return;
    const { clientWidth: w, clientHeight: h } = this.container;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.fogCanvas.width = w * dpr;
    this.fogCanvas.height = h * dpr;
    this.fogCanvas.style.width = w + "px";
    this.fogCanvas.style.height = h + "px";
    this.fogCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Convert live drawing strokes to non-overlapping circles
  _convertStrokesToCircles() {
    const circles = [];
    const brushPx = this.fogBrushSize * this.gridPx;
    const dedupDist = brushPx;

    for (const stroke of this.liveFogStrokes) {
      const pts = stroke.points;
      if (pts.length < 2) continue;

      for (let i = 0; i < pts.length; i += 2) { // sample every other point
        const p = pts[i];
        // Check if this point overlaps any existing circle
        let overlaps = false;
        for (const c of circles) {
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          if (Math.hypot(dx, dy) < dedupDist) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          circles.push({ x: p.x, y: p.y, radius: this.fogBrushSize });
        }
      }
    }
    return circles;
  }

  // Clear live fog and reset
  clearLiveFog() {
    this.liveFogStrokes = [];
    this._currentStroke = null;
    if (this.fogCtx) {
      this.fogCtx.clearRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    }
    this._markDirty();
  }

  // Get brush size in world pixels
  _getBrushWorldRadius() {
    return this.fogBrushSize * this.gridPx;
  }

  // Draw fog at a point using the fog canvas (for live preview)
  _drawFogOnCanvas(worldX, worldY) {
    if (!this.fogCtx) return;
    const rect = this.canvas.getBoundingClientRect();
    const screenX = worldX * this.zoom + this.pan.x + rect.left;
    const screenY = worldY * this.zoom + this.pan.y + rect.top;
    const brushPx = this.fogBrushSize * this.gridPx * this.zoom;
    this.fogCtx.fillStyle = "rgba(0,0,0,1)";
    this.fogCtx.beginPath();
    this.fogCtx.arc(screenX, screenY, brushPx / 2, 0, Math.PI * 2);
    this.fogCtx.fill();
  }

  // Erase fog from the fog canvas
  _eraseFogOnCanvas(worldX, worldY) {
    if (!this.fogCtx) return;
    const rect = this.canvas.getBoundingClientRect();
    const screenX = worldX * this.zoom + this.pan.x + rect.left;
    const screenY = worldY * this.zoom + this.pan.y + rect.top;
    const brushPx = this.fogBrushSize * this.gridPx * this.zoom;
    this.fogCtx.globalCompositeOperation = "destination-out";
    this.fogCtx.beginPath();
    this.fogCtx.arc(screenX, screenY, brushPx / 2, 0, Math.PI * 2);
    this.fogCtx.fill();
    this.fogCtx.globalCompositeOperation = "source-over";
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
    this._resizeFogCanvas();
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
    // Clear live fog stroke if switching away from fog tools
    if (tool !== "fog" && tool !== "draw-fog" && tool !== "erase-fog") {
      if (this._currentStroke && this._currentStroke.points.length > 0) {
        // Auto-save the current stroke
        this.liveFogStrokes.push(this._currentStroke);
        this._currentStroke = null;
      }
    }
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

  // Brush size for draw-fog and erase-fog tools
  getFogBrushSize() { return this.fogBrushSize; }
  getFogBrushMin() { return this.fogBrushMin; }
  getFogBrushMax() { return this.fogBrushMax; }
  setFogBrushSize(size) {
    this.fogBrushSize = Math.max(this.fogBrushMin, Math.min(this.fogBrushMax, size));
    this._updateCursor();
    this._markDirty();
  }
  isDm() { return this._isDm; }

  _updateCursor() {
    if (!this.canvas) return;
    const isFogTool = this.tool === "fog" || this.tool === "draw-fog" || this.tool === "erase-fog";
    this.canvas.style.cursor = isFogTool ? "crosshair" : "grab";
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
    if (e.button === 2) return;
    const { x: sx, y: sy } = this._eventPos(e);
    const world = this.screenToWorld(sx, sy);

    if (this.tool === "select") {
      const token = this._tokenAt(world.x, world.y);
      if (token && this.opts.canMoveToken(token)) {
        this.drag = { type: "token", token, startWorld: world, origGrid: { x: token.x, y: token.y } };
        return;
      }
      // Check for shape hit
      const shape = this._shapeAt(world.x, world.y);
      if (shape && this._canMoveShape(shape)) {
        this.selectedShape = shape;
        // Store the correct origin/center grid coords for each shape type
        let origGrid;
        if (shape.kind === "cone") {
          origGrid = { x: shape.originX, y: shape.originY };
        } else {
          origGrid = { x: shape.x, y: shape.y };
        }
        this.drag = { type: "shape-drag", shape, startWorld: world, origGrid };
        // For circle: store click offset within the circle
        if (shape.kind === "circle") {
          this.drag._clickGrid = {
            x: world.x / this.gridPx - shape.x,
            y: world.y / this.gridPx - shape.y
          };
        }
        this._markDirty();
        return;
      }
      if (!token && !shape) { this.drag = { type: "pan", startScreen: { x: sx, y: sy }, startPan: { ...this.pan } }; return; }
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

    if (this.tool === "draw-fog") {
      this.drag = { type: "draw-fog" };
      this._currentStroke = { points: [{ x: world.x, y: world.y }] };
      this.liveFogStrokes.push(this._currentStroke);
      this._drawFogOnCanvas(world.x, world.y);
      this._markDirty();
      return;
    }

    if (this.tool === "erase-fog") {
      this.drag = { type: "erase-fog" };
      this._currentStroke = { points: [{ x: world.x, y: world.y }] };
      this.liveFogStrokes.push(this._currentStroke);
      this._eraseFogOnCanvas(world.x, world.y);
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
      // Equilateral triangle: drag sets side length and direction
      const dx = world.x - this.shape.origin.x;
      const dy = world.y - this.shape.origin.y;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const h = dist * (Math.sqrt(3) / 2); // height of equilateral triangle
      // Perpendicular direction to the drag angle
      const px = -Math.sin(angle);
      const py = Math.cos(angle);
      this.shape._dist = dist;
      this.shape._angle = angle;
      this.shape._tipWorld = { x: world.x, y: world.y };
      // Base vertices (at midpoint, offset by half-width)
      const mx = this.shape.origin.x + Math.cos(angle) * dist / 2;
      const my = this.shape.origin.y + Math.sin(angle) * dist / 2;
      this.shape._base1World = { x: mx + px * h / 2, y: my + py * h / 2 };
      this.shape._base2World = { x: mx - px * h / 2, y: my - py * h / 2 };
      this.shape.endWorld = world;
      this._markDirty();
    } else if (this.drag.type === "draw-fog") {
      // Record stroke point
      const lastPt = this._currentStroke.points[this._currentStroke.points.length - 1];
      const dx = world.x - lastPt.x;
      const dy = world.y - lastPt.y;
      const dist = Math.hypot(dx, dy);
      // Only add point if moved enough (avoid too many points)
      if (dist > 2) {
        this._currentStroke.points.push({ x: world.x, y: world.y });
        this._drawFogOnCanvas(world.x, world.y);
        this._markDirty();
      }
    } else if (this.drag.type === "erase-fog") {
      const lastPt = this._currentStroke.points[this._currentStroke.points.length - 1];
      const dx = world.x - lastPt.x;
      const dy = world.y - lastPt.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 2) {
        this._currentStroke.points.push({ x: world.x, y: world.y });
        this._eraseFogOnCanvas(world.x, world.y);
        this._markDirty();
      }
    } else if (this.drag.type === "shape-drag") {
      const { shape, startWorld, origGrid } = this.drag;
      const startGrid = this.worldToGrid(startWorld.x, startWorld.y);
      const endGrid = this.worldToGrid(world.x, world.y);
      const dx = endGrid.x - startGrid.x;
      const dy = endGrid.y - startGrid.y;
      if (shape.kind === "circle") {
        shape.x = origGrid.x + dx;
        shape.y = origGrid.y + dy;
      } else if (shape.kind === "cone") {
        shape.originX = origGrid.x + dx;
        shape.originY = origGrid.y + dy;
      } else {
        shape.x = origGrid.x + dx;
        shape.y = origGrid.y + dy;
      }
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
    } else if (this.drag.type === "shape-drag") {
      // Persist the moved shape
      const { shape } = this.drag;
      if (shape.kind === "cone") {
        this.opts.onPersistentShapeMoved?.(shape);
      } else {
        this.opts.onPersistentShapeMoved?.(shape);
      }
      this.selectedShape = null;
      this._markDirty();
    } else if (this.drag.type === "shape") {
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
      this._markDirty();
    } else if (this.drag.type === "shape-cone") {
      // Make persistent cone shape (equilateral triangle)
      const { origin, _dist, _angle, _tipWorld, _base1World, _base2World } = this.shape;
      const dist = _dist || Math.hypot(
        this.shape.endWorld.x - origin.x,
        this.shape.endWorld.y - origin.y
      );
      const angle = _angle ?? Math.atan2(
        this.shape.endWorld.y - origin.y,
        this.shape.endWorld.x - origin.x
      );
      if (dist > 0.1) {
        this.addPersistentShape({
          id: "shape_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
          kind: "cone",
          originX: origin.x / this.gridPx,
          originY: origin.y / this.gridPx,
          angle: angle,
          distance: dist,
          ownerUid: this.opts.currentUid
        });
      }
      this.shape = null;
      this._markDirty();
    } else if (this.drag.type === "fog-place") {
      this.opts.onFogPlaced?.(this.drag.fog);
    } else if (this.drag.type === "draw-fog" || this.drag.type === "erase-fog") {
      // Convert live strokes to non-overlapping circles and save
      const circles = this._convertStrokesToCircles();
      if (this.drag.type === "draw-fog") {
        const newFogs = [...this.fogs, ...circles.map(c => ({
          id: "fog_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
          x: c.x / this.gridPx,
          y: c.y / this.gridPx,
          radius: c.radius
        }))];
        this.opts.onFogPlaced?.(newFogs);
      } else {
        // Erase: remove circles that overlap with the drawn eraser area
        const eraserCircles = this._convertStrokesToCircles();
        let remaining = this.fogs.filter(fog => {
          for (const ec of eraserCircles) {
            const ecWorld = { x: ec.x, y: ec.y };
            const fogWorld = this.gridToWorld(fog.x, fog.y);
            const dist = Math.hypot(ecWorld.x - fogWorld.x, ecWorld.y - fogWorld.y);
            const eraseRadius = this.fogBrushSize * this.gridPx;
            if (dist < fog.radius * this.gridPx + eraseRadius) {
              return false; // overlap, remove this fog
            }
          }
          return true;
        });
        this.opts.onFogRemoved?.(remaining);
      }
      this.liveFogStrokes = [];
      this._currentStroke = null;
    }
    this.drag = null;
  }

  _onWheel(e) {
    e.preventDefault();
    if (this.tool === "fog" || this.tool === "draw-fog" || this.tool === "erase-fog") {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.setFogBrushSize(this.fogBrushSize * factor);
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

    // Persistent shapes: right-click to remove (any tool or select mode)
    const shape = this._shapeAt(world.x, world.y);
    if (shape) {
      if (this.opts.canMoveShape?.(shape)) {
        this.removePersistentShape(shape);
      }
      return;
    }

    // Shape tools: right-click to remove shapes
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
      const r = shape.radius * this.gridPx;
      return Math.hypot(px - pos.x, py - pos.y) <= r;
    }
    if (shape.kind === "cone") {
      // Equilateral triangle hit test
      const origin = this.gridToWorld(shape.originX, shape.originY);
      const length = shape.distance * this.gridPx;
      const tipX = origin.x + Math.cos(shape.angle) * length;
      const tipY = origin.y + Math.sin(shape.angle) * length;
      const midX = origin.x + Math.cos(shape.angle) * length / 2;
      const midY = origin.y + Math.sin(shape.angle) * length / 2;
      const perpX = -Math.sin(shape.angle);
      const perpY = Math.cos(shape.angle);
      const halfWidth = length * (Math.sqrt(3) / 4);
      const b1x = midX + perpX * halfWidth;
      const b1y = midY + perpY * halfWidth;
      const b2x = midX - perpX * halfWidth;
      const b2y = midY - perpY * halfWidth;
      return this._pointInTriangle(px, py, origin.x, origin.y, tipX, tipY, b1x, b1y);
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

  _pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
    const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
    const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
    const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
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

    // Fog of war overlay (saved circles + live strokes)
    if ((this.fogs && this.fogs.length > 0) || this.liveFogStrokes?.length > 0) {
      this._drawFogOverlay();
    }

    ctx.restore();
  }

  _drawFogOverlay() {
    const ctx = this.ctx;
    const isPlayer = !this._isDm;

    // Draw saved fog circles
    for (const fog of this.fogs) {
      const center = this.gridToWorld(fog.x, fog.y);
      const radius = fog.radius * this.gridPx;
      const cx = center.x;
      const cy = center.y;
      if (radius <= 0) continue;
      if (isPlayer) {
        // Players: fully opaque black — no borders, no glows, no translucency
        ctx.fillStyle = "rgba(0,0,0,1)";
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = "rgba(0,0,0,0.12)";
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(224,185,92,0.7)";
        ctx.lineWidth = 2.5 / this.zoom;
        ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(224,185,92,0.15)";
        ctx.lineWidth = 8 / this.zoom;
        ctx.beginPath(); ctx.arc(cx, cy, radius + 2 / this.zoom, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Draw live drawing strokes (converted to circles for rendering)
    if (this.liveFogStrokes.length > 0) {
      const circles = this._convertStrokesToCircles();
      for (const c of circles) {
        if (isPlayer) {
          ctx.fillStyle = "rgba(0,0,0,1)"; // players: pitch black, no transparency
        } else {
          ctx.fillStyle = "rgba(0,0,0,0.12)";
        }
        ctx.beginPath(); ctx.arc(c.x, c.y, c.radius * this.gridPx, 0, Math.PI * 2); ctx.fill();
      }
    }
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
        ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
        ctx.fillText(`${feetW}×${feetH} ft`, pos.x + size.x / 2, pos.y + size.y + 16 / this.zoom);
        ctx.shadowBlur = 0;
      } else if (shape.kind === "circle") {
        const pos = this.gridToWorld(shape.x, shape.y);
        const r = shape.radius * this.gridPx;
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

    // Equilateral triangle: tip at distance, two base vertices perpendicular to midpoint
    const tipX = origin.x + dx;
    const tipY = origin.y + dy;
    const midX = origin.x + dx / 2;
    const midY = origin.y + dy / 2;
    const perpX = -Math.sin(shape.angle);
    const perpY = Math.cos(shape.angle);
    const halfWidth = length * (Math.sqrt(3) / 4);
    const b1x = midX + perpX * halfWidth;
    const b1y = midY + perpY * halfWidth;
    const b2x = midX - perpX * halfWidth;
    const b2y = midY - perpY * halfWidth;

    ctx.fillStyle = "rgba(63,143,128,0.25)";
    ctx.strokeStyle = "#56b8a5";
    ctx.lineWidth = 2 / this.zoom;

    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(b1x, b1y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(b2x, b2y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Size label — distance (side length) and angle
    const feet = Math.round(shape.distance * FEET_PER_GRID);
    const degrees = Math.round((shape.angle * 180 / Math.PI));
    const labelX = origin.x + dx * 0.6;
    const labelY = origin.y + dy * 0.6;
    ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
    ctx.fillText(`${feet} ft (${degrees}°)`, labelX, labelY);
    ctx.shadowBlur = 0;
  }

  _drawShapeHighlight(shape) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
    ctx.strokeStyle = "#e0b95c";
    ctx.lineWidth = 2 / this.zoom;
    if (shape.kind === "rect") {
      const pos = this.gridToWorld(shape.x, shape.y);
      const size = this.gridToWorld(shape.w, shape.h);
      ctx.strokeRect(pos.x - 2 / this.zoom, pos.y - 2 / this.zoom, size.x + 4 / this.zoom, size.y + 4 / this.zoom);
    } else if (shape.kind === "circle") {
      const pos = this.gridToWorld(shape.x, shape.y);
      const r = shape.radius * this.gridPx;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 2 / this.zoom, 0, Math.PI * 2); ctx.stroke();
    } else if (shape.kind === "cone") {
      const origin = this.gridToWorld(shape.originX, shape.originY);
      const length = shape.distance * this.gridPx;
      const tipX = origin.x + Math.cos(shape.angle) * length;
      const tipY = origin.y + Math.sin(shape.angle) * length;
      const midX = origin.x + Math.cos(shape.angle) * length / 2;
      const midY = origin.y + Math.sin(shape.angle) * length / 2;
      const perpX = -Math.sin(shape.angle);
      const perpY = Math.cos(shape.angle);
      const halfWidth = length * (Math.sqrt(3) / 4);
      const b1x = midX + perpX * halfWidth;
      const b1y = midY + perpY * halfWidth;
      const b2x = midX - perpX * halfWidth;
      const b2y = midY - perpY * halfWidth;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(b1x, b1y);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(b2x, b2y);
      ctx.closePath();
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
      ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
      ctx.fillText(`${feetW}×${feetH} ft`, x + w2 / 2, y + h2 + 16 / this.zoom);
      ctx.shadowBlur = 0;
    } else if (kind === "circle") {
      const diameter = this.shape._diameter || 0;
      const center = this.shape._centerWorld || startWorld;
      const r = diameter / 2;
      ctx.fillStyle = "rgba(63,143,128,0.25)"; ctx.strokeStyle = "#56b8a5"; ctx.lineWidth = 2 / this.zoom;
      ctx.beginPath(); ctx.arc(center.x, center.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const feet = Math.round((r / this.gridPx) * FEET_PER_GRID);
      ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
      ctx.fillText(`${feet} ft radius`, center.x, center.y + r + 16 / this.zoom);
      ctx.shadowBlur = 0;
    } else if (kind === "cone") {
      const { origin, endWorld, _dist, _angle } = this.shape;
      const dist = _dist ?? Math.hypot(endWorld.x - origin.x, endWorld.y - origin.y);
      const angle = _angle ?? Math.atan2(endWorld.y - origin.y, endWorld.x - origin.x);

      // Equilateral triangle preview
      const tipX = origin.x + Math.cos(angle) * dist;
      const tipY = origin.y + Math.sin(angle) * dist;
      const midX = origin.x + Math.cos(angle) * dist / 2;
      const midY = origin.y + Math.sin(angle) * dist / 2;
      const perpX = -Math.sin(angle);
      const perpY = Math.cos(angle);
      const halfWidth = dist * (Math.sqrt(3) / 4);
      const b1x = midX + perpX * halfWidth;
      const b1y = midY + perpY * halfWidth;
      const b2x = midX - perpX * halfWidth;
      const b2y = midY - perpY * halfWidth;

      ctx.fillStyle = "rgba(63,143,128,0.25)";
      ctx.strokeStyle = "#56b8a5";
      ctx.lineWidth = 2 / this.zoom;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(b1x, b1y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(b2x, b2y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Show size in feet (what users care about) + grids as reference
      const feet2 = Math.round(dist / this.gridPx * FEET_PER_GRID);
      const grids = Math.round(dist / this.gridPx * 10) / 10;
      const labelX = origin.x + Math.cos(angle) * dist * 0.6;
      const labelY = origin.y + Math.sin(angle) * dist * 0.6;
      ctx.fillStyle = "#56b8a5"; ctx.font = `bold ${12 / this.zoom}px sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3;
      ctx.fillText(`${feet2} ft (${grids} grids)`, labelX, labelY);
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
