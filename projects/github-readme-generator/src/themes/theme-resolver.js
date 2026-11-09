import { normalizeTheme } from "./theme-model.js";
export function cleanOwnership(value) {
  return {
    derived:
      value?.derived &&
      typeof value.derived === "object" &&
      !Array.isArray(value.derived)
        ? structuredClone(value.derived)
        : {},
    overrides: Array.isArray(value?.overrides)
      ? value.overrides.filter((k) => typeof k === "string")
      : [],
  };
}
export function explicitOverride(object, key) {
  object._theme = cleanOwnership(object._theme);
  object._theme.overrides = [
    ...new Set([...(object._theme.overrides || []), key]),
  ];
}
export function derive(object, values, { reset = false } = {}) {
  object._theme = cleanOwnership(object._theme);
  const own = object._theme;
  own.derived ||= {};
  own.overrides ||= [];
  for (const [key, value] of Object.entries(values)) {
    if (
      reset ||
      (!own.overrides.includes(key) &&
        (!Object.hasOwn(object, key) ||
          (Object.hasOwn(own.derived, key) &&
            JSON.stringify(object[key]) === JSON.stringify(own.derived[key]))))
    ) {
      object[key] = structuredClone(value);
      own.derived[key] = structuredClone(value);
      own.overrides = own.overrides.filter((k) => k !== key);
    } else if (Object.hasOwn(own.derived, key))
      own.overrides = [...new Set([...own.overrides, key])];
  }
  return object;
}
export function badgeDefaults(theme) {
  const t = normalizeTheme(theme),
    logo =
      t.badges.logoTreatment === "accent"
        ? t.palette.accentAlt
        : t.badges.logoTreatment;
  return {
    style: t.badges.style,
    color: t.badges.lightBackground,
    darkColor: t.pictures.preferThemeAware ? t.badges.darkBackground : "",
    logoColor: logo,
    darkLogoColor: logo,
    labelColor: t.badges.lightBackground,
  };
}
export function themeBlocks(blocks, theme, options = {}) {
  const t = normalizeTheme(theme),
    copy = structuredClone(blocks);
  for (const b of copy) {
    if (["custom", "component"].includes(b.type)) continue;
    const s = b.settings;
    s.presentation ||= {};
    derive(
      s.presentation,
      {
        heading: t.headings.style,
        decoration: t.headings.decoration,
        divider: t.dividers.style,
      },
      options,
    );
    if (b.type === "divider")
      derive(s, { dividerStyle: t.dividers.style }, options);
    if (b.type === "picture")
      derive(s, { preferThemeAware: t.pictures.preferThemeAware }, options);
    if (b.type === "badge") derive(s, badgeDefaults(t), options);
    if (["badges", "stack"].includes(b.type))
      for (const badge of s.items || [])
        derive(badge, badgeDefaults(t), options);
    if (b.type === "projects")
      for (const p of s.items || [])
        for (const badge of p.badges || [])
          derive(badge, badgeDefaults(t), options);
  }
  return copy;
}
