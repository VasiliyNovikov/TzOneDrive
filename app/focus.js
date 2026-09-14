const horizontal = (direction) => direction === 'left' || direction === 'right';

export function directionalTarget(current, candidates, direction) {
  if (!current || !['left', 'right', 'up', 'down'].includes(direction)) return null;
  const alongX = horizontal(direction);
  const forward = direction === 'right' || direction === 'down' ? 1 : -1;
  const center = (rect, axis) => axis === 'x'
    ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate.id === current.id) continue;
    const primary = (center(candidate, alongX ? 'x' : 'y')
      - center(current, alongX ? 'x' : 'y')) * forward;
    if (primary <= 1) continue;
    const secondary = Math.abs(center(candidate, alongX ? 'y' : 'x')
      - center(current, alongX ? 'y' : 'x'));
    const overlap = alongX
      ? Math.min(current.top + current.height, candidate.top + candidate.height)
        - Math.max(current.top, candidate.top)
      : Math.min(current.left + current.width, candidate.left + candidate.width)
        - Math.max(current.left, candidate.left);
    const score = primary + secondary * 2 + (overlap > 0 ? 0 : 10000);
    if (score < bestScore) {
      best = candidate.id;
      bestScore = score;
    }
  }
  return best;
}

export class FocusController {
  constructor(root) {
    this.root = root;
    this.context = null;
    this.memory = new Map();
  }

  elements() {
    return [...this.root.querySelectorAll('[data-focus-id]')]
      .filter((element) => !element.disabled && element.getClientRects().length);
  }

  capture() {
    const active = this.root.ownerDocument.activeElement;
    if (this.context && active && active.dataset.focusId) {
      this.memory.set(this.context, active.dataset.focusId);
    }
  }

  restore(context, fallback) {
    this.context = context;
    const elements = this.elements();
    const preferred = this.memory.get(context) || fallback;
    const target = elements.find((element) => element.dataset.focusId === preferred)
      || elements.find((element) => element.dataset.focusId === fallback) || elements[0];
    if (target) this.focus(target);
  }

  focus(element) {
    for (const candidate of this.elements()) candidate.tabIndex = candidate === element ? 0 : -1;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    this.capture();
  }

  move(direction) {
    const elements = this.elements();
    const active = this.root.ownerDocument.activeElement;
    const rects = elements.map((element) => ({
      id: element.dataset.focusId,
      left: element.getBoundingClientRect().left,
      top: element.getBoundingClientRect().top,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }));
    const target = directionalTarget(
      rects.find((rect) => active && rect.id === active.dataset.focusId), rects, direction,
    );
    const element = elements.find((candidate) => candidate.dataset.focusId === target);
    if (element) this.focus(element);
    else if (!elements.includes(active) && elements[0]) this.focus(elements[0]);
    return Boolean(element);
  }
}
