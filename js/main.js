// ============================================================================
// MAIN.JS — Game loop with fixed-timestep physics (delta-time based, so
// behavior is identical on any refresh rate) and per-frame rendering.
// ============================================================================

const canvas = document.getElementById('gameCanvas');
Render.init(canvas);
Input.init();

const PLAYER_START = { x: 500, y: 350, angle: -Math.PI / 2 };

let player = new Car(PLAYER_START.x, PLAYER_START.y, PLAYER_START.angle);

function restart() {
  player = new Car(PLAYER_START.x, PLAYER_START.y, PLAYER_START.angle);
}

// Keep the car on screen for step 1 (no track yet) by wrapping edges.
function wrapToCanvas(car) {
  if (car.x < -20) car.x = canvas.width + 20;
  if (car.x > canvas.width + 20) car.x = -20;
  if (car.y < -20) car.y = canvas.height + 20;
  if (car.y > canvas.height + 20) car.y = -20;
}

const FIXED_DT = 1 / 120; // physics substep (s); rendering stays per-frame
const MAX_FRAME_TIME = 0.25;
let accumulator = 0;
let lastTime = performance.now();

function frame(now) {
  let frameTime = (now - lastTime) / 1000;
  lastTime = now;
  if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME; // tab-switch guard

  if (Input.consumeRestart()) restart();

  accumulator += frameTime;
  const input = Input.getCarInput();
  while (accumulator >= FIXED_DT) {
    player.update(FIXED_DT, input);
    wrapToCanvas(player);
    accumulator -= FIXED_DT;
  }

  Render.clear();
  Render.drawGrid();
  Render.drawDriftMarks(player);
  Render.drawCar(player);

  document.getElementById('debugInfo').textContent =
    `Speed: ${Math.round(player.speed)} px/s\n` +
    `Drift: ${Math.round(Math.abs(player.lateralSpeed))} px/s\n` +
    `WASD/Arrows drive · Space handbrake · R restart`;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
