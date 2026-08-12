// ============================================================================
// AI.JS — Computer-controlled drivers.
//
// The bots use exactly the same Car physics as the player: they produce the
// same {accelerate, brake, steer, handbrake} input object the keyboard does,
// hand it to Car.update(), and get collided against the walls by the same
// collideCarWithTrack(). Nothing here moves a car directly.
//
// Everything is derived from the track data in track.js, so re-shaping the
// circuit automatically re-derives the racing line and the braking points:
//
//   1. RACING LINE — start from the centreline and repeatedly pull each point
//      toward the midpoint of its neighbours, clamped inside the track
//      corridor. That relaxes into a taut, smooth line that cuts corners and
//      straightens the esses (a shortest-path line, close enough to a real
//      racing line for this purpose).
//   2. CORNER SPEEDS — for each point, the fastest speed at which the car's
//      steering can still hold that radius, from the physics constants.
//   3. BRAKING POINTS — sweep backwards around the line, capping each point's
//      speed at what can be scrubbed off before the next one. That turns the
//      corner speeds into a profile that tells a bot to lift and brake well
//      before the corner arrives, then lets it accelerate back out.
// ============================================================================

const AI_TUNING = {
  // --- racing line construction ---
  // The margin has to cover the car's radius plus everything that pushes a bot
  // off the line — its lineBias, its wander, and the corner-cutting inherent
  // in aiming ahead. Too small and the slower, longer-sighted bots scrape.
  LINE_MARGIN: 38,        // px kept clear of the barrier, so the line never hugs a wall
  LINE_ITERATIONS: 400,   // relaxation passes; more = tauter line
  LINE_RELAX: 0.28,       // how far each point moves per pass (lower = more stable)
  LINE_STEP: 6,           // neighbour distance in samples; larger = smoother, wider line

  // --- shared driving behaviour (per-bot multipliers live in BOT_PROFILES) ---
  LOOKAHEAD_BASE: 52,     // px ahead the bot aims when crawling
  LOOKAHEAD_PER_SPEED: 0.28, // extra px of lookahead per px/s of speed
  // Aiming far ahead makes a car cut the inside of a corner by roughly
  // lookahead^2/(8*radius), so the lookahead is shortened in proportion to how
  // tight the line is right here. Raise this to cut corners less, at the cost
  // of twitchier steering.
  LOOKAHEAD_CURVE_TIGHTEN: 150,
  SPEED_LOOKAHEAD: 0.35,  // seconds ahead used when reading the speed profile
  BRAKE_TOLERANCE: 1.04,  // brake once above target speed by this factor
  SPIN_RECOVERY_ANGLE: 1.25, // rad of heading error before a bot lifts off
  STUCK_SPEED: 28,        // px/s under which a bot is considered stuck
  STUCK_TIME: 1.1,        // s of being stuck before reversing out
  REVERSE_TIME: 0.85,     // s spent reversing when unstuck-ing
};

// Three distinct drivers. cornerSpeed is the big one — it scales how close to
// the theoretical limit they take corners, and so how fast the lap is.
const BOT_PROFILES = [
  {
    name: 'VOSS', color: '#4db8ff',
    cornerSpeed: 0.82,      // quickest through corners
    topSpeed: 1.00,
    brakeDecel: 1150,       // px/s^2 assumed when planning braking points
    lookaheadMul: 1.00,
    steerGain: 3.0,
    lineBias: 0,            // px off the ideal line (+ = driver's right)
    wander: 4, wanderRate: 0.50,
  },
  {
    name: 'RIVA', color: '#ffc94d',
    cornerSpeed: 0.745,     // roughly a match for a tidy human lap
    topSpeed: 0.96,
    brakeDecel: 1050,
    lookaheadMul: 1.05,
    steerGain: 2.8,
    lineBias: 7,
    wander: 5, wanderRate: 0.37,
  },
  {
    name: 'KOSS', color: '#7ee081',
    cornerSpeed: 0.665,     // noticeably slower, brakes early
    topSpeed: 0.91,
    brakeDecel: 980,
    lookaheadMul: 1.10,
    steerGain: 2.6,
    lineBias: -8,
    wander: 6, wanderRate: 0.29,
  },
];

