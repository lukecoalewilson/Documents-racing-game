// ============================================================================
// PHYSICS.JS — Arcade car physics constants and simulation.
//
// TUNING GUIDE (all the knobs you'll want live in PHYSICS below):
//   - Want a faster car?        raise MAX_SPEED and/or ENGINE_FORCE.
//   - Want snappier steering?   raise TURN_RATE (max turn rate) or lower
//                                TURN_SPEED_REF (reach full turn rate sooner).
//   - Want more/less drift?     lower/raise GRIP. Lower GRIP = more slide.
//   - Want handbrake to slide
//     more dramatically?        lower HANDBRAKE_GRIP.
//   - Car feels floaty?         raise ROLLING_RESISTANCE and/or DRAG so it
//                                 sheds speed faster when you lift off.
//   - Car feels twitchy at
//     high speed?               lower HIGH_SPEED_STEER_FALLOFF.
//
// MODEL OVERVIEW:
//   The car has a heading (this.angle) and a world-space velocity (vx, vy).
//   Each frame we decompose velocity into "forward" (along the nose) and
//   "lateral" (sideways, i.e. drift) components relative to the car's own
//   heading. Engine/brake forces act on the forward component. Steering
//   rotates the heading itself (yaw rate depends on speed, so the car can't
//   spin in place). Lateral velocity is bled off by "grip" each frame — high
//   grip kills sideways slide almost instantly (feels planted), low grip
//   (e.g. while handbraking) lets it persist so the car slides through
//   corners. Velocity is then recomposed back into world space.
//
//   Forces below are applied as direct accelerations (px/s^2), not true
//   force/mass — that's a deliberate simplification for arcade tuning.
// ============================================================================

