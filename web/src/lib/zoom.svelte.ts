// UI zoom, VS Code style: every size is in rem, so scaling the root font size
// scales the whole interface without CSS `zoom` (which would throw off the
// coordinates CodeMirror and the popovers measure). Remembered per browser.

const KEY = "querier:zoom";
export const DEFAULT_ZOOM = 1.125;
const STEPS = [0.8, 0.9, 1, 1.125, 1.25, 1.375, 1.5, 1.75, 2];

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v > 0 ? v : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}

class Zoom {
  value = $state(read());

  constructor() {
    this.apply();
  }

  private apply() {
    document.documentElement.style.fontSize = `${16 * this.value}px`;
    try {
      localStorage.setItem(KEY, String(this.value));
    } catch {}
  }

  set(v: number) {
    this.value = Math.min(2, Math.max(0.8, v));
    this.apply();
  }

  in = () => this.set(STEPS.find((s) => s > this.value + 1e-6) ?? this.value);
  out = () => this.set(STEPS.findLast((s) => s < this.value - 1e-6) ?? this.value);
  reset = () => this.set(DEFAULT_ZOOM);

  /** A CSS-pixel length drawn by script (virtual rows, column widths) at the current zoom. */
  px = (n: number) => n * this.value;
}

export const zoom = new Zoom();
