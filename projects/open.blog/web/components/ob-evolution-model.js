// Shared model for the JavaScript evolution comparison: fixed before/after examples run
// against fixed sample data. Used by <ob-evolution-lab> and by the series landing page lab.
// Both functions of an example run in the reader's current browser; nothing here claims
// anything about older engines, timing or compatibility.

export const evolutionExamples = [
  {
    label: "2015 / Functions",
    context: "ES2015 (ES6) introduced arrow functions, alongside let/const, modules, classes, and promises. Here we compare only a plain-data mapping task.",
    beforeTitle: "ES5-STYLE / FUNCTION CALLBACK",
    afterTitle: "ES2015 / ARROW FUNCTION",
    before: "function labels(items) {\n  return items.map(function (item) {\n    return item.name;\n  });\n}",
    after: "const labels = (items) =>\n  items.map((item) => item.name);",
    caveat: "Same names, less ceremony. Arrow functions have lexical this and cannot be used as constructors; this is not a universal function replacement.",
    input: [{ name: "Learn" }, { name: "Build" }, { name: "Ship" }],
    older: items => items.map(function (item) { return item.name; }),
    newer: items => items.map(item => item.name),
  },
  {
    label: "2017 / Async",
    context: "ES2017 standardized async/await on top of promises (ES2015). It changes how asynchronous code is expressed, not whether the work is asynchronous.",
    beforeTitle: "ES2015 / PROMISE CHAIN",
    afterTitle: "ES2017 / ASYNC & AWAIT",
    before: "function labels(items) {\n  return Promise.resolve(items)\n    .then(function (rows) {\n      return rows.map(function (row) {\n        return row.name;\n      });\n    });\n}",
    after: "async function labels(items) {\n  const rows = await Promise.resolve(items);\n  return rows.map((row) => row.name);\n}",
    caveat: "Both return a promise. Promise.resolve supplies local sample data here, not a network request. async/await does not make asynchronous work synchronous.",
    input: [{ name: "Learn" }, { name: "Build" }, { name: "Ship" }],
    older: items => Promise.resolve(items).then(function (rows) { return rows.map(function (row) { return row.name; }); }),
    newer: async items => {
      const rows = await Promise.resolve(items);
      return rows.map(row => row.name);
    },
  },
  {
    label: "2020 / Safe access",
    context: "ES2020 added optional chaining and nullish coalescing. Together they express safe access and a fallback for null or undefined, without discarding an empty string.",
    beforeTitle: "EXPLICIT GUARDS / NULLISH VALUES",
    afterTitle: "ES2020 / ?. AND ??",
    before: 'function labels(items) {\n  return items.map(function (item) {\n    var name = item.profile == null\n      ? undefined : item.profile.name;\n    return name == null ? "Anonymous" : name;\n  });\n}',
    after: 'const labels = (items) => items.map(\n  (item) => item.profile?.name ?? "Anonymous"\n);',
    caveat: 'The empty string is intentionally preserved. Using || instead of ?? would replace it. These examples assume every item is a non-null object.',
    input: [{ profile: { name: "Learn" } }, { profile: null }, {}, { profile: { name: "" } }],
    older: items => items.map(function (item) {
      var name = item.profile == null ? undefined : item.profile.name;
      return name == null ? "Anonymous" : name;
    }),
    newer: items => items.map(item => item.profile?.name ?? "Anonymous"),
  },
];

// Run both fixed approaches on the example's shared input. `same` is true when they agree,
// which is the point of every example here.
export async function runExample(example) {
  const [older, newer] = await Promise.all([example.older(example.input), example.newer(example.input)]);
  const before = JSON.stringify(older, null, 2);
  const after = JSON.stringify(newer, null, 2);
  return { before, after, same: before === after };
}
