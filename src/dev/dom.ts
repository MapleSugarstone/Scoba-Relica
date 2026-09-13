// The one element helper every part of the editor builds with.

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A button with a click handler, in one call. */
export const button = (cls: string, label: string, run: () => void): HTMLButtonElement => {
  const b = el("button", cls, label);
  b.addEventListener("click", run);
  return b;
};