// ---------------------------------------------------------------------------
// Racing line
// ---------------------------------------------------------------------------

function buildRacingLine(track) {
  const cl = track.centerline, nrm = track.normals;
  const n = cl.length;
  const step = AI_TUNING.LINE_STEP;

  const limits = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    limits[i] = Math.max(0, track.halfWidths[i] - AI_TUNING.LINE_MARGIN);
  }

  // Signed offset from the centreline along each normal.
  const off = new Float64Array(n);
  const px = (i) => cl[i].x + nrm[i].x * off[i];
  const py = (i) => cl[i].y + nrm[i].y * off[i];

  for (let iter = 0; iter < AI_TUNING.LINE_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) {
      const a = (i - step + n) % n, b = (i + step) % n;
      const mx = (px(a) + px(b)) / 2, my = (py(a) + py(b)) / 2;
      // Project the neighbour midpoint onto this point's normal — that is the
      // offset that would put point i on the chord between its neighbours.
      const want = (mx - cl[i].x) * nrm[i].x + (my - cl[i].y) * nrm[i].y;
      off[i] = clamp(off[i] + (want - off[i]) * AI_TUNING.LINE_RELAX, -limits[i], limits[i]);
    }
  }

  // Bake the line into waypoints with their own tangents, normals, curvature
  // and segment lengths.
  const line = [];
  for (let i = 0; i < n; i++) {
    line.push({ x: px(i), y: py(i), nx: 0, ny: 0, curvature: 0, segLength: 0 });
  }
  for (let i = 0; i < n; i++) {
    const prev = line[(i - 1 + n) % n], next = line[(i + 1) % n];
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    line[i].nx = -ty / tl;
    line[i].ny = tx / tl;
    line[i].segLength = Math.hypot(next.x - line[i].x, next.y - line[i].y);
  }
  // Curvature over a window, same circumradius method the track uses.
  const W = 5;
  for (let i = 0; i < n; i++) {
    const a = line[(i - W + n) % n], b = line[i], c = line[(i + W) % n];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const denom = ab * bc * ca;
    line[i].curvature = denom > 1e-9 ? (2 * cross) / denom : 0;
  }
  return line;
}

// The fastest speed at which the car's steering can still hold radius R.
// Derived from the physics constants: yaw rate falls off with speed, so
// solving v/R = TURN_RATE * (1 - (1-falloff) * v/MAX_SPEED) for v gives this.
// The car also slides a little in every corner, which this ideal model does
// not capture — that is what each bot's cornerSpeed factor discounts.
function steeringLimitedSpeed(radius) {
  const T = PHYSICS.TURN_RATE;
  const F = PHYSICS.HIGH_SPEED_STEER_FALLOFF;
  const V = PHYSICS.MAX_SPEED;
  return (T * radius) / (1 + (T * (1 - F) * radius) / V);
}

// Corner speeds plus a backward pass that turns them into braking points.
function buildSpeedProfile(line, profile) {
  const n = line.length;
  const topSpeed = PHYSICS.MAX_SPEED * profile.topSpeed;
  const v = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const k = Math.abs(line[i].curvature);
    v[i] = k < 1e-7
      ? topSpeed
      : Math.min(topSpeed, profile.cornerSpeed * steeringLimitedSpeed(1 / k));
  }

  // Sweep backwards so every point is slow enough to still make what follows.
  // Two laps of the loop, because the profile wraps around.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const reachable = Math.sqrt(v[j] * v[j] + 2 * profile.brakeDecel * line[i].segLength);
      if (v[i] > reachable) v[i] = reachable;
    }
  }
  return v;
}

// Shared line geometry; each bot gets its own speed profile over it.
const RACING_LINE = buildRacingLine(TRACK);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Nearest waypoint, searching outward from a cached index rather than
// rescanning the whole line every frame.
function nearestLineIndex(line, x, y, hint) {
  const n = line.length;
  const d2 = (i) => {
    const dx = line[i].x - x, dy = line[i].y - y;
    return dx * dx + dy * dy;
  };
  let best = hint, bestD = d2(hint);
  for (let s = 1; s <= 45; s++) {
    const f = (hint + s) % n, b = (hint - s + n) % n;
    const df = d2(f), db = d2(b);
    if (df < bestD) { bestD = df; best = f; }
    if (db < bestD) { bestD = db; best = b; }
  }
  return best;
}