const PHYSICS = {
  // --- Engine / speed ---
  ENGINE_FORCE: 700,          // forward acceleration (px/s^2) while holding accelerate
  BRAKE_FORCE: 1400,          // deceleration (px/s^2) while braking and still moving forward
  REVERSE_FORCE: 450,         // acceleration (px/s^2) in reverse, once stopped/slow
  MAX_SPEED: 480,             // top forward speed (px/s)
  MAX_REVERSE_SPEED: 150,     // top reverse speed (px/s)

  // --- Drag / friction (always-on resistance that shapes top speed & coasting) ---
  // Drag accel = DRAG * speed^2, so at 480 px/s it costs ~480 px/s^2.
  // Raise DRAG to reach top speed more slowly / coast down faster.
  DRAG: 0.0021,               // quadratic air-drag-like coefficient (scales with speed^2)
  ROLLING_RESISTANCE: 90,     // constant friction (px/s^2) that kills coasting speed

  // --- Steering ---
  TURN_RATE: 3.0,             // max yaw rate (radians/sec) achievable at TURN_SPEED_REF
  TURN_SPEED_REF: 140,        // speed (px/s) at which steering reaches full TURN_RATE
  MIN_SPEED_TO_STEER: 6,      // below this speed (px/s), steering input has no effect
  HIGH_SPEED_STEER_FALLOFF: 0.6, // steering authority multiplier retained at MAX_SPEED (<1 = safer at top speed)

  // --- Grip / drift ---
  GRIP: 8.5,                  // how fast (per second) lateral slide is killed. Higher = more grip, less drift.
  HANDBRAKE_GRIP: 1.2,        // grip used while handbraking — much lower, so the car slides sideways
  HANDBRAKE_DRAG_BOOST: 1.6,  // extra forward-drag multiplier while handbraking (scrubs speed in a slide)

  // --- Collision (used once walls exist) ---
  WALL_BOUNCE: 0.35,          // fraction of into-wall velocity reflected back out
  WALL_SPEED_SCRUB: 0.55,     // fraction of speed lost on wall impact
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class Car {
  constructor(x, y, angle = 0) {
    this.x = x;
    this.y = y;
    this.angle = angle;       // radians; 0 = facing +x (right). Heading vector = (cos, sin).
    this.vx = 0;
    this.vy = 0;
    this.angularVelocity = 0;
    this.forwardSpeed = 0;    // signed speed along the nose (+forward / -reverse)
    this.lateralSpeed = 0;    // signed sideways slide speed (drift amount)
    this.speed = 0;           // scalar world speed, for HUD/AI convenience
  }

  // input = { accelerate: bool, brake: bool, steer: -1..1, handbrake: bool }
  update(dt, input) {
    const dir = { x: Math.cos(this.angle), y: Math.sin(this.angle) };
    const right = { x: -dir.y, y: dir.x };

    // Decompose current world-space velocity into the car's own reference frame.
    let forwardSpeed = this.vx * dir.x + this.vy * dir.y;
    let lateralSpeed = this.vx * right.x + this.vy * right.y;

    // --- throttle / brake / reverse ---
    let engineAccel = 0;
    if (input.accelerate) {
      engineAccel = PHYSICS.ENGINE_FORCE;
    } else if (input.brake) {
      // Braking while still rolling forward slows you down hard; once nearly
      // stopped (or already moving backward), the same input becomes reverse.
      engineAccel = forwardSpeed > 10 ? -PHYSICS.BRAKE_FORCE : -PHYSICS.REVERSE_FORCE;
    }
    forwardSpeed += engineAccel * dt;

    // --- drag + rolling resistance (always opposing motion) ---
    const handbrakeDragMul = input.handbrake ? PHYSICS.HANDBRAKE_DRAG_BOOST : 1;
    const dragAccel = PHYSICS.DRAG * forwardSpeed * Math.abs(forwardSpeed) * handbrakeDragMul;
    forwardSpeed -= dragAccel * dt;
    if (forwardSpeed > 0) {
      forwardSpeed = Math.max(0, forwardSpeed - PHYSICS.ROLLING_RESISTANCE * dt);
    } else if (forwardSpeed < 0) {
      forwardSpeed = Math.min(0, forwardSpeed + PHYSICS.ROLLING_RESISTANCE * dt);
    }

    forwardSpeed = clamp(forwardSpeed, -PHYSICS.MAX_REVERSE_SPEED, PHYSICS.MAX_SPEED);

    // --- grip: bleed off sideways slide. Handbrake drastically lowers grip. ---
    const grip = input.handbrake ? PHYSICS.HANDBRAKE_GRIP : PHYSICS.GRIP;
    lateralSpeed *= Math.max(0, 1 - grip * dt);

    // --- steering: yaw rate scales with speed, so the car can't pivot when still ---
    const speedForSteer = Math.abs(forwardSpeed);
    if (speedForSteer > PHYSICS.MIN_SPEED_TO_STEER) {
      const speedFactor = Math.min(1, speedForSteer / PHYSICS.TURN_SPEED_REF);
      const highSpeedMul = 1 - (1 - PHYSICS.HIGH_SPEED_STEER_FALLOFF) *
        Math.min(1, speedForSteer / PHYSICS.MAX_SPEED);
      const reverseFlip = forwardSpeed >= 0 ? 1 : -1; // steering inverts in reverse, like a real car
      this.angularVelocity = input.steer * PHYSICS.TURN_RATE * speedFactor * highSpeedMul * reverseFlip;
    } else {
      this.angularVelocity = 0;
    }

    // Recompose world velocity in the PRE-rotation frame, then rotate the
    // heading. The mismatch between velocity and the new heading is what
    // shows up as lateralSpeed next frame — that gap IS the drift, and grip
    // is what closes it. (Recomposing after rotating would weld velocity to
    // the nose and make drift impossible.)
    this.vx = dir.x * forwardSpeed + right.x * lateralSpeed;
    this.vy = dir.y * forwardSpeed + right.y * lateralSpeed;
    this.angle += this.angularVelocity * dt;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.forwardSpeed = forwardSpeed;
    this.lateralSpeed = lateralSpeed;
    this.speed = Math.hypot(this.vx, this.vy);
  }
}
