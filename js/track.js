// ============================================================================
// TRACK.JS — The circuit, defined as DATA: a list of centreline control
// points (each with its own track width) smoothed into a closed loop.
// Everything else — barriers, wall collision segments, curvature, checkpoint
// gates, bounding box, start pose — is derived from that, so you reshape the
// circuit by editing TRACK_DATA only. The AI racing line in ai.js is derived
// from this same data, so it re-derives itself whenever the layout changes.
//
// Control point format: [x, y, width]. Width is optional and falls back to
// defaultWidth; it is interpolated smoothly between points, so make fast
// sections wide and technical sections narrow. Points are world-space pixels,
// y grows downward. Keep corner radii comfortably larger than width/2 or the
// inner barrier will pinch shut.
// ============================================================================

// Race length. This is the only place the lap count is defined.
const RACE_LAPS = 5;

const TRACK_DATA = {
  defaultWidth: 150,
  checkpointCount: 16,  // invisible ordered gates (gate 0 = start/finish line)

  controlPoints: [
    // --- Start/finish straight: long, wide, heading +x (~1800px to build speed)
    [820, 2150, 176],
    [1450, 2185, 176],
    [2080, 2180, 172],
    [2650, 2105, 166],

    // --- Turn 1: decreasing-radius right-hander. Opens gently, then tightens
    // --- and narrows all the way to the exit. Also the blind one: from the
    // --- braking zone you cannot see where it lets you out.
    [3080, 1960, 158],
    [3360, 1715, 148],
    [3480, 1430, 140],
    [3470, 1150, 138],

    // --- Fast flowing S-section across the top: wide, alternating direction
    [3330, 890, 152],
    [3060, 720, 162],
    [2760, 700, 164],
    [2470, 810, 162],
    [2180, 800, 162],
    [1900, 640, 158],
    [1620, 570, 156],
    [1330, 620, 150],

    // --- Sweep left and down onto the back section, narrowing
    [1030, 560, 146],
    [760, 645, 140],
    [620, 855, 136],
    [640, 1090, 134],

    // --- Technical infield entry: tight, narrow
    [775, 1290, 130],
    [1005, 1380, 126],
    [1235, 1420, 124],

    // --- The hairpin: genuine 180, tightest and narrowest part of the lap
    [1405, 1530, 120],
    [1395, 1705, 120],
    [1210, 1785, 122],

    // --- Return leg, opening back up
    [980, 1795, 132],
    [765, 1835, 138],

    // --- Final corner: a constant-radius 180 back onto the start/finish
    // --- straight. Radius ~158 against a 138-wide track leaves the inner
    // --- barrier a healthy margin — tighten this and it pinches shut.
    [640, 1837, 140],
    [520, 1885, 138],
    [482, 1995, 138],
    [520, 2108, 142],
    [645, 2152, 152],
  ],
};

// ---------------------------------------------------------------------------
// Track construction (derived data — no tuning knobs below this line)
// ---------------------------------------------------------------------------

