// ============================================================================
// TRACK.JS — The circuit, defined as DATA: a list of centreline control
// points plus a width. Everything else (smooth centreline, barriers, wall
// collision segments, curvature, checkpoint gates, bounding box, start pose)
// is derived from that, so you reshape the track by editing TRACK_DATA only.
//
// Layout notes: control points are smoothed with a Catmull-Rom spline, so
// the drawn centreline passes THROUGH every point. Points are world-space
// pixels, y grows downward. Keep corner radii comfortably larger than
// width/2 or the inner barrier will pinch.
// ============================================================================

// Race length. This is the only place the lap count is defined.
const RACE_LAPS = 5;

const TRACK_DATA = {
  width: 150,           // track surface width (px). Barriers sit at ±width/2.
  checkpointCount: 12,  // invisible ordered gates (gate 0 = start/finish line)

  // Centreline control points. Current layout: bottom start/finish straight
  // (heading +x) → fast right-hand sweeper → top straight with a kink →
  // tight left hairpin → short chicane back to the straight.
  controlPoints: [
    [800, 1700], [1500, 1730], [2150, 1650],   // start/finish straight
    [2700, 1420], [2950, 950], [2690, 500],    // fast sweeper (big radius)
    [2100, 330], [1450, 390], [950, 300],      // top straight + kink
    [530, 440], [310, 570], [310, 820], [545, 945], // tight hairpin (two apex points keep the U round)
    [680, 1240], [635, 1480],                  // chicane link back to start
  ],
};

// ---------------------------------------------------------------------------
// Track construction (derived data — no tuning knobs below this line)
// ---------------------------------------------------------------------------

function buildTrack(data) {
  const cps = data.controlPoints;
  const n = cps.length;
  const halfW = data.width / 2;

  // --- Catmull-Rom sample of the closed control polygon into a dense centreline ---
  const centerline = [];
  const SAMPLE_SPACING = 12; // approx px between dense points
  for (let i = 0; i < n; i++) {
    const p0 = cps[(i - 1 + n) % n];
    const p1 = cps[i];
    const p2 = cps[(i + 1) % n];
    const p3 = cps[(i + 2) % n];
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
    }
  }

  const count = centerline.length;

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
  // Used to decide which side of a corner is the inside (for kerbs) and,
  // later, how hard a car should brake for what's coming up.
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
    wallRight.push({
      x: centerline[i].x + normals[i].x * halfW,
      y: centerline[i].y + normals[i].y * halfW,
    });
    wallLeft.push({
      x: centerline[i].x - normals[i].x * halfW,
      y: centerline[i].y - normals[i].y * halfW,
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

  // --- checkpoint gates, evenly spaced by arc length. Gate 0 = start/finish. ---
  function indexAtArc(targetArc) {
    targetArc = ((targetArc % totalLength) + totalLength) % totalLength;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arc[mid] <= targetArc) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
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

  // --- start pose: just past the start/finish line, facing along the track ---
  const si = indexAtArc(40);
  const startPose = {
    x: centerline[si].x, y: centerline[si].y,
    angle: Math.atan2(tangents[si].y, tangents[si].x),
  };

  // --- world bounding box (drives the fixed camera's fit-to-screen zoom) ---
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
    centerline, tangents, normals, curvature, arc, totalLength,
    wallRight, wallLeft, wallSegments, queryWalls,
    gates, startPose, bounds, halfW,
    indexAtArc,
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

  // Monotonic race progress (used later for live position ranking).
  progress(carX, carY) {
    const t = this.track;
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < t.centerline.length; i += 4) {
      const dx = t.centerline[i].x - carX, dy = t.centerline[i].y - carY;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return (this.lap - 1) * t.totalLength + t.arc[bestI];
  }
}
