// ============================================================================
// RENDER.JS — All canvas drawing. Cars and environment are drawn with
// primitives only (no images).
// ============================================================================

const Render = {
  ctx: null,
  canvas: null,

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  },

  clear() {
    const ctx = this.ctx;
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  },

  // Simple grid so motion is visible before the track exists.
  drawGrid(spacing = 50) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.canvas.width; x += spacing) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.canvas.height);
    }
    for (let y = 0; y <= this.canvas.height; y += spacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.canvas.width, y);
    }
    ctx.stroke();
  },

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

  // Faint tire marks while drifting (drawn immediately, no persistence yet).
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