function buildTrack(data) {
  const cps = data.controlPoints;
  const n = cps.length;
  const widthOf = (p) => (p.length > 2 ? p[2] : data.defaultWidth);

  // --- Catmull-Rom sample of the closed control polygon into a dense
  // --- centreline. Width is interpolated linearly over the same parameter.
  const centerline = [];
  const rawWidth = [];
  const SAMPLE_SPACING = 12; // approx px between dense points
  for (let i = 0; i < n; i++) {
    const p0 = cps[(i - 1 + n) % n];
    const p1 = cps[i];
    const p2 = cps[(i + 1) % n];
    const p3 = cps[(i + 2) % n];
    const w1 = widthOf(p1), w2 = widthOf(p2);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(4, Math.round(segLen / SAMPLE_SPACING));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t, t3 = t2 * t;
      centerline.push({
        x: 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        y: 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      });
      rawWidth.push(w1 + (w2 - w1) * t);
    }
  }

  const count = centerline.length;

  // Smooth the width so it eases between sections instead of kinking at
  // control points.
  const halfWidths = [];
  const W_SMOOTH = 7;
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = -W_SMOOTH; k <= W_SMOOTH; k++) sum += rawWidth[(i + k + count) % count];
    halfWidths.push(sum / (W_SMOOTH * 2 + 1) / 2);
  }

  // --- tangents, normals, cumulative arc length ---
  // Normals point to the DRIVER'S RIGHT (y grows downward, so rotating the
  // tangent by +90° in screen space lands on the right-hand side of travel).
  const tangents = [], normals = [], arc = [];
  let totalLength = 0;
  for (let i = 0; i < count; i++) {
    const prev = centerline[(i - 1 + count) % count];
    const next = centerline[(i + 1) % count];
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    tangents.push({ x: tx / tl, y: ty / tl });
    normals.push({ x: -ty / tl, y: tx / tl });
  }
  for (let i = 0; i < count; i++) {
    arc.push(totalLength);
    const next = centerline[(i + 1) % count];
    totalLength += Math.hypot(next.x - centerline[i].x, next.y - centerline[i].y);
  }

  // --- signed curvature (1/radius) at each point ---
  // Positive = turning right (toward +normal), negative = turning left.
  // Drives kerb placement here and corner speeds in ai.js.
  const CURV_WINDOW = 4;
  const rawCurv = [];
  for (let i = 0; i < count; i++) {
    const a = centerline[(i - CURV_WINDOW + count) % count];
    const b = centerline[i];
    const c = centerline[(i + CURV_WINDOW) % count];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const denom = ab * bc * ca;
    rawCurv.push(denom > 1e-9 ? (2 * cross) / denom : 0);
  }
  // Smooth it so corner entry/exit doesn't flicker between points.
  const curvature = [];
  const SMOOTH = 3;
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) sum += rawCurv[(i + k + count) % count];
    curvature.push(sum / (SMOOTH * 2 + 1));
  }

  // --- barrier polylines offset from the centreline ---
  // wallRight sits on the driver's right, wallLeft on the driver's left.
  const wallRight = [], wallLeft = [];
  for (let i = 0; i < count; i++) {
    const hw = halfWidths[i];
    wallRight.push({
      x: centerline[i].x + normals[i].x * hw,
      y: centerline[i].y + normals[i].y * hw,
    });
    wallLeft.push({
      x: centerline[i].x - normals[i].x * hw,
      y: centerline[i].y - normals[i].y * hw,
    });
  }

  // --- wall collision segments (both closed loops) ---
  const wallSegments = [];
  const addLoop = (pts) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      wallSegments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  };
  addLoop(wallRight);
  addLoop(wallLeft);

  // --- spatial hash grid over wall segments for fast collision queries ---
  const CELL = 160;
  const grid = new Map();
  const cellKey = (cx, cy) => cx + ',' + cy;
  wallSegments.forEach((seg, idx) => {
    const minX = Math.min(seg.ax, seg.bx), maxX = Math.max(seg.ax, seg.bx);
    const minY = Math.min(seg.ay, seg.by), maxY = Math.max(seg.ay, seg.by);
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        const key = cellKey(cx, cy);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(idx);
      }
    }
  });
  const segStamp = new Int32Array(wallSegments.length).fill(-1);
  let queryId = 0;

  // Returns wall segments whose grid cells overlap the AABB (deduplicated).
  function queryWalls(minX, minY, maxX, maxY) {
    queryId++;
    const out = [];
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        const bucket = grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const idx of bucket) {
          if (segStamp[idx] === queryId) continue;
          segStamp[idx] = queryId;
          out.push(wallSegments[idx]);
        }
      }
    }
    return out;
  }

  // --- arc-length lookup helpers ---
  function indexAtArc(targetArc) {
    targetArc = ((targetArc % totalLength) + totalLength) % totalLength;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arc[mid] <= targetArc) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Position + heading at a distance along the lap, optionally offset
  // sideways (positive = driver's right). Used for the starting grid.
  function poseAtArc(targetArc, lateral = 0) {
    const i = indexAtArc(targetArc);
    return {
      x: centerline[i].x + normals[i].x * lateral,
      y: centerline[i].y + normals[i].y * lateral,
      angle: Math.atan2(tangents[i].y, tangents[i].x),
    };
  }

  // --- checkpoint gates, evenly spaced by arc length. Gate 0 = start/finish. ---
  const gates = [];
  for (let g = 0; g < data.checkpointCount; g++) {
    const i = indexAtArc((g * totalLength) / data.checkpointCount);
    gates.push({
      ax: wallRight[i].x, ay: wallRight[i].y,
      bx: wallLeft[i].x, by: wallLeft[i].y,
      dirX: tangents[i].x, dirY: tangents[i].y, // forward direction of travel
      cx: centerline[i].x, cy: centerline[i].y,
    });
  }

  const startPose = poseAtArc(40);

  // --- world bounding box (drives the camera's zoom and pan clamping) ---
  const BARRIER_PAD = 10; // barrier stroke half-width plus a little slack
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of [...wallRight, ...wallLeft]) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bounds = {
    minX: minX - BARRIER_PAD, minY: minY - BARRIER_PAD,
    maxX: maxX + BARRIER_PAD, maxY: maxY + BARRIER_PAD,
  };
  bounds.width = bounds.maxX - bounds.minX;
  bounds.height = bounds.maxY - bounds.minY;

  return {
    centerline, tangents, normals, curvature, halfWidths, arc, totalLength,
    wallRight, wallLeft, wallSegments, queryWalls,
    gates, startPose, bounds,
    indexAtArc, poseAtArc,
  };
}

