// ============================================================================
// INPUT.JS — Keyboard state tracking. WASD + arrows, Space = handbrake,
// R = restart (exposed as a one-shot "restartPressed" flag).
// ============================================================================

const Input = {
  keys: new Set(),
  restartPressed: false,

  init() {
    window.addEventListener('keydown', (e) => {
      // Prevent arrow keys / space from scrolling the page.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }
      if (e.repeat) return;
      this.keys.add(e.key.toLowerCase());
      if (e.key.toLowerCase() === 'r') this.restartPressed = true;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    window.addEventListener('blur', () => this.keys.clear());
  },

  // Returns the input object the physics engine consumes.
  getCarInput() {
    const up = this.keys.has('w') || this.keys.has('arrowup');
    const down = this.keys.has('s') || this.keys.has('arrowdown');
    const left = this.keys.has('a') || this.keys.has('arrowleft');
    const right = this.keys.has('d') || this.keys.has('arrowright');
    return {
      accelerate: up,
      brake: down,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      handbrake: this.keys.has(' '),
    };
  },

  // One-shot: returns true once per R press.
  consumeRestart() {
    const pressed = this.restartPressed;
    this.restartPressed = false;
    return pressed;
  },
};
