// Generated property setters for components whose inputs arrive as separate
// assignments (`list.items = …; list.areas = …`). Each setter stores its
// coerced value and schedules one render in a microtask, so a batch of
// assignments costs one render. A value identical to the current one changes
// nothing and schedules nothing: the projection reuses unchanged sections, so
// most refreshes hand a view the arrays it already shows (COMPONENTS.md,
// "Incremental rendering"). `flushRender()` renders a pending batch now, for
// callers that need the DOM immediately (for example to restore focus), and
// says whether it rendered.

const PENDING = Symbol("kinRenderPending");

/**
 * @param Class element class with a `render()` method
 * @param specs { name: { field, coerce } } — the setter stores
 *              `coerce(value, element)` in `this[field]` (default `_${name}`).
 *              Coerce missing values to shared constants rather than fresh
 *              `[]` / `{}`, or every assignment of a missing value renders.
 */
export function defineProps(Class, specs) {
  for (const [name, spec] of Object.entries(specs)) {
    const field = spec.field ?? `_${name}`;
    // A field named like the property would make its getter read itself.
    if (field === name) throw new Error(`defineProps: ${name} needs a field of another name`);
    const coerce = spec.coerce ?? ((value) => value);
    Object.defineProperty(Class.prototype, name, {
      configurable: true,
      enumerable: false,
      get() { return this[field]; },
      set(value) {
        const next = coerce(value, this);
        if (Object.is(next, this[field])) return;
        this[field] = next;
        scheduleRender(this);
      },
    });
  }
  if (!Object.hasOwn(Class.prototype, "flushRender")) {
    Object.defineProperty(Class.prototype, "flushRender", {
      configurable: true,
      writable: true,
      value() {
        if (!this[PENDING]) return false;
        this[PENDING] = false;
        this.render();
        return true;
      },
    });
  }
}

/** Schedules one microtask render; repeated calls before it runs coalesce. */
export function scheduleRender(element) {
  if (element[PENDING]) return;
  element[PENDING] = true;
  queueMicrotask(() => element.flushRender());
}

const NO_ITEMS = Object.freeze([]);
// A missing or invalid list becomes one shared empty array (see above).
export const asArray = (value) => (Array.isArray(value) ? value : NO_ITEMS);
export const asFunction = (value) => (typeof value === "function" ? value : null);