const TRACK = buildTrack(TRACK_DATA);

// ---------------------------------------------------------------------------
// LapTracker — per-car checkpoint/lap state. A lap counts only when every
// gate has been crossed in order, in the forward direction, ending with the
// start/finish line. Skipping a gate (cutting) or driving backwards simply
// stalls progress until the car goes back through the missed gate.
// ---------------------------------------------------------------------------

class LapTracker {
  constructor(track, totalLaps) {
    this.track = track;
    this.totalLaps = totalLaps;
    this.lap = 1;               // current lap, 1-based
    this.nextGate = 1;          // gate we're waiting on (wraps to 0 = finish line)
    this.lapStartTime = 0;
    this.lastLapTime = null;
    this.bestLapTime = null;
    this.lapTimes = [];
    this.finished = false;
    this.finishTime = null;
    this._nearestIndex = 0;     // cached for progress()
  }

  // Call once per physics substep with the car's pre/post-step positions.
  update(oldX, oldY, newX, newY, time) {
    if (this.finished) return;
    const gates = this.track.gates;
    const gate = gates[this.nextGate % gates.length];

    const hit = segSegIntersect(oldX, oldY, newX, newY, gate.ax, gate.ay, gate.bx, gate.by);
    if (hit === null) return;
    // Only count crossings in the forward direction of travel.
    const mx = newX - oldX, my = newY - oldY;
    if (mx * gate.dirX + my * gate.dirY <= 0) return;

    if (this.nextGate % gates.length === 0) {
      // Crossed the finish line with all gates collected — lap complete.
      const lapTime = time - this.lapStartTime;
      this.lastLapTime = lapTime;
      this.lapTimes.push(lapTime);
      if (this.bestLapTime === null || lapTime < this.bestLapTime) {
        this.bestLapTime = lapTime;
      }
      if (this.lap >= this.totalLaps) {
        this.finished = true;
        this.finishTime = time;
      } else {
        this.lap++;
        this.lapStartTime = time;
      }
      this.nextGate = 1;
    } else {
      this.nextGate++;
    }
  }

  // Monotonic race progress, used to rank cars. Walks the cached nearest
  // centreline index forward rather than rescanning the whole track.
  progress(carX, carY) {
    const t = this.track;
    const cl = t.centerline;
    const n = cl.length;
    const distTo = (i) => {
      const dx = cl[i].x - carX, dy = cl[i].y - carY;
      return dx * dx + dy * dy;
    };
    let i = this._nearestIndex;
    let best = distTo(i);
    // Local search in both directions (handles being nudged backwards).
    for (let step = 1; step <= 40; step++) {
      const f = (i + step) % n, b = (i - step + n) % n;
      const df = distTo(f), db = distTo(b);
      if (df < best) { best = df; this._nearestIndex = f; }
      if (db < best) { best = db; this._nearestIndex = b; }
    }
    return (this.lap - 1) * t.totalLength + t.arc[this._nearestIndex];
  }
}
