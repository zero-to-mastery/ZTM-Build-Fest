export const namedColors = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen brightgreen yellowgreen success important critical informational inactive lightgray lightgrey".split(
    " ",
  ),
);
// Shields named colors can differ from CSS. Unknown named mappings are explicitly unevaluated.
const mapped = {
  white: "ffffff",
  black: "000000",
  blue: "007ec6",
  red: "e05d44",
  green: "97ca00",
  brightgreen: "4c1",
  yellow: "dfb317",
  yellowgreen: "a4a61d",
  orange: "fe7d37",
  gray: "555555",
  grey: "555555",
  lightgray: "9f9f9f",
  lightgrey: "9f9f9f",
  purple: "800080",
  pink: "ffc0cb",
  success: "4c1",
  important: "fe7d37",
  critical: "e05d44",
  informational: "007ec6",
  inactive: "9f9f9f",
};
export function rgb(color) {
  let s = String(color || "")
    .toLowerCase()
    .replace(/^#/, "");
  s = mapped[s] || s;
  if (/^[a-f\d]{3}$/.test(s)) s = [...s].map((c) => c + c).join("");
  if (!/^[a-f\d]{6}$/.test(s)) return null;
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}
export function luminance(color) {
  const channels = rgb(color);
  return channels
    ? channels
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((v, c, i) => v + c * [0.2126, 0.7152, 0.0722][i], 0)
    : null;
}
export function contrastRatio(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return x === null || y === null
    ? null
    : (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function contrastWarnings(s) {
  const warnings = [];
  for (const [name, bg, fg] of [
    ["Label text", s.labelColor || "555", "white"],
    ["Message text", s.color || s.brandColor, "white"],
    ["Logo", s.labelColor || s.color || s.brandColor, s.logoColor || "white"],
    ...(s.darkColor
      ? [
          ["Dark message text", s.darkColor, "white"],
          ["Dark logo", s.darkColor, s.darkLogoColor || "white"],
        ]
      : []),
  ]) {
    if (
      !bg ||
      (name.includes("Logo") && !s.logo) ||
      (name.includes("logo") && !s.logo)
    )
      continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio === null)
      warnings.push(
        `${name}: contrast cannot be estimated for this color; inspect the preview.`,
      );
    else if (ratio < (name.toLowerCase().includes("logo") ? 3 : 4.5))
      warnings.push(
        `${name}: approximately ${ratio.toFixed(1)}:1 against the background; it may be hard to read.`,
      );
  }
  return warnings;
}
