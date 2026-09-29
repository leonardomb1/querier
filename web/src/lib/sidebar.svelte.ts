// The side bar's width: one for the whole app (home, every notebook), as VS
// Code's, so moving between pages never resizes it. Remembered per browser.

const KEY = "querier:side-width";
export const SIDE_DEFAULT = 260;
export const SIDE_MIN = 170;
export const SIDE_MAX = 600;

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (v > 0) return v;
    // before there was one width, home kept its own
    const home = JSON.parse(localStorage.getItem("querier:home") ?? "{}").width;
    return typeof home === "number" && home > 0 ? home : SIDE_DEFAULT;
  } catch {
    return SIDE_DEFAULT;
  }
}

class SideBar {
  width = $state(read());

  /** While dragging: clamped, not saved yet. */
  set(px: number) {
    this.width = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(px)));
  }
  save() {
    try {
      localStorage.setItem(KEY, String(this.width));
    } catch {}
  }
  reset() {
    this.width = SIDE_DEFAULT;
    this.save();
  }
}

export const sidebar = new SideBar();
