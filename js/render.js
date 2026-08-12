// ============================================================================
// RENDER.JS — All canvas drawing. Everything is primitives; no images.
//
// CAMERA: fixed. The whole circuit is scaled and centred to fit the canvas,
// with the zoom derived from the track's bounding box, so editing the layout
// in track.js automatically refits. Nothing scrolls.
//
// The static parts of the world (ground, tarmac, kerbs, barriers, start line)
// are pre-rendered once into an offscreen layer at display resolution, so a
// frame costs one blit plus the cars.
// ============================================================================

// --- Colour palette. Calm and low-contrast by design: the cars are meant to
// --- be the brightest, most saturated things on screen.
const PALETTE = {
  ground:        '#232a29',              // surrounding grass / infield
  groundSpeckle: 'rgba(255,255,255,0.014)',
  surface:       '#414a52',              // tarmac — slightly darker than the barriers
  surfaceSeam:   'rgba(206,220,230,0.07)', // faint centreline dashes
  edgeLine:      'rgba(198,214,226,0.26)', // thin lighter line marking the track edge
  barrier:       '#6d7f90',              // muted grey-blue barrier
  barrierEdge:   'rgba(28,34,40,0.35)',  // slight darkening under the barrier for depth
  kerbRed:       '#8a5c58',              // desaturated red, low contrast against...
  kerbPale:      '#8d979e',              // ...this muted grey
  startPale:     '#9aa6ae',              // kept dimmer than the cars on purpose
  startDark:     '#3b444b',
};

// Kerbs only appear where the track is genuinely cornering: anywhere the
// radius is tighter than this, on the inside of the bend.
const KERB_MIN_RADIUS = 400;   // px — larger value = kerbs on more of the lap
const KERB_WIDTH = 17;         // px, world space
const KERB_STRIPE_POINTS = 6;  // centreline samples per stripe (wider = calmer)
const EDGE_LINE_INSET = 15;    // px inboard of the barrier

// Car dimensions in world px. Sized so the car stays readable at the
// fit-to-screen zoom while still leaving room for four abreast on a
// 150px-wide track.
const CAR_LENGTH = 56;
const CAR_WIDTH = 28;

const Render = {
  ctx: null,
  canvas: null,
  trackLayer: null,                        // offscreen canvas, display resolution
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  margin: 18,                              // CSS px of breathing room around the track

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  },

  // ---- fixed camera --------------------------------------------------------

  // Size the canvas to its container and refit the track. Call on load and
  // whenever the window resizes.
  resize(track) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.computeView(track, dpr);
    this.renderTrackLayer(track);
  },

  // Derive zoom and centring from the track's bounding box so any layout fits.
  computeView(track, dpr) {
    const b = track.bounds;
    const m = this.margin * dpr;
    const availW = this.canvas.width - m * 2;
    const availH = this.canvas.height - m * 2;
    const scale = Math.min(availW / b.width, availH / b.height);
    this.view.scale = scale;
    this.view.offsetX = (this.canvas.width - b.width * scale) / 2 - b.minX * scale;
    this.view.offsetY = (this.canvas.height - b.height * scale) / 2 - b.minY * scale;
  },

  // Apply the world→screen transform to a context.
  applyWorldTransform(ctx) {
    const v = this.view;
    ctx.setTransform(v.scale, 0, 0, v.scale, v.offsetX, v.offsetY);
  },

  beginWorld() {
    this.ctx.save();
    this.applyWorldTransform(this.ctx);
  },

  endWorld() {
    this.ctx.restore();
  },

  // ---- static world pre-render --------------------------------------------

  renderTrackLayer(track) {
    const w = this.canvas.width, h = this.canvas.height;
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const ctx = layer.getContext('2d');

    // Ground, in screen space so it always covers the canvas.
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = PALETTE.groundSpeckle;
    for (let i = 0; i < 1600; i++) {
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }

    ctx.save();
    this.applyWorldTransform(ctx);
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
    ctx.setLineDash([20, 34]);
    ctx.stroke();
    ctx.setLineDash([]);

    this.drawKerbs(ctx, track);
    this.drawEdgeLines(ctx, track);
    this.drawBarriers(ctx, track);
    this.drawStartLine(ctx, track);

    ctx.restore();
    this.trackLayer = layer;
  },

  // Kerbs run along the INSIDE of corners only — the side the track curves
  // toward. track.curvature is signed: positive turns toward the normal
  // (driver's right), negative toward the left.
  drawKerbs(ctx, track) {
    const cl = track.centerline, nrm = track.normals, curv = track.curvature;
    const count = cl.length;
    const threshold = 1 / KERB_MIN_RADIUS;
    const offset = track.halfW - KERB_WIDTH / 2;

    ctx.lineWidth = KERB_WIDTH;
    ctx.lineCap = 'butt';

    for (let i = 0; i < count; i++) {
      const k = curv[i];
      if (Math.abs(k) < threshold) continue;
      const side = k > 0 ? 1 : -1; // +1 = driver's right, -1 = driver's left
      const j = (i + 1) % count;
      // Both endpoints use side from point i, so a left/right transition just
      // ends one kerb and starts the other — it never draws across the track.
      const ax = cl[i].x + nrm[i].x * offset * side;
      const ay = cl[i].y + nrm[i].y * offset * side;
      const bx = cl[j].x + nrm[j].x * offset * side;
      const by = cl[j].y + nrm[j].y * offset * side;

      ctx.strokeStyle = Math.floor(i / KERB_STRIPE_POINTS) % 2 === 0
        ? PALETTE.kerbRed : PALETTE.kerbPale;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  },

  // Thin lighter line just inboard of each barrier.
  drawEdgeLines(ctx, track) {
    const cl = track.centerline, nrm = track.normals;
    const offset = track.halfW - EDGE_LINE_INSET;
    ctx.strokeStyle = PALETTE.edgeLine;
    ctx.lineWidth = 2.5;
    for (const side of [1, -1]) {
      ctx.beginPath();
      for (let i = 0; i < cl.length; i++) {
        const x = cl[i].x + nrm[i].x * offset * side;
        const y = cl[i].y + nrm[i].y * offset * side;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  },

  // Solid muted grey-blue barriers, with a soft dark line under them so the
  // wall reads as raised without adding contrast.
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

  // Muted checkered strip across the track at gate 0.
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

  drawTrack() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.trackLayer, 0, 0);
  },

  // ---- dynamic objects (call between beginWorld/endWorld) ------------------

  drawCar(car, bodyColor = '#ff5a4d', accentColor = '#f4f8fa') {
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
