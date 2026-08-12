// ============================================================================
// MAIN.JS — Game loop glue: fixed-timestep physics (delta-time based, so
// behavior is identical on any refresh rate), the starting grid, live
// standings and the HUD. Track logic lives in track.js, physics in
// physics.js, the bots in ai.js and all drawing in render.js.
// ============================================================================

const canvas = document.getElementById('gameCanvas');
Render.init(canvas);
Render.resize(TRACK);
Input.init();

window.addEventListener('resize', () => Render.resize(TRACK));

// Grid slots, measured along the lap from the start/finish line, two abreast.
// The player starts at the back so there is traffic to work through.
const GRID = [
  { arc: 150, lateral: -40 },
  { arc: 150, lateral: 40 },
  { arc: 55, lateral: -40 },
  { arc: 55, lateral: 40 },
];

const PLAYER_COLOR = '#ff5a4d';

let entries = [];   // every car in the race, player and bots alike
let player = null;  // convenience handle on the player's entry
let raceTime = 0;

function restart() {
  entries = [];

  // Bots fill the grid from the front; the player takes the last slot.
  BOT_PROFILES.forEach((profile, i) => {
    const slot = GRID[i];
    const pose = TRACK.poseAtArc(slot.arc, slot.lateral);
    const car = new Car(pose.x, pose.y, pose.angle);
    entries.push({
      name: profile.name,
      color: profile.color,
      car,
      laps: new LapTracker(TRACK, RACE_LAPS),
      driver: new AIDriver(car, profile, RACING_LINE),
      isPlayer: false,
      progress: 0,
      position: i + 1,
    });
  });

  const slot = GRID[GRID.length - 1];
  const pose = TRACK.poseAtArc(slot.arc, slot.lateral);
  const car = new Car(pose.x, pose.y, pose.angle);
  player = {
    name: 'YOU',
    color: PLAYER_COLOR,
    car,
    laps: new LapTracker(TRACK, RACE_LAPS),
    driver: null,
    isPlayer: true,
    progress: 0,
    position: GRID.length,
  };
  entries.push(player);

  raceTime = 0;
  Render.snapCameraTo(TRACK, car.x, car.y);
  updateStandings();
}

// Rank the field: anyone who has finished is placed by finish time, everyone
// else by how far around the race they are.
function updateStandings() {
  for (const e of entries) {
    e.progress = e.laps.progress(e.car.x, e.car.y);
  }
  const order = entries.slice().sort((a, b) => {
    if (a.laps.finished && b.laps.finished) return a.laps.finishTime - b.laps.finishTime;
    if (a.laps.finished) return -1;
    if (b.laps.finished) return 1;
    return b.progress - a.progress;
  });
  order.forEach((e, i) => { e.position = i + 1; });
}

// ---- HUD -------------------------------------------------------------------

function formatTime(t) {
  if (t === null || t === undefined) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

const raceInfoEl = document.getElementById('raceInfo');
const debugInfoEl = document.getElementById('debugInfo');

function updateHUD() {
  const laps = player.laps;
  if (laps.finished) {
    raceInfoEl.textContent =
      `FINISHED  P${player.position}/${entries.length}\n` +
      `Total ${formatTime(laps.finishTime)}\n` +
      `Best lap ${formatTime(laps.bestLapTime)}   (R to restart)`;
  } else {
    raceInfoEl.textContent =
      `P${player.position}/${entries.length}   LAP ${laps.lap}/${laps.totalLaps}\n` +
      `Time ${formatTime(raceTime - laps.lapStartTime)}\n` +
      `Last ${formatTime(laps.lastLapTime)}\n` +
      `Best ${formatTime(laps.bestLapTime)}`;
  }
  debugInfoEl.textContent =
    `${Math.round(player.car.speed)} px/s · WASD/arrows drive · Space handbrake · R restart`;
}

// ---- game loop -------------------------------------------------------------

const FIXED_DT = 1 / 120; // physics substep (s); rendering stays per-frame
const MAX_FRAME_TIME = 0.25;
let accumulator = 0;
let lastTime = performance.now();

function step(dt, playerInput) {
  const cars = [];
  for (const e of entries) {
    const input = e.isPlayer ? playerInput : e.driver.update(dt, raceTime);
    const oldX = e.car.x, oldY = e.car.y;
    e.car.update(dt, input);
    collideCarWithTrack(e.car, oldX, oldY, TRACK);
    e._oldX = oldX;
    e._oldY = oldY;
    cars.push(e.car);
  }

  // Cars shove each other after everyone has moved, so the order of the
  // entries list doesn't privilege anyone.
  resolveCarCollisions(cars);

  raceTime += dt;
  for (const e of entries) {
    e.laps.update(e._oldX, e._oldY, e.car.x, e.car.y, raceTime);
  }
}

function frame(now) {
  let frameTime = (now - lastTime) / 1000;
  lastTime = now;
  if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME; // tab-switch guard

  if (Input.consumeRestart()) restart();

  const playerInput = Input.getCarInput();
  accumulator += frameTime;
  while (accumulator >= FIXED_DT) {
    step(FIXED_DT, playerInput);
    accumulator -= FIXED_DT;
  }

  updateStandings();
  Render.updateCamera(TRACK, player.car, frameTime);

  Render.drawTrack(TRACK);
  Render.beginWorld();
  for (const e of entries) Render.drawDriftMarks(e.car);
  for (const e of entries) {
    if (!e.isPlayer) Render.drawCar(e.car, e.color, '#1d2226');
  }
  Render.drawCar(player.car, player.color, '#f4f8fa', true);
  Render.endWorld();

  updateHUD();
  requestAnimationFrame(frame);
}

restart();
requestAnimationFrame(frame);
