// ============================================================================
// MAIN.JS — Game loop glue: fixed-timestep physics (delta-time based, so
// behavior is identical on any refresh rate), lap tracking, camera, HUD.
// Track logic lives in track.js, physics in physics.js, drawing in render.js.
// ============================================================================

const canvas = document.getElementById('gameCanvas');
Render.init(canvas);
Render.initTrack(TRACK);
Input.init();

let player, playerLaps, raceTime;

function restart() {
  const sp = TRACK.startPose;
  player = new Car(sp.x, sp.y, sp.angle);
  playerLaps = new LapTracker(TRACK, TRACK_DATA.laps);
  raceTime = 0;
  Render.snapCameraTo(sp.x, sp.y);
}
restart();

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
  if (playerLaps.finished) {
    raceInfoEl.textContent =
      `FINISHED!  Total ${formatTime(playerLaps.finishTime)}\n` +
      `Best lap ${formatTime(playerLaps.bestLapTime)}   (R to restart)`;
  } else {
    raceInfoEl.textContent =
      `LAP ${playerLaps.lap}/${playerLaps.totalLaps}\n` +
      `Time ${formatTime(raceTime - playerLaps.lapStartTime)}\n` +
      `Last ${formatTime(playerLaps.lastLapTime)}\n` +
      `Best ${formatTime(playerLaps.bestLapTime)}`;
  }
  debugInfoEl.textContent =
    `${Math.round(player.speed)} px/s · WASD/arrows drive · Space handbrake · R restart`;
}

// ---- game loop -------------------------------------------------------------

const FIXED_DT = 1 / 120; // physics substep (s); rendering stays per-frame
const MAX_FRAME_TIME = 0.25;
let accumulator = 0;
let lastTime = performance.now();

function frame(now) {
  let frameTime = (now - lastTime) / 1000;
  lastTime = now;
  if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME; // tab-switch guard

  if (Input.consumeRestart()) restart();

  const input = Input.getCarInput();
  accumulator += frameTime;
  while (accumulator >= FIXED_DT) {
    const oldX = player.x, oldY = player.y;
    player.update(FIXED_DT, input);
    collideCarWithTrack(player, oldX, oldY, TRACK);
    if (!playerLaps.finished) raceTime += FIXED_DT;
    playerLaps.update(oldX, oldY, player.x, player.y, raceTime);
    accumulator -= FIXED_DT;
  }

  Render.updateCamera(player, frameTime);
  Render.beginWorld();
  Render.drawTrack();
  Render.drawDriftMarks(player);
  Render.drawCar(player);
  Render.endWorld();

  updateHUD();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
