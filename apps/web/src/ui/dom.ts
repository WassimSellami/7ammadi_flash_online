export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  options: { className?: string; hint?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const node = el("button", options.className ?? "wide");
  const title = el("span", undefined, label);
  node.append(title);
  if (options.hint) {
    const hint = el("span", "hint", options.hint);
    node.append(hint);
  }
  node.type = "button";
  if (options.disabled) node.disabled = true;
  node.addEventListener("click", (event) => {
    event.preventDefault();
    if (!node.disabled) onClick();
  });
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function toast(message: string, duration = 2600): void {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => {
    node.classList.remove("show");
  }, duration);
}

export function swatches(
  taken: number | readonly number[] | null,
  selected: number,
  onSelect: (index: number) => void,
): HTMLElement {
  const wrap = el("div", "swatches");
  const takenSet = new Set(
    taken === null ? [] : typeof taken === "number" ? [taken] : taken,
  );
  const colors = ["rgb(255, 114, 170)", "rgb(254, 190, 80)", "rgb(74, 202, 79)", "rgb(28, 154, 255)"];
  colors.forEach((color, index) => {
    const node = el("button", "swatch");
    node.type = "button";
    node.style.background = color;
    node.setAttribute("aria-label", `Palette ${index + 1}`);
    node.setAttribute("aria-pressed", String(index === selected));
    node.dataset.taken = String(takenSet.has(index));
    if (takenSet.has(index)) node.disabled = true;
    node.addEventListener("click", () => onSelect(index));
    wrap.append(node);
  });
  return wrap;
}
