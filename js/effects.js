// ============================================================================
// EFFECTS.JS — Tyre skid marks and tyre smoke.
//
// Both are driven off the lateral (sideways) velocity physics.js already
// computes for each car, so they trigger on exactly the same slip the driving
// model feels. Per tyre the slip is
//
//     tyreSlip = |car.lateralSpeed + car.angularVelocity * tyreOffsetAlongCar|
//
// which means a car rotating into a slide marks harder at the end that is
// swinging round — a gentle corner leaves a faint line, a full handbrake turn
// leaves black.
//
// SKID MARKS live on their own offscreen canvas held in WORLD coordinates and
// composited with the camera transform, so they stay welded to the tarmac when
// the camera pans. That layer is never cleared mid-race: marks accumulate over
// all five laps, held in check by a periodic fade rather than a wipe.
//
// SMOKE uses a fixed particle pool that is allocated once and recycled; the
// per-frame path never creates an object.
// ============================================================================

// --- SKID MARK TUNING -------------------------------------------------------
const SKID = {
  MIN_SLIP: 40,          // px/s of tyre slip before anything is laid down
  FULL_SLIP: 260,        // slip at which marks reach MAX_ALPHA (full black)
  MAX_ALPHA: 0.55,       // darkness of a fully locked tyre
  WIDTH: 6,              // mark width in world px (tyres are ~6 wide)

  // Accumulation control. The layer is never wiped during a race; instead a
  // fade pass gently erases everything, so the oldest marks are always the
  // faintest and the track cannot go solid black by lap 4.
  FADE_INTERVAL: 1.6,    // seconds between fade passes
  FADE_STRENGTH: 0.05,   // fraction of remaining darkness removed per pass
  MAX_MARKS: 4000,       // segments laid before a fade is forced early

  MIN_SEGMENT: 0.8,      // px — ignore sub-pixel movement
  MAX_SEGMENT: 140,      // px — don't streak across a teleport//tab-switch
};

// --- SMOKE TUNING -----------------------------------------------------------
const SMOKE = {
  MIN_SLIP: 85,          // px/s of tyre slip before a puff appears
  FULL_SLIP: 300,        // slip at which spawn rate and opacity peak
  SPAWN_PER_SEC: 55,     // puffs per second per car at full slip
  HANDBRAKE_MULTIPLIER: 2.2, // heavier smoke when the handbrake is pulled

  LIFETIME: 1.0,         // seconds from spawn to fully faded
  START_RADIUS: 7,       // world px
  END_RADIUS: 27,        // world px — puffs expand as they age
  MAX_ALPHA: 0.40,

  DRIFT_FACTOR: 0.28,    // fraction of the car's velocity a puff inherits
  DRIFT_DAMPING: 1.7,    // how fast that drift bleeds off (per second)
  SPREAD: 26,            // px/s of random scatter at birth

  POOL_SIZE: 600,        // fixed pool; never grows, never allocates in-frame
};

// Tyre positions in car-local space. x is along the car (+ = nose), y is
// across it. These mirror the wheels drawn in render.js.
const TYRES = [
  { x: 16.5, y: -13, rear: false },
  { x: 16.5, y: 13, rear: false },
  { x: -16.5, y: -13, rear: true },
  { x: -16.5, y: 13, rear: true },
];

// Slip at a given tyre, from the car's own lateral velocity and yaw rate.
function tyreSlip(car, tyre) {
  return Math.abs(car.lateralSpeed + car.angularVelocity * tyre.x);
}

// Tyre position in world space.
function tyreWorldPos(car, tyre, out) {
  const c = Math.cos(car.angle), s = Math.sin(car.angle);
  out.x = car.x + tyre.x * c - tyre.y * s;
  out.y = car.y + tyre.x * s + tyre.y * c;
  return out;
}

// ---------------------------------------------------------------------------
// Skid marks — a persistent world-space layer
// ---------------------------------------------------------------------------

