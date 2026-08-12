// ============================================================================
// RENDER.JS — All canvas drawing. Everything is primitives; no images.
//
// CAMERA: fixed zoom, panning follow. The zoom is derived from the track's
// bounding box so roughly CAMERA.VISIBLE_FRACTION of the circuit is on screen
// at once, and it never changes. The camera only pans, and only when the car
// pushes out of a deadzone rectangle in the middle of the screen — inside the
// deadzone the view is completely still, so the car drags the view rather
// than the view chasing the car. Panning is smoothed and clamped to the track
// bounds so empty space outside the circuit never comes into view.
//
// The static world (ground, tarmac, kerbs, barriers, start line) is
// pre-rendered once into an offscreen layer, so a frame costs one blit plus
// the cars.
// ============================================================================

// --- Colour palette. Calm and low-contrast, apart from the kerbs and cars.
const PALETTE = {
  ground:        '#232a29',              // surrounding grass / infield
  groundSpeckle: 'rgba(255,255,255,0.014)',
  surface:       '#414a52',              // tarmac — slightly darker than the barriers
  surfaceSeam:   'rgba(206,220,230,0.07)', // faint centreline dashes
  edgeLine:      'rgba(198,214,226,0.30)', // plain edge line, used on straights
  barrier:       '#6d7f90',              // muted grey-blue barrier
  barrierEdge:   'rgba(28,34,40,0.35)',  // slight darkening under the barrier for depth
  kerbRed:       '#c4342f',              // proper red/white kerbing, corners only
  kerbWhite:     '#e6e8e9',
  startPale:     '#9aa6ae',
  startDark:     '#3b444b',
};

// --- Camera tuning -----------------------------------------------------------
const CAMERA = {
  // How much of the circuit is on screen: the viewport spans this fraction of
  // the track's bounding box along whichever axis is tighter. Lower = more
  // zoomed in. The zoom is derived from this once and then never changes.
  //
  // This trades directly against the deadzone. The camera's total pan travel
  // is (1 - VIEWPORT_FRACTION)/2 of the track, while the deadzone is
  // DEADZONE_W/2 of the viewport — so the car can only ever push the camera
  // when the former is comfortably larger than the latter. On this circuit
  // (bounds 3169x1810) anything above ~0.62 leaves the camera frozen: at 0.84
  // — which is "70% of the circuit visible" by area — the deadzone is +/-799px
  // against only +/-254px of available travel. 0.50 keeps a real pan range.
  VIEWPORT_FRACTION: 0.50,
  // Deadzone rectangle as a fraction of the canvas. While the focus point is
  // inside it the camera does not move at all.
  DEADZONE_W: 0.35,
  DEADZONE_H: 0.35,
  // Pan smoothing. Higher = the camera catches up to the deadzone edge
  // faster. Framerate-independent.
  SMOOTHING: 7.0,

  // --- velocity look-ahead ---
  // The camera doesn't track the car, it tracks a focus point pushed ahead of
  // the car along its direction of travel. At MAX_SPEED that push is this
  // fraction of the viewport (per axis, so the wider horizontal axis looks
  // further ahead); at a standstill it is zero and the car sits centred.
  //
  // The deadzone works against this: at a steady speed the focus rides the
  // deadzone boundary, so the car ends up (lookahead - deadzone_half) behind
  // the centre. With a 0.35 deadzone that means this has to clear ~0.175
  // before the car sits back from centre at all.
  LOOKAHEAD_FRACTION: 0.68,
  // Look-ahead easing, deliberately slower than the pan smoothing so that
  // reversing direction swings the view across gently instead of snapping.
  LOOKAHEAD_SMOOTHING: 2.5,
  // Backstop: however far forward the focus is pushed, the car itself stays
  // within this fraction of the viewport from the centre. Only bites during
  // transients (a hard deceleration leaves the camera briefly ahead of a
  // still-large look-ahead); the steady-state offset is well inside it.
  CAR_MAX_OFFSET: 0.82,
};

// --- Start lights -----------------------------------------------------------
const LIGHT_COLORS = {
  housing:   'rgba(16,20,23,0.88)',
  housingEdge: 'rgba(150,170,185,0.25)',
  unlit:     '#3a2326',
  red:       '#ff2d20',
  redGlow:   'rgba(255,45,32,0.45)',
  green:     '#41e06a',
  greenGlow: 'rgba(65,224,106,0.45)',
};

// --- Kerbs: red/white, corners only, wide stripes so they don't strobe when
// --- the camera pans. Straights get the plain edge line instead.
// Radius threshold for "this is a corner". The circuit's genuine corners run
// from 166px (final hairpin) up to about 700px; the fast sweeps sit at
// 700-1300 and the main straight is 2500+. 700 puts kerbing on the parts
// where the car actually has to be placed, and leaves the quick sweepers and
// the straight with the plain edge line.
const KERB_MIN_RADIUS = 700;    // px — corners tighter than this get kerbing
const KERB_WIDTH = 15;          // px, world space
const KERB_STRIPE_LENGTH = 105; // px of track per stripe — deliberately long
const EDGE_LINE_INSET = 13;     // px inboard of the barrier

