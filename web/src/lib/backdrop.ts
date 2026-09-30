// A dialog's backdrop: a click on it closes the dialog, but only one that was also
// pressed there. A browser sends a click to where press and release have in common,
// so selecting text in the dialog and letting go outside it would close it otherwise.

export function backdrop(close: () => void) {
  let pressed = false;
  return {
    onpointerdown: (e: PointerEvent) => void (pressed = e.target === e.currentTarget),
    onclick: (e: MouseEvent) => {
      if (pressed && e.target === e.currentTarget) close();
      pressed = false;
    },
  };
}