// Walk forward along the line by a distance in px.
function advanceLineIndex(line, i, distance) {
  const n = line.length;
  let remaining = distance;
  let idx = i;
  let guard = 0;
  while (remaining > 0 && guard++ < n) {
    remaining -= line[idx].segLength;
    idx = (idx + 1) % n;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

class AIDriver {
  constructor(car, profile, line) {
    this.car = car;
    this.profile = profile;
    this.line = line;
    this.speeds = buildSpeedProfile(line, profile);
    this.index = 0;
    this.stuckTimer = 0;
    this.reverseTimer = 0;
    this.wanderPhase = Math.random() * Math.PI * 2;

    // Seed the cached index with a full scan from the spawn position.
    let best = 0, bestD = Infinity;
    for (let i = 0; i < line.length; i++) {
      const dx = line[i].x - car.x, dy = line[i].y - car.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.index = best;
  }

  // Returns the same input object the keyboard produces.
  update(dt, time) {
    const car = this.car;
    const p = this.profile;
    const line = this.line;

    this.index = nearestLineIndex(line, car.x, car.y, this.index);
    const speed = Math.abs(car.forwardSpeed);

    // --- stuck detection: reverse out rather than grinding a wall forever ---
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      const aim = line[advanceLineIndex(line, this.index, 60)];
      const err = normalizeAngle(Math.atan2(aim.y - car.y, aim.x - car.x) - car.angle);
      // Steering inverts in reverse, so flip it to back toward the line.
      return { accelerate: false, brake: true, steer: clamp(-err * 2, -1, 1), handbrake: false };
    }
    if (speed < AI_TUNING.STUCK_SPEED) {
      this.stuckTimer += dt;
      if (this.stuckTimer > AI_TUNING.STUCK_TIME) {
        this.stuckTimer = 0;
        this.reverseTimer = AI_TUNING.REVERSE_TIME;
      }
    } else {
      this.stuckTimer = 0;
    }

    // --- steering: aim at a point well ahead on the line, never the nearest ---
    // Pull the aim point in through tight corners so the bot tracks the line
    // instead of chording across its apex into the barrier.
    const localCurv = Math.abs(line[this.index].curvature);
    const tighten = 1 / (1 + localCurv * AI_TUNING.LOOKAHEAD_CURVE_TIGHTEN);
    const lookahead = (AI_TUNING.LOOKAHEAD_BASE + speed * AI_TUNING.LOOKAHEAD_PER_SPEED)
      * p.lookaheadMul * tighten;
    const aimIdx = advanceLineIndex(line, this.index, lookahead);
    const aim = line[aimIdx];
    // A small constant offset plus a slow wander keeps the three of them from
    // driving one identical line nose-to-tail.
    const bias = p.lineBias + Math.sin(time * p.wanderRate + this.wanderPhase) * p.wander;
    const aimX = aim.x + aim.nx * bias;
    const aimY = aim.y + aim.ny * bias;

    const err = normalizeAngle(Math.atan2(aimY - car.y, aimX - car.x) - car.angle);
    const steer = clamp(err * p.steerGain, -1, 1);

    // --- speed: read the braking-aware profile at, and a little beyond, the
    // --- current point, so reaction lag doesn't blow the corner entry ---
    const aheadIdx = advanceLineIndex(line, this.index,
      Math.max(35, speed * AI_TUNING.SPEED_LOOKAHEAD));
    const target = Math.min(this.speeds[this.index], this.speeds[aheadIdx]);

    // Badly misaligned (spun or knocked off) — stop trying to accelerate.
    const misaligned = Math.abs(err) > AI_TUNING.SPIN_RECOVERY_ANGLE;
    const brake = misaligned ? speed > 60 : speed > target * AI_TUNING.BRAKE_TOLERANCE;

    return {
      accelerate: !brake && !misaligned && speed < target,
      brake,
      steer,
      handbrake: false,
    };
  }
}