// Car dimensions in world px, sized to stay readable at the camera's zoom.
const CAR_LENGTH = 56;
const CAR_WIDTH = 28;

// Cap on the pre-rendered layer's resolution, to bound memory on big displays.
const MAX_LAYER_DIMENSION = 4096;

const Render = {
  ctx: null,
  canvas: null,
  trackLayer: null,
  layerScale: 1,
  view: { scale: 1 },
  camera: { x: 0, y: 0 },
  look: { x: 0, y: 0 },             // smoothed velocity look-ahead, world px
  viewport: { halfW: 0, halfH: 0 }, // half the visible world size, in world px

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  },

  // ---- camera --------------------------------------------------------------

  // Size the canvas to its container and recompute zoom. Call on load and
  // whenever the window resizes. The zoom depends only on the track and the
  // canvas, never on where the car is.
  resize(track) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));

    const b = track.bounds;
    // Zoom that would show the whole circuit, then zoomed in so the viewport
    // spans only VIEWPORT_FRACTION of it.
    const fitScale = Math.min(this.canvas.width / b.width, this.canvas.height / b.height);
    this.view.scale = fitScale / CAMERA.VIEWPORT_FRACTION;

    this.viewport.halfW = this.canvas.width / 2 / this.view.scale;
    this.viewport.halfH = this.canvas.height / 2 / this.view.scale;

    this.clampCamera(track);
    this.renderTrackLayer(track);
  },

  // Put the camera straight onto a point, with no smoothing (used on restart).
  snapCameraTo(track, x, y) {
    this.camera.x = x;
    this.camera.y = y;
    this.look.x = 0;
    this.look.y = 0;
    this.clampCamera(track);
  },

  // Deadzone pan over a look-ahead focus point. The focus sits ahead of the
  // car in the direction it is travelling; the camera only moves once that
  // focus leaves the deadzone, and then only far enough to hold it on the
  // boundary. The car therefore drags the view rather than the view chasing.
  updateCamera(track, car, dt) {
    const cam = this.camera;
    const scale = this.view.scale;

    // --- look-ahead, eased so a change of direction swings across gently ---
    const speed = Math.hypot(car.vx, car.vy);
    let wantX = 0, wantY = 0;
    if (speed > 1e-3) {
      const frac = Math.min(1, speed / PHYSICS.MAX_SPEED) * CAMERA.LOOKAHEAD_FRACTION;
      wantX = (car.vx / speed) * frac * this.viewport.halfW;
      wantY = (car.vy / speed) * frac * this.viewport.halfH;
    }
    const lk = 1 - Math.exp(-CAMERA.LOOKAHEAD_SMOOTHING * dt);
    this.look.x += (wantX - this.look.x) * lk;
    this.look.y += (wantY - this.look.y) * lk;

    const focusX = car.x + this.look.x;
    const focusY = car.y + this.look.y;

    // --- deadzone against the focus point ---
    const dzX = this.canvas.width * CAMERA.DEADZONE_W / 2 / scale;  // world px
    const dzY = this.canvas.height * CAMERA.DEADZONE_H / 2 / scale;

    let targetX = cam.x, targetY = cam.y;
    const offX = focusX - cam.x, offY = focusY - cam.y;
    if (offX > dzX) targetX = focusX - dzX;
    else if (offX < -dzX) targetX = focusX + dzX;
    if (offY > dzY) targetY = focusY - dzY;
    else if (offY < -dzY) targetY = focusY + dzY;

    const k = 1 - Math.exp(-CAMERA.SMOOTHING * dt); // framerate-independent lerp
    cam.x += (targetX - cam.x) * k;
    cam.y += (targetY - cam.y) * k;

    // --- backstop: keep the car itself comfortably inside the frame ---
    const maxOffX = this.viewport.halfW * CAMERA.CAR_MAX_OFFSET;
    const maxOffY = this.viewport.halfH * CAMERA.CAR_MAX_OFFSET;
    cam.x = clamp(cam.x, car.x - maxOffX, car.x + maxOffX);
    cam.y = clamp(cam.y, car.y - maxOffY, car.y + maxOffY);

    // Bounds clamping goes last so showing empty space always loses.
    this.clampCamera(track);
  },

  // Keep the visible rectangle inside the track's bounds. If the viewport is
  // wider than the track on an axis (very unusual window shape), centre it on
  // that axis instead of clamping.
  clampCamera(track) {
    const b = track.bounds;
    const cam = this.camera;
    const { halfW, halfH } = this.viewport;
    cam.x = (halfW * 2 >= b.width)
      ? (b.minX + b.maxX) / 2
      : clamp(cam.x, b.minX + halfW, b.maxX - halfW);
    cam.y = (halfH * 2 >= b.height)
      ? (b.minY + b.maxY) / 2
      : clamp(cam.y, b.minY + halfH, b.maxY - halfH);
  },

  worldToScreenX(x) { return (x - this.camera.x) * this.view.scale + this.canvas.width / 2; },
  worldToScreenY(y) { return (y - this.camera.y) * this.view.scale + this.canvas.height / 2; },

  beginWorld() {
    const s = this.view.scale;
    this.ctx.save();
    this.ctx.setTransform(
      s, 0, 0, s,
      this.canvas.width / 2 - this.camera.x * s,
      this.canvas.height / 2 - this.camera.y * s
    );
  },

  endWorld() {
    this.ctx.restore();
  },

  // ---- static world pre-render --------------------------------------------

  renderTrackLayer(track) {
    const b = track.bounds;
    // Render at display scale where possible, backing off on huge displays.
    this.layerScale = Math.min(
      this.view.scale,
      MAX_LAYER_DIMENSION / b.width,
      MAX_LAYER_DIMENSION / b.height
    );
    const s = this.layerScale;

    const layer = document.createElement('canvas');
    layer.width = Math.max(1, Math.ceil(b.width * s));
    layer.height = Math.max(1, Math.ceil(b.height * s));
    const ctx = layer.getContext('2d');

    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, layer.width, layer.height);
    ctx.fillStyle = PALETTE.groundSpeckle;
    for (let i = 0; i < 2600; i++) {
      ctx.fillRect(Math.random() * layer.width, Math.random() * layer.height, 2, 2);
    }

    // World space, with the layer's top-left at (bounds.minX, bounds.minY).
    ctx.setTransform(s, 0, 0, s, -b.minX * s, -b.minY * s);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';

    const tracePath = (pts) => {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    };

    // Tarmac: the ring between the two barrier loops.
    ctx.beginPath();
    tracePath(track.wallRight);
    tracePath(track.wallLeft);
    ctx.fillStyle = PALETTE.surface;
    ctx.fill('evenodd');

    // Faint centreline seam.
    ctx.beginPath();
    tracePath(track.centerline);
    ctx.strokeStyle = PALETTE.surfaceSeam;
    ctx.lineWidth = 3;
    ctx.setLineDash([22, 36]);
    ctx.stroke();
    ctx.setLineDash([]);

    this.drawTrackEdges(ctx, track);
    this.drawBarriers(ctx, track);
    this.drawStartLine(ctx, track);

    this.trackLayer = layer;
  },

  // Kerbs through the corners, plain edge line down the straights. A point
  // counts as "corner" when the centreline radius is tighter than
  // KERB_MIN_RADIUS; both edges get kerbed there, as on a real circuit.
  drawTrackEdges(ctx, track) {
    const cl = track.centerline, nrm = track.normals;
    const curv = track.curvature, hw = track.halfWidths, arc = track.arc;
    const count = cl.length;
    const threshold = 1 / KERB_MIN_RADIUS;
    const isCorner = (i) => Math.abs(curv[i]) >= threshold;

    // Plain edge line, drawn only along the straights.
    ctx.strokeStyle = PALETTE.edgeLine;
    ctx.lineWidth = 2.5;
    for (const side of [1, -1]) {
      let drawing = false;
      ctx.beginPath();
      for (let i = 0; i <= count; i++) {
        const idx = i % count;
        if (isCorner(idx)) { drawing = false; continue; }
        const off = (hw[idx] - EDGE_LINE_INSET) * side;
        const x = cl[idx].x + nrm[idx].x * off;
        const y = cl[idx].y + nrm[idx].y * off;
        if (!drawing) { ctx.moveTo(x, y); drawing = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }

    // Red/white kerbs through the corners. Stripe index comes from arc length
    // so stripes stay a consistent, deliberately long size all the way round.
    ctx.lineWidth = KERB_WIDTH;
    for (const side of [1, -1]) {
      for (let i = 0; i < count; i++) {
        if (!isCorner(i)) continue;
        const j = (i + 1) % count;
        const offI = (hw[i] - KERB_WIDTH / 2) * side;
        const offJ = (hw[j] - KERB_WIDTH / 2) * side;
        ctx.strokeStyle = Math.floor(arc[i] / KERB_STRIPE_LENGTH) % 2 === 0
          ? PALETTE.kerbRed : PALETTE.kerbWhite;
        ctx.beginPath();
        ctx.moveTo(cl[i].x + nrm[i].x * offI, cl[i].y + nrm[i].y * offI);
        ctx.lineTo(cl[j].x + nrm[j].x * offJ, cl[j].y + nrm[j].y * offJ);
        ctx.stroke();
      }
    }
  },

  drawBarriers(ctx, track) {
    for (const pts of [track.wallRight, track.wallLeft]) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();

      ctx.strokeStyle = PALETTE.barrierEdge;
      ctx.lineWidth = 13;
      ctx.stroke();

      ctx.strokeStyle = PALETTE.barrier;
      ctx.lineWidth = 9;
      ctx.stroke();
    }
  },

  drawStartLine(ctx, track) {
    const g = track.gates[0];
    const across = Math.hypot(g.bx - g.ax, g.by - g.ay);
    const cols = 10;
    const cell = across / cols;
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.rotate(Math.atan2(g.by - g.ay, g.bx - g.ax));
    for (let row = -1; row < 1; row++) {
      for (let col = 0; col < cols; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? PALETTE.startPale : PALETTE.startDark;
        ctx.fillRect(-across / 2 + col * cell, row * cell, cell + 0.5, cell + 0.5);
      }
    }
    ctx.restore();
  },

  // Blit the pre-rendered world at the current camera position.
  drawTrack(track) {
    const ctx = this.ctx;
    const b = track.bounds;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(
      this.trackLayer,
      0, 0, this.trackLayer.width, this.trackLayer.height,
      this.worldToScreenX(b.minX), this.worldToScreenY(b.minY),
      b.width * this.view.scale, b.height * this.view.scale
    );
  },

  // ---- dynamic objects (call between beginWorld/endWorld) ------------------

  drawCar(car, bodyColor = '#ff5a4d', accentColor = '#f4f8fa', highlight = false) {
    const ctx = this.ctx;
    const w = CAR_LENGTH;
    const h = CAR_WIDTH;

    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    // drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.roundRect(-w / 2 + 3, -h / 2 + 4, w, h, 7);
    ctx.fill();

    // tires
    ctx.fillStyle = '#15181b';
    const tw = 13, th = 6;
    ctx.fillRect(-w / 2 + 5, -h / 2 - 2, tw, th);
    ctx.fillRect(-w / 2 + 5, h / 2 - th + 2, tw, th);
    ctx.fillRect(w / 2 - tw - 5, -h / 2 - 2, tw, th);
    ctx.fillRect(w / 2 - tw - 5, h / 2 - th + 2, tw, th);

    // body
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 7);
    ctx.fill();

    // the player's car gets a bright outline so it is findable in traffic
    if (highlight) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // cockpit
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(-2, -h / 2 + 6, 13, h - 12, 3);
    ctx.fill();

    // nose flash so heading is unmistakable at this zoom
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(w / 2 - 8, -3.5, 6, 7);

    ctx.restore();
  },

  // ---- start lights (screen space — call outside beginWorld/endWorld) ------

  // lights = { count, litCount, green } — green shows the gantry after lights out.
  drawStartLights(lights) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const r = Math.max(9, W * 0.016);          // lamp radius
    const gap = r * 2.9;                       // lamp spacing
    const count = lights.count;
    const panelW = gap * (count - 1) + r * 4;
    const panelH = r * 3.6;
    const cx = W / 2;
    const cy = panelH / 2 + r * 0.9;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();

    // housing
    ctx.fillStyle = LIGHT_COLORS.housing;
    ctx.strokeStyle = LIGHT_COLORS.housingEdge;
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.roundRect(cx - panelW / 2, cy - panelH / 2, panelW, panelH, r * 0.6);
    ctx.fill();
    ctx.stroke();

    for (let i = 0; i < count; i++) {
      const x = cx - (gap * (count - 1)) / 2 + i * gap;
      const lit = lights.green || i < lights.litCount;
      const color = lights.green ? LIGHT_COLORS.green : LIGHT_COLORS.red;
      const glow = lights.green ? LIGHT_COLORS.greenGlow : LIGHT_COLORS.redGlow;

      if (lit) {
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, cy, r * 1.75, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = lit ? color : LIGHT_COLORS.unlit;
      ctx.beginPath();
      ctx.arc(x, cy, r, 0, Math.PI * 2);
      ctx.fill();
      // a small highlight so an unlit lamp still reads as glass
      ctx.fillStyle = lit ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.arc(x - r * 0.3, cy - r * 0.34, r * 0.26, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  },

  // Faint tire marks while drifting.
  drawDriftMarks(car) {
    if (Math.abs(car.lateralSpeed) < 60) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-CAR_LENGTH / 2 + 3, -CAR_WIDTH / 2 - 2, 9, 5);
    ctx.fillRect(-CAR_LENGTH / 2 + 3, CAR_WIDTH / 2 - 3, 9, 5);
    ctx.restore();
  },
};
