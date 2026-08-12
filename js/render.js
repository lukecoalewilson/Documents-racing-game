// ============================================================================
// RENDER.JS — All canvas drawing: pre-rendered track background, camera that
// follows the car, and cars drawn with primitives (no images anywhere).
// ============================================================================

const Render = {
  ctx: null,
  canvas: null,
  trackCanvas: null,   // offscreen canvas holding the full pre-rendered world
  camera: { x: 0, y: 0, worldW: 0, worldH: 0 },

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  },

  // ---- camera --------------------------------------------------------------

  snapCameraTo(x, y) {
    this.camera.x = x;
    this.camera.y = y;
    this.clampCamera();
  },

  updateCamera(car, dt) {
    const cam = this.camera;
    // Look slightly ahead of the car along its velocity so there's room to see.
    const targetX = car.x + car.vx * 0.35;
    const targetY = car.y + car.vy * 0.35;
    const k = 1 - Math.exp(-4 * dt); // framerate-independent smoothing
    cam.x += (targetX - cam.x) * k;
    cam.y += (targetY - cam.y) * k;
    this.clampCamera();
  },

  clampCamera() {
    const cam = this.camera;
    const hw = this.canvas.width / 2, hh = this.canvas.height / 2;
    cam.x = clamp(cam.x, hw, Math.max(hw, cam.worldW - hw));
    cam.y = clamp(cam.y, hh, Math.max(hh, cam.worldH - hh));
  },

  beginWorld() {
    const cam = this.camera;
    this.ctx.save();
    this.ctx.translate(
      Math.round(this.canvas.width / 2 - cam.x),
      Math.round(this.canvas.height / 2 - cam.y)
    );
  },

  endWorld() {
    this.ctx.restore();
  },

  // ---- track pre-render ----------------------------------------------------

  initTrack(track) {
    this.camera.worldW = track.worldW;
    this.camera.worldH = track.worldH;

    const tc = document.createElement('canvas');
    tc.width = track.worldW;
    tc.height = track.worldH;
    const ctx = tc.getContext('2d');

    // grass
    ctx.fillStyle = '#2d5a27';
    ctx.fillRect(0, 0, tc.width, tc.height);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (let i = 0; i < 2500; i++) {
      ctx.fillRect(Math.random() * tc.width, Math.random() * tc.height, 3, 3);
    }

    // track surface (ring between the two barrier loops)
    const tracePath = (pts) => {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    };
    ctx.beginPath();
    tracePath(track.leftWall);
    tracePath(track.rightWall);
    ctx.fillStyle = '#43454b';
    ctx.fill('evenodd');

    // subtle centreline dashes
    ctx.beginPath();
    tracePath(track.centerline);
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 3;
    ctx.setLineDash([18, 30]);
    ctx.stroke();
    ctx.setLineDash([]);

    // white edge lines just inside the barriers
    const edge = (pts, normSign) => {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = track.centerline[i], nrm = track.normals[i];
        const off = (track.halfW - 7) * normSign;
        const x = p.x + nrm.x * off, y = p.y + nrm.y * off;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    };
    edge(track.leftWall, 1);
    edge(track.rightWall, -1);

    // barriers: alternating red/white striped blocks
    const stripes = (pts) => {
      ctx.lineWidth = 10;
      ctx.lineCap = 'butt';
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        ctx.strokeStyle = i % 2 === 0 ? '#c8102e' : '#e8e8e8';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    };
    stripes(track.leftWall);
    stripes(track.rightWall);

    // start/finish checkered strip across the track at gate 0
    const g = track.gates[0];
    const across = Math.hypot(g.bx - g.ax, g.by - g.ay);
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.rotate(Math.atan2(g.by - g.ay, g.bx - g.ax));
    const cell = across / 14;
    for (let row = -1; row < 1; row++) {
      for (let col = 0; col < 14; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? '#f2f2f2' : '#111';
        ctx.fillRect(-across / 2 + col * cell, row * cell, cell, cell);
      }
    }
    ctx.restore();

    this.trackCanvas = tc;
  },

  drawTrack() {
    this.ctx.drawImage(this.trackCanvas, 0, 0);
  },

  // ---- dynamic objects (call between beginWorld/endWorld) -------------------

  drawCar(car, bodyColor = '#e33', accentColor = '#fff') {
    const ctx = this.ctx;
    const w = 34; // car length (along heading)
    const h = 18; // car width

    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-w / 2 + 2, -h / 2 + 3, w, h);

    // tires (four corners, slightly inset)
    ctx.fillStyle = '#111';
    const tw = 8, th = 4;
    ctx.fillRect(-w / 2 + 3, -h / 2 - 1, tw, th);
    ctx.fillRect(-w / 2 + 3, h / 2 - th + 1, tw, th);
    ctx.fillRect(w / 2 - tw - 3, -h / 2 - 1, tw, th);
    ctx.fillRect(w / 2 - tw - 3, h / 2 - th + 1, tw, th);

    // body
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 5);
    ctx.fill();

    // windshield / cockpit
    ctx.fillStyle = accentColor;
    ctx.fillRect(w / 6 - 4, -h / 2 + 4, 8, h - 8);

    // nose stripe so heading is obvious
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(w / 2 - 6, -2, 5, 4);

    ctx.restore();
  },

  // Faint tire marks while drifting.
  drawDriftMarks(car) {
    if (Math.abs(car.lateralSpeed) < 60) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-14, -10, 5, 3);
    ctx.fillRect(-14, 7, 5, 3);
    ctx.restore();
  },
};
