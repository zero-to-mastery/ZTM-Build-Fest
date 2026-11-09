export const CATALOG_VERSION = 1;
export const categories = Object.freeze([
  "Language",
  "Framework",
  "Runtime",
  "Testing",
  "Build",
  "Database",
  "Styling",
  "State Management",
  "API",
  "Deployment",
  "WebAssembly",
  "Utility",
  "Unknown",
]);
export const groupForCategory = Object.freeze({
  Language: "Core",
  Framework: "Core",
  Runtime: "Core",
  Testing: "Testing",
  Build: "Build",
  Database: "Data",
  Styling: "Styling",
  "State Management": "State Management",
  API: "API",
  Deployment: "Deployment",
  WebAssembly: "WebAssembly",
  Utility: "Utility",
  Unknown: "Unknown",
});
// Exact curated identities only. Do not add substring or keyword guessing.
// Multiple packages may be evidence for one technology; they remain inspectable.
const definitions = [
  ["javascript", "JavaScript", "Language", {}],
  ["typescript", "TypeScript", "Language", { node: ["typescript"] }],
  ["rust", "Rust", "Language", {}],
  ["python", "Python", "Language", {}],
  ["go", "Go", "Language", {}],
  ["nodejs", "Node.js", "Runtime", {}],
  ["bun", "Bun", "Runtime", {}],
  ["deno", "Deno", "Runtime", {}],
  ["tokio", "Tokio", "Runtime", { rust: ["tokio"] }],
  ["react", "React", "Framework", { node: ["react", "react-dom"] }],
  ["next", "Next.js", "Framework", { node: ["next"] }],
  ["vue", "Vue", "Framework", { node: ["vue"] }],
  ["nuxt", "Nuxt", "Framework", { node: ["nuxt"] }],
  ["svelte", "Svelte", "Framework", { node: ["svelte"] }],
  ["angular", "Angular", "Framework", { node: ["@angular/core"] }],
  ["express", "Express", "Framework", { node: ["express"] }],
  ["fastify", "Fastify", "Framework", { node: ["fastify"] }],
  ["django", "Django", "Framework", { python: ["django"] }],
  ["flask", "Flask", "Framework", { python: ["flask"] }],
  ["fastapi", "FastAPI", "Framework", { python: ["fastapi"] }],
  ["axum", "Axum", "Framework", { rust: ["axum"] }],
  ["actix", "Actix Web", "Framework", { rust: ["actix-web"] }],
  ["gin", "Gin", "Framework", { go: ["github.com/gin-gonic/gin"] }],
  ["vitest", "Vitest", "Testing", { node: ["vitest"] }],
  [
    "playwright",
    "Playwright",
    "Testing",
    { node: ["playwright", "@playwright/test"], python: ["playwright"] },
  ],
  ["rtl", "RTL", "Testing", { node: ["@testing-library/react"] }],
  ["jest", "Jest", "Testing", { node: ["jest"] }],
  ["pytest", "pytest", "Testing", { python: ["pytest"] }],
  ["insta", "Insta", "Testing", { rust: ["insta"] }],
  ["proptest", "Proptest", "Testing", { rust: ["proptest"] }],
  ["testify", "Testify", "Testing", { go: ["github.com/stretchr/testify"] }],
  ["vite", "Vite", "Build", { node: ["vite"] }],
  ["webpack", "webpack", "Build", { node: ["webpack"] }],
  ["rollup", "Rollup", "Build", { node: ["rollup"] }],
  [
    "esbuild",
    "esbuild",
    "Build",
    { node: ["esbuild"], go: ["github.com/evanw/esbuild"] },
  ],
  ["setuptools", "setuptools", "Build", { python: ["setuptools"] }],
  ["hatchling", "Hatchling", "Build", { python: ["hatchling"] }],
  ["cc", "cc", "Build", { rust: ["cc"] }],
  [
    "mongodb",
    "MongoDB",
    "Database",
    {
      node: ["mongodb", "mongoose"],
      python: ["pymongo", "motor"],
      rust: ["mongodb"],
      go: ["go.mongodb.org/mongo-driver", "go.mongodb.org/mongo-driver/v2"],
    },
  ],
  [
    "postgresql",
    "PostgreSQL",
    "Database",
    {
      node: ["pg", "postgres"],
      python: ["psycopg", "psycopg2", "psycopg2-binary"],
      rust: ["postgres", "tokio-postgres"],
      go: ["github.com/jackc/pgx/v5"],
    },
  ],
  [
    "mysql",
    "MySQL",
    "Database",
    {
      node: ["mysql2"],
      python: ["pymysql"],
      rust: ["mysql"],
      go: ["github.com/go-sql-driver/mysql"],
    },
  ],
  [
    "sqlite",
    "SQLite",
    "Database",
    {
      node: ["better-sqlite3"],
      rust: ["rusqlite"],
      go: ["modernc.org/sqlite"],
    },
  ],
  ["prisma", "Prisma", "Database", { node: ["prisma", "@prisma/client"] }],
  ["sqlalchemy", "SQLAlchemy", "Database", { python: ["sqlalchemy"] }],
  ["sqlx", "SQLx", "Database", { rust: ["sqlx"] }],
  ["tailwind", "Tailwind CSS", "Styling", { node: ["tailwindcss"] }],
  ["sass", "Sass", "Styling", { node: ["sass"] }],
  [
    "styled-components",
    "styled-components",
    "Styling",
    { node: ["styled-components"] },
  ],
  [
    "emotion",
    "Emotion",
    "Styling",
    { node: ["@emotion/react", "@emotion/styled"] },
  ],
  [
    "redux",
    "Redux",
    "State Management",
    { node: ["redux", "@reduxjs/toolkit"] },
  ],
  ["zustand", "Zustand", "State Management", { node: ["zustand"] }],
  ["pinia", "Pinia", "State Management", { node: ["pinia"] }],
  ["jotai", "Jotai", "State Management", { node: ["jotai"] }],
  [
    "graphql",
    "GraphQL",
    "API",
    { node: ["graphql"], python: ["graphql-core"] },
  ],
  ["axios", "Axios", "API", { node: ["axios"] }],
  ["requests", "Requests", "API", { python: ["requests"] }],
  ["httpx", "HTTPX", "API", { python: ["httpx"] }],
  ["reqwest", "Reqwest", "API", { rust: ["reqwest"] }],
  [
    "grpc",
    "gRPC",
    "API",
    {
      node: ["@grpc/grpc-js"],
      python: ["grpcio"],
      rust: ["tonic"],
      go: ["google.golang.org/grpc"],
    },
  ],
  ["vercel-cli", "Vercel CLI", "Deployment", { node: ["vercel"] }],
  ["netlify-cli", "Netlify CLI", "Deployment", { node: ["netlify-cli"] }],
  [
    "wasm-bindgen",
    "wasm-bindgen",
    "WebAssembly",
    { rust: ["wasm-bindgen", "wasm-bindgen-futures"] },
  ],
  ["wasmtime", "Wasmtime", "WebAssembly", { rust: ["wasmtime"] }],
  ["lodash", "Lodash", "Utility", { node: ["lodash"] }],
  ["zod", "Zod", "Utility", { node: ["zod"] }],
  ["serde", "Serde", "Utility", { rust: ["serde", "serde_json"] }],
  ["anyhow", "Anyhow", "Utility", { rust: ["anyhow"] }],
  ["pydantic", "Pydantic", "Utility", { python: ["pydantic"] }],
  ["zap", "Zap", "Utility", { go: ["go.uber.org/zap"] }],
];
export const catalog = Object.freeze(
  definitions.map(([id, name, category, packages]) =>
    Object.freeze({
      id,
      name,
      category,
      packages: Object.freeze(
        Object.fromEntries(
          Object.entries(packages).map(([ecosystem, names]) => [
            ecosystem,
            Object.freeze(names),
          ]),
        ),
      ),
    }),
  ),
);
export const primaryLanguages = Object.freeze({
  JavaScript: "javascript",
  TypeScript: "typescript",
  Rust: "rust",
  Python: "python",
  Go: "go",
});
const byId = new Map(catalog.map((technology) => [technology.id, technology]));
const byPackage = new Map(
  catalog.flatMap((technology) =>
    Object.entries(technology.packages).flatMap(([ecosystem, names]) =>
      names.map((name) => [JSON.stringify([ecosystem, name]), technology]),
    ),
  ),
);
export function technologyById(id) {
  return byId.get(id);
}
export function technologyForDependency(dependency) {
  return (
    byPackage.get(JSON.stringify([dependency.ecosystem, dependency.name])) || {
      id: "unknown:" + JSON.stringify([dependency.ecosystem, dependency.name]),
      name: dependency.name,
      category: "Unknown",
      ecosystem: dependency.ecosystem,
    }
  );
}
