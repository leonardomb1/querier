// Typefaces, switchable from the command palette. Defaults: Geist for the
// interface (drawn for developer tools and dense data) and JetBrains Mono for
// code (tall x-height, the most-recommended coding face). The defaults are in the
// bundle; the rest load when picked. Remembered per browser.

interface Face {
  id: string;
  label: string;
  family: string;
  load?: () => Promise<unknown>;
}

const SYSTEM_SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const SYSTEM_MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export const UI_FACES: Face[] = [
  { id: "geist", label: "Geist", family: `"Geist Variable", ${SYSTEM_SANS}` },
  { id: "plex", label: "IBM Plex Sans", family: `"IBM Plex Sans Variable", ${SYSTEM_SANS}`, load: () => import("@fontsource-variable/ibm-plex-sans") },
  { id: "inter", label: "Inter", family: `"Inter Variable", ${SYSTEM_SANS}`, load: () => import("@fontsource-variable/inter") },
  { id: "system", label: "System (as VS Code)", family: SYSTEM_SANS },
];

export const CODE_FACES: Face[] = [
  { id: "jetbrains", label: "JetBrains Mono", family: `"JetBrains Mono Variable", ${SYSTEM_MONO}` },
  { id: "geist-mono", label: "Geist Mono", family: `"Geist Mono Variable", ${SYSTEM_MONO}`, load: () => import("@fontsource-variable/geist-mono") },
  { id: "cascadia", label: "Cascadia Code", family: `"Cascadia Code Variable", ${SYSTEM_MONO}`, load: () => import("@fontsource-variable/cascadia-code") },
  { id: "plex-mono", label: "IBM Plex Mono", family: `"IBM Plex Mono", ${SYSTEM_MONO}`, load: () => Promise.all([import("@fontsource/ibm-plex-mono/400.css"), import("@fontsource/ibm-plex-mono/600.css")]) },
  { id: "system-mono", label: "System monospace", family: SYSTEM_MONO },
];

function read(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

class Fonts {
  ui = $state(read("querier:font-ui", "geist"));
  code = $state(read("querier:font-code", "jetbrains"));

  constructor() {
    this.apply("ui", this.ui);
    this.apply("code", this.code);
  }

  private async apply(which: "ui" | "code", id: string) {
    const faces = which === "ui" ? UI_FACES : CODE_FACES;
    const face = faces.find((f) => f.id === id) ?? faces[0];
    await face.load?.();
    document.documentElement.style.setProperty(which === "ui" ? "--sans" : "--mono", face.family);
  }

  set(which: "ui" | "code", id: string) {
    this[which] = id;
    try {
      localStorage.setItem(`querier:font-${which}`, id);
    } catch {}
    this.apply(which, id);
  }
}

export const fonts = new Fonts();
