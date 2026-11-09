import {
  normalizeComponent,
  componentSource,
} from "../components-library/model.js";
import { normalizePreset, fieldValues, renderPreset } from "./preset.js";
import { widgetRegistry } from "../widgets/registry.js";
export function normalizeInstance(raw) {
  if (!raw || raw.version !== 1)
    throw Error(
      "Unsupported component instance. Source remains available as Markdown.",
    );
  return {
    version: 1,
    component: normalizeComponent(raw.component),
    values: fieldValues(raw.values || {}),
  };
}
export function instanceSource(raw) {
  const i = normalizeInstance(raw);
  return componentSource(i.component, i.values);
}
export function instanceFromDetail(detail) {
  if (detail.widget) {
    const w = widgetRegistry.find((w) => w.id === detail.widget.provider),
      preset = normalizePreset({ ...detail.widget, type: "widget" });
    if (!preset) throw Error("Unsupported widget preset.");
    return {
      version: 1,
      values: {},
      component: normalizeComponent({
        version: 1,
        id: `builtin:widget-${preset.provider}`,
        name: w?.name || "Image embed",
        category: "Widgets",
        description: w?.description || "Configured image embed",
        kind: "widget",
        template: renderPreset(preset),
        fields: [],
        tags: ["widget", preset.provider],
        external: true,
        attribution: w ? { name: w.name, url: w.projectUrl } : null,
        preset,
      }),
    };
  }
  const c = normalizeComponent(detail.component);
  if (c.kind === "custom") return null;
  return normalizeInstance({
    version: 1,
    component: c,
    values: detail.values || {},
  });
}
export function instanceBlock(raw) {
  const i = normalizeInstance(raw);
  return {
    id: crypto.randomUUID(),
    type: "component",
    settings: {
      name: i.component.name,
      markdown: instanceSource(i),
      instance: i,
    },
  };
}
export function configuredPreset(raw, name) {
  const i = normalizeInstance(raw),
    c = structuredClone(i.component);
  c.id = crypto.randomUUID();
  c.name = name;
  if (c.preset && c.preset.type !== "fields") c.template = instanceSource(i);
  else {
    c.fields = c.fields.map((f) => ({
      ...f,
      default: i.values[f.key] ?? c.preset?.values?.[f.key] ?? f.default,
    }));
    c.preset = {
      version: 1,
      type: "fields",
      values: { ...(c.preset?.values || {}), ...i.values },
    };
  }
  return normalizeComponent(c);
}
export function synchronized(block) {
  try {
    return (
      block.type === "component" &&
      block.settings.markdown === instanceSource(block.settings.instance)
    );
  } catch {
    return false;
  }
}
export function detachBlock(block) {
  return {
    ...structuredClone(block),
    type: "custom",
    settings: { markdown: block.settings.markdown },
    section: undefined,
  };
}