const SkidMarks = {
  canvas: null,
  ctx: null,
  scale: 1,
  bounds: null,
  fadeTimer: 0,
  markCount: 0,
  prev: new Map(),      // car -> array of previous tyre world positions
  _p: { x: 0, y: 0 },   // scratch, so emit() allocates nothing

  // Sized and transformed exactly like the pre-rendered track layer, so the
  // two composite with the same camera maths.
  init(track, layerScale) {
    const b = track.bounds;
    const previous = this.canvas;
    const w = Math.max(1, Math.ceil(b.width * layerScale));
    const h = Math.max(1, Math.ceil(b.height * layerScale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Carry existing marks across a resize rather than losing the race's history.
    if (previous) ctx.drawImage(previous, 0, 0, w, h);

    ctx.setTransform(layerScale, 0, 0, layerScale, -b.minX * layerScale, -b.minY * layerScale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this.canvas = canvas;
    this.ctx = ctx;
    this.scale = layerScale;
    this.bounds = b;
  },

  // Wipe everything — only on restart, never mid-race.
  clear() {
    if (!this.ctx) return;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this.prev.clear();
    this.fadeTimer = 0;
    this.markCount = 0;
  },

  // Forget where a car's tyres were, so it doesn't streak a line across the
  // track after being repositioned.
  resetCar(car) {
    this.prev.delete(car);
  },

  emit(car) {
    if (!this.ctx) return;
    let last = this.prev.get(car);
    if (!last) {
      last = TYRES.map(() => ({ x: 0, y: 0, valid: false }));
      this.prev.set(car, last);
    }

    const ctx = this.ctx;
    ctx.lineWidth = SKID.WIDTH;

    for (let i = 0; i < TYRES.length; i++) {
      const t = TYRES[i];
      const p = tyreWorldPos(car, t, this._p);
      const prev = last[i];
      const slip = tyreSlip(car, t);

      if (slip >= SKID.MIN_SLIP && prev.valid) {
        const dx = p.x - prev.x, dy = p.y - prev.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= SKID.MIN_SEGMENT && dist <= SKID.MAX_SEGMENT) {
          const heat = clamp((slip - SKID.MIN_SLIP) / (SKID.FULL_SLIP - SKID.MIN_SLIP), 0, 1);
          ctx.strokeStyle = `rgba(12,12,14,${(heat * SKID.MAX_ALPHA).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          this.markCount++;
        }
      }
      prev.x = p.x;
      prev.y = p.y;
      prev.valid = true;
    }
  },

  update(dt) {
    if (!this.ctx) return;
    this.fadeTimer += dt;
    if (this.fadeTimer >= SKID.FADE_INTERVAL || this.markCount >= SKID.MAX_MARKS) {
      this.fade();
      this.fadeTimer = 0;
      this.markCount = 0;
    }
  },

  // Erase a slice of every mark. Old marks have been through more passes, so
  // they are always fainter than fresh ones.
  fade() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${SKID.FADE_STRENGTH})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
// Smoke — fixed pool of recycled particles, drawn above the cars
// ---------------------------------------------------------------------------

const Smoke = {
  pool: [],
  nextIndex: 0,
  sprite: null,
  spawnCredit: new Map(),  // car -> fractional puffs owed
  _p: { x: 0, y: 0 },

  init() {
    if (this.pool.length === 0) {
      for (let i = 0; i < SMOKE.POOL_SIZE; i++) {
        this.pool.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, age: 0, alpha: 0 });
      }
    }
    if (!this.sprite) this.sprite = this.buildSprite();
  },

  // One soft puff, pre-rendered once. Drawing a scaled image beats building a
  // radial gradient per particle per frame.
  buildSprite() {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(214,218,222,0.95)');
    grad.addColorStop(0.45, 'rgba(198,203,209,0.45)');
    grad.addColorStop(1, 'rgba(190,196,203,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  },

  clear() {
    for (const p of this.pool) p.active = false;
    this.spawnCredit.clear();
  },

  // Grab a dead particle. Returns null when the pool is exhausted — smoke
  // thins out rather than allocating.
  acquire() {
    const n = this.pool.length;
    for (let k = 0; k < n; k++) {
      const i = (this.nextIndex + k) % n;
      if (!this.pool[i].active) {
        this.nextIndex = (i + 1) % n;
        return this.pool[i];
      }
    }
    return null;
  },

  emit(car, handbrake, dt) {
    // Smoke comes off the rear tyres, using the worse of the two.
    let slip = 0;
    for (const t of TYRES) {
      if (!t.rear) continue;
      const s = tyreSlip(car, t);
      if (s > slip) slip = s;
    }
    if (slip < SMOKE.MIN_SLIP) {
      this.spawnCredit.set(car, 0);
      return;
    }

    const heat = clamp((slip - SMOKE.MIN_SLIP) / (SMOKE.FULL_SLIP - SMOKE.MIN_SLIP), 0, 1);
    const rate = SMOKE.SPAWN_PER_SEC * heat * (handbrake ? SMOKE.HANDBRAKE_MULTIPLIER : 1);

    let credit = (this.spawnCredit.get(car) || 0) + rate * dt;
    while (credit >= 1) {
      credit -= 1;
      const p = this.acquire();
      if (!p) break;
      // alternate rear tyres
      const t = TYRES[Math.random() < 0.5 ? 2 : 3];
      const pos = tyreWorldPos(car, t, this._p);
      p.active = true;
      p.x = pos.x;
      p.y = pos.y;
      // Drift along the direction the car was travelling, plus scatter.
      p.vx = car.vx * SMOKE.DRIFT_FACTOR + (Math.random() - 0.5) * SMOKE.SPREAD;
      p.vy = car.vy * SMOKE.DRIFT_FACTOR + (Math.random() - 0.5) * SMOKE.SPREAD;
      p.age = 0;
      p.alpha = SMOKE.MAX_ALPHA * (0.45 + 0.55 * heat);
    }
    this.spawnCredit.set(car, credit);
  },

  update(dt) {
    const damp = Math.max(0, 1 - SMOKE.DRIFT_DAMPING * dt);
    for (const p of this.pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= SMOKE.LIFETIME) { p.active = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= damp;
      p.vy *= damp;
    }
  },

  // World space — call inside the camera transform, after the cars.
  draw(ctx) {
    const img = this.sprite;
    for (const p of this.pool) {
      if (!p.active) continue;
      const life = p.age / SMOKE.LIFETIME;
      const r = SMOKE.START_RADIUS + (SMOKE.END_RADIUS - SMOKE.START_RADIUS) * life;
      // fade in briefly, then out for the rest of the life
      const fade = life < 0.15 ? life / 0.15 : 1 - (life - 0.15) / 0.85;
      ctx.globalAlpha = p.alpha * fade;
      ctx.drawImage(img, p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  },

  activeCount() {
    let n = 0;
    for (const p of this.pool) if (p.active) n++;
    return n;
  },
};
