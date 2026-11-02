// open.blog's built-in syntax highlighter: a small, dependency-free tokenizer
// used by <ob-code highlight>. It has no DOM access, so it also runs under
// Node for tests (tests/web/highlight.test.mjs).
//
//   highlight(code, language) -> [{ text, cls }]   cls is null for plain text
//   detectLanguage(code)      -> a language name, or null when unsure
//
// Token classes, painted as <span class="tok-…"> and coloured by the theme's
// --ob-color-code-* tokens: keyword, string, comment, number, function, type,
// attr, tag, meta, variable, property, operator, punctuation, constant, regex,
// prompt.

const ALIASES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", shellsession: "bash", powershell: "bash", ps1: "bash",
  yml: "yaml", rs: "rust", py: "python", python3: "python", rb: "ruby",
  html: "markup", xml: "markup", svg: "markup", vue: "markup", astro: "markup", svelte: "markup",
  c: "clike", cpp: "clike", "c++": "clike", h: "clike", hpp: "clike", java: "clike", cs: "clike", csharp: "clike",
  kt: "clike", kotlin: "clike", swift: "clike", scala: "clike", dart: "clike", php: "clike",
  golang: "go", md: "markdown", mkd: "markdown", scss: "css", less: "css", jsonc: "json", json5: "json",
  txt: "none", text: "none", plain: "none", plaintext: "none", output: "none",
};

const words = (s) => new Set(s.trim().split(/\s+/));

// ---------- Shared rules (all regexes are sticky: they match at the cursor) ----------

const WS = { re: /\s+/y, cls: null };
const LINE_COMMENT = (prefix) => ({ re: new RegExp(`${prefix}[^\\n]*`, "y"), cls: "comment" });
const BLOCK_COMMENT = { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: "comment" };
const DQ_STRING = { re: /"(?:\\[\s\S]|[^"\\\n])*"?/y, cls: "string" };
const SQ_STRING = { re: /'(?:\\[\s\S]|[^'\\\n])*'?/y, cls: "string" };
const NUMBER = { re: /\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[a-zA-Z_]\w*)?\b|\B\.\d+\b/y, cls: "number" };
const OPERATOR = { re: /=>|->|::|\?\?=?|\?\.|\.\.\.|\.\.=?|\*\*=?|[=!]==?|<<=?|>>>?=?|[<>]=?|&&=?|\|\|=?|[-+*/%&|^]=?|:=|[=!~?:@]/y, cls: "operator" };
const PUNCTUATION = { re: /[{}()[\];,.]/y, cls: "punctuation" };

const CALL_AHEAD = /^\s*(?:<[\w\s,<>[\]:&']*>\s*)?(?:::\s*<[^>]*>\s*)?\(/;
// `name = function`, `name = (a, b) =>`, `name = async x =>`: the name is a function.
const ASSIGNS_FUNCTION = /^\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::\s*[^=;\n]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const DEFINERS = words("fn function def func fun");
const TYPE_INTRODUCERS = words("class new extends implements interface type enum struct trait impl union instanceof");
const CONTEXTUAL = words("get set of from"); // keywords that are also common method names
const ASSOCIATED_TYPES = words("Item Output Error Target Owned Err IntoIter");

/**
 * Identifier rule shared by the C-like languages. Decides between keyword,
 * constant, type, function, property and plain from the word itself, the
 * tokens before it, the innermost open bracket, and what follows.
 */
function ident(keywords, { types = new Set(), constants = new Set(), capsAreTypes = false } = {}) {
  return {
    re: /[A-Za-z_$][\w$]*/y,
    cls: (m, src, end, start, prev, ctx = {}) => {
      const ahead = src.slice(end, end + 120);
      const p = prev ? prev.text : "";
      const call = CALL_AHEAD.test(ahead);
      if (p === "." || p === "?.") return call || ASSIGNS_FUNCTION.test(ahead) ? "function" : "property";
      // `{ key: value }` and struct fields, but not `(a: T, b: U)` parameters.
      if ((p === "{" || p === ",") && ctx.top === "{" && /^\s*\??:(?!:)/.test(ahead)) return "property";
      // Enum variants: `Ordering::Less`, `Shape::Circle(r)`; not associated
      // types in type position such as `Self::Item>` or `T::Output,`.
      if (p === "::" && /^[A-Z][a-z]/.test(m) && ctx.prev2 && (ctx.prev2.cls === "type" || ctx.prev2.text === "Self") &&
        !ASSOCIATED_TYPES.has(m) && !/^\s*(?:::|<|[>;]|=(?!>))/.test(ahead)) return "constant";
      if (constants.has(m)) return "constant";
      // `get(url) {}` is a method; `for (x of (list))` keeps `of` a keyword.
      if (CONTEXTUAL.has(m) && /^\s*\(/.test(ahead) && (!prev || /^[{};,]$/.test(p) || /^(?:static|async)$/.test(p))) return "function";
      if (keywords.has(m)) return "keyword";
      if (prev && prev.cls === "keyword") {
        if (DEFINERS.has(p)) return "function";
        if (TYPE_INTRODUCERS.has(p)) return "type";
      }
      if (ASSIGNS_FUNCTION.test(ahead)) return "function";
      if (call) return /^[A-Z]/.test(m) && capsAreTypes && !/^[A-Z][A-Z0-9_]+$/.test(m) ? "type" : "function";
      if (/^[A-Z][A-Z0-9_]+$/.test(m)) return "constant";
      if (types.has(m)) return "type";
      if (capsAreTypes && /^[A-Z]/.test(m)) return "type";
      return null;
    },
  };
}

// ---------- Vocabularies ----------

const RUST_KW = words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while union macro_rules");
const RUST_TY = words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc RefCell Cell HashMap HashSet BTreeMap BTreeSet VecDeque Cow");
const RUST_CONST = words("true false None Some Ok Err");
const JS_KW = words("abstract as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public return satisfies set static super switch this throw try type typeof var void while with yield keyof readonly declare namespace module override");
const JS_TY = words("Array Object String Number Boolean Promise Map Set WeakMap WeakSet Symbol BigInt Date RegExp Error JSON Math Intl Reflect Proxy console document window navigator globalThis customElements HTMLElement Element Node Event URL Response Request Headers");
const JS_CONST = words("true false null undefined NaN Infinity");
const TS_TY = words("string number boolean any unknown never void object bigint symbol Record Partial Required Readonly Pick Omit");
const PY_KW = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls");
const PY_TY = words("int float str bool list dict set tuple bytes object range print len type super isinstance enumerate zip map filter open Exception ValueError TypeError KeyError");
const PY_CONST = words("True False None");
const GO_KW = words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const GO_TY = words("bool byte rune string error int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 any");
const GO_CONST = words("true false nil iota");
const CLIKE_KW = words("abstract as break case catch class const continue default delete do else enum explicit export extends extern final finally for friend goto if implements import in inline instanceof interface internal namespace native new operator override package private protected public return sealed sizeof static struct super switch synchronized template this throw throws transient try typedef typename union unsigned using var virtual void volatile while with yield fun val let when object data companion guard defer func init mutating where is out ref readonly");
const CLIKE_TY = words("int long short char float double bool boolean byte string String void auto size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t Int Double Float Bool List Map Array Integer");
const CLIKE_CONST = words("true false null nullptr nil");
const SQL_KW = words("select from where and or not in is as join inner left right full outer cross on group by order having limit offset insert into values update set delete create table drop alter add column primary key foreign references index view if exists distinct union all case when then else end like ilike between asc desc with returning default unique check constraint begin commit rollback transaction grant revoke truncate");
const SQL_TY = words("int integer bigint smallint serial bigserial text varchar char boolean bool date time timestamp timestamptz numeric decimal real float double json jsonb uuid blob");
const BASH_KW = words("if then else elif fi for while until do done case esac in function select time return exit export local readonly set unset source alias declare eval exec shift trap");

// ---------- Languages ----------

const JS_REGEX_AFTER_KW = words("return typeof case do else in of yield await void delete throw new instanceof");
const JS_REGEX = {
  re: /\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n]){0,200}\]|[^/\\\n[]){1,500}\/[dgimsuyv]*/y,
  cls: "regex",
  when: (prev) =>
    !prev ||
    (prev.cls === "operator" && prev.text !== "++" && prev.text !== "--") ||
    (prev.cls === "punctuation" && !/^[)\]}]$/.test(prev.text)) ||
    (prev.cls === "keyword" && JS_REGEX_AFTER_KW.has(prev.text)),
};

const SHEBANG = { re: /#![^\n]*/y, cls: "comment", when: (prev) => !prev };

/** Index just past a quoted string starting at s[k] (stops at a newline). */
function skipQuoted(s, k) {
  const q = s[k];
  k += 1;
  while (k < s.length && s[k] !== q && s[k] !== "\n") k += s[k] === "\\" ? 2 : 1;
  return Math.min(s.length, k + 1);
}

/**
 * Scan JavaScript from j with an explicit stack instead of recursion, so any
 * nesting depth is safe. Stack entries: "`" template text, "$" a ${…}
 * interpolation, "{" a brace block in code. Returns the index just past the
 * point where the stack empties, or s.length.
 */
function scanCode(s, j, stack) {
  while (j < s.length && stack.length) {
    const c = s[j];
    if (stack[stack.length - 1] === "`") {
      if (c === "\\") j += 2;
      else if (c === "`") {
        stack.pop();
        j += 1;
      } else if (c === "$" && s[j + 1] === "{") {
        stack.push("$");
        j += 2;
      } else j += 1;
    } else if (c === "`") {
      stack.push("`");
      j += 1;
    } else if (c === '"' || c === "'") j = skipQuoted(s, j);
    else if (c === "{") {
      stack.push("{");
      j += 1;
    } else if (c === "}") {
      stack.pop();
      j += 1;
    } else j += 1;
  }
  return Math.min(j, s.length);
}

const scanTemplate = (s, i) => scanCode(s, i + 1, ["`"]); // s[i] is a backtick
const scanBraces = (s, k) => scanCode(s, k, ["{"]); // k is just past a `{`

// A "regex" with its own exec, so template literals can nest inside ${…}.
const TEMPLATE_SCANNER = {
  lastIndex: 0,
  exec(s) {
    const start = this.lastIndex;
    if (s[start] !== "`") return null;
    return [s.slice(start, scanTemplate(s, start))];
  },
};

/** One JSX or HTML tag starting at s[i] === "<": its end and name, or null
 * when the text is not a tag (`a < b && c > d` is rejected). */
function scanTag(s, i) {
  let j = i + 1;
  const closing = s[j] === "/";
  if (closing) j += 1;
  const nameRe = /[A-Za-z][\w.:-]*/y;
  nameRe.lastIndex = j;
  const nm = nameRe.exec(s);
  const name = nm ? nm[0] : "";
  if (!nm && s[j] !== ">") return null; // only <> and </> may be nameless
  j += name.length;
  while (j < s.length) {
    const c = s[j];
    if (c === ">") return { end: j + 1, name, closing, selfClosing: false };
    if (c === "/" && s[j + 1] === ">") return { end: j + 2, name, closing, selfClosing: true };
    if (c === "{") j = scanBraces(s, j + 1);
    else if (c === '"' || c === "'") {
      const e = s.indexOf(c, j + 1);
      if (e < 0) return null;
      j = e + 1;
    } else if (/[\s\w:.@=-]/.test(c)) j += 1;
    else return null;
  }
  return null;
}

/** A whole JSX element at s[i], children included, or null. */
function scanJsxElement(s, i) {
  const open = scanTag(s, i);
  if (!open || open.closing) return null;
  if (open.selfClosing) return open.end;
  // `<number>value` is a TypeScript cast unless a matching close tag follows.
  if (s.indexOf(`</${open.name}`, open.end) < 0) return null;
  let depth = 1;
  let j = open.end;
  while (j < s.length) {
    const lt = s.indexOf("<", j);
    const lb = s.indexOf("{", j);
    if (lb >= 0 && (lt < 0 || lb < lt)) {
      j = scanBraces(s, lb + 1);
      continue;
    }
    if (lt < 0) return null;
    const t = scanTag(s, lt);
    if (!t) {
      j = lt + 1;
      continue;
    }
    j = t.end;
    if (t.closing) {
      depth -= 1;
      if (depth === 0) return j;
    } else if (!t.selfClosing) depth += 1;
  }
  return null;
}

const JSX_SCANNER = {
  lastIndex: 0,
  exec(s) {
    const start = this.lastIndex;
    if (s[start] !== "<") return null;
    const end = scanJsxElement(s, start);
    return end ? [s.slice(start, end)] : null;
  },
};

/** Tokens for a JSX element: tags, `{…}` as code, and text children plain. */
function jsxTokens(text, rules) {
  const out = [];
  const code = (c) => tokenize(c, rules);
  let j = 0;
  while (j < text.length) {
    const lt = text.indexOf("<", j);
    const lb = text.indexOf("{", j);
    const next = Math.min(lt < 0 ? text.length : lt, lb < 0 ? text.length : lb);
    if (next > j) out.push({ text: text.slice(j, next), cls: null });
    if (next >= text.length) break;
    if (next === lb) {
      const e = scanBraces(text, lb + 1);
      const closed = text[e - 1] === "}";
      out.push({ text: "{", cls: "punctuation" }, ...code(text.slice(lb + 1, closed ? e - 1 : e)));
      if (closed) out.push({ text: "}", cls: "punctuation" });
      j = e;
    } else {
      const t = scanTag(text, lt);
      if (!t) {
        out.push({ text: "<", cls: null });
        j = lt + 1;
      } else {
        out.push(...tagTokens(text.slice(lt, t.end), code));
        j = t.end;
      }
    }
  }
  return out;
}

function jsRules(kw, opts) {
  const rules = [WS, SHEBANG, LINE_COMMENT("//"), BLOCK_COMMENT, DQ_STRING, SQ_STRING];
  rules.push({ re: TEMPLATE_SCANNER, cls: (m) => templateTokens(m, rules) });
  rules.push(JS_REGEX);
  rules.push({ re: JSX_SCANNER, cls: (m) => jsxTokens(m, rules), when: JS_REGEX.when });
  rules.push(NUMBER, { re: /#[A-Za-z_]\w*/y, cls: "property" }, { re: /@[A-Za-z_][\w.]*/y, cls: "meta" }, ident(kw, opts), OPERATOR, PUNCTUATION);
  return rules;
}

// Template literals nest inside ${…}; past this depth the rest is one string,
// which keeps pathological input linear.
let templateNesting = 0;

/** A template literal: string parts, with each ${…} highlighted as code. */
function templateTokens(text, rules) {
  if (templateNesting > 16) return [{ text, cls: "string" }];
  templateNesting += 1;
  try {
    const out = [];
    let i = 0;
    let str = "";
    while (i < text.length) {
      if (text[i] === "\\") {
        str += text.slice(i, i + 2);
        i += 2;
      } else if (text.startsWith("${", i)) {
        const j = scanCode(text, i + 2, ["$"]);
        if (str) out.push({ text: str, cls: "string" });
        str = "";
        const closed = text[j - 1] === "}" && j > i + 2;
        out.push({ text: "${", cls: "keyword" });
        out.push(...tokenize(text.slice(i + 2, closed ? j - 1 : j), rules));
        if (closed) out.push({ text: "}", cls: "keyword" });
        i = j;
      } else {
        str += text[i];
        i += 1;
      }
    }
    if (str) out.push({ text: str, cls: "string" });
    return out;
  } finally {
    templateNesting -= 1;
  }
}

// CSS needs to know whether a word is in a selector (a `{` comes before the
// next `;` or `}`). The answer for every position is computed once per source.
let cssStops = { src: null, next: null };
function selectorAhead(src, i) {
  if (cssStops.src !== src) {
    const next = new Int32Array(src.length + 1);
    next[src.length] = src.length;
    for (let k = src.length - 1; k >= 0; k -= 1) next[k] = "{};".includes(src[k]) ? k : next[k + 1];
    cssStops = { src, next };
  }
  return src[cssStops.next[Math.min(i, src.length)]] === "{";
}

const CSS_RULES = [
  WS, BLOCK_COMMENT, LINE_COMMENT("//"), DQ_STRING, SQ_STRING,
  { re: /@[\w-]+/y, cls: "keyword" },
  { re: /!important/y, cls: "keyword" },
  { re: /--[\w-]+/y, cls: "variable" },
  { re: /\$[\w-]+/y, cls: "variable" },
  { re: /#[\da-fA-F]{3,8}(?![\w-])/y, cls: (m, src, end) => (selectorAhead(src, end) ? "tag" : "number") },
  { re: /-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, cls: "number" },
  // @media (min-width: …): a feature name in an at-rule prelude.
  { re: /(?<=@(?:media|supports|container|import)\b[^{;]{0,200}\(\s*)[\w-]+(?=\s*:)/y, cls: "attr" },
  { re: /[\w-]+(?=\s*:)/y, cls: (m, src, end) => (selectorAhead(src, end) ? "tag" : "attr") }, // a:hover { vs color:
  { re: /[\w-]+(?=\()/y, cls: "function" },
  { re: /(?:\.|#|::?)[\w-]+|\[[^\]\n]{0,200}\]|&/y, cls: "tag" },
  { re: /[A-Za-z_][\w-]*/y, cls: (m, src, end) => (selectorAhead(src, end) ? "tag" : "constant") },
  { re: /[>+~*,/=]/y, cls: "operator" },
  { re: /[{}();:]/y, cls: "punctuation" },
];

const LANGUAGES = {
  javascript: jsRules(JS_KW, { types: JS_TY, constants: JS_CONST, capsAreTypes: true }),
  typescript: jsRules(JS_KW, { types: new Set([...JS_TY, ...TS_TY]), constants: JS_CONST, capsAreTypes: true }),
  rust: [
    WS, LINE_COMMENT("//"), BLOCK_COMMENT,
    { re: /#!?\[[^\]\n]{0,300}\]/y, cls: rustAttribute },
    { re: /'[A-Za-z_]\w*(?!')/y, cls: "meta" }, // lifetime
    { re: /b?r(#*)"[\s\S]*?(?:"\1|(?![\s\S]))/y, cls: "string" }, // unterminated: to the end
    { re: /b?"(?:\\[\s\S]|[^"\\])*"?/y, cls: "string" },
    { re: /b?'(?:\\.|\\u\{[\da-fA-F]+\}|[^'\\])'/y, cls: "string" },
    NUMBER,
    { re: /[A-Za-z_]\w*!(?=\s*[([{])/y, cls: "function" }, // macro
    ident(RUST_KW, { types: RUST_TY, constants: RUST_CONST, capsAreTypes: true }),
    OPERATOR, PUNCTUATION,
  ],
  go: [WS, LINE_COMMENT("//"), BLOCK_COMMENT, DQ_STRING, { re: /`[^`]*`?/y, cls: "string" }, SQ_STRING, NUMBER, ident(GO_KW, { types: GO_TY, constants: GO_CONST }), OPERATOR, PUNCTUATION],
  clike: [
    WS, LINE_COMMENT("//"), BLOCK_COMMENT,
    { re: /#\s*\w+[^\n]*/y, cls: "meta" },
    DQ_STRING, SQ_STRING, NUMBER,
    { re: /@\w+/y, cls: "meta" },
    ident(CLIKE_KW, { types: CLIKE_TY, constants: CLIKE_CONST, capsAreTypes: true }),
    OPERATOR, PUNCTUATION,
  ],
  python: [
    WS, LINE_COMMENT("#"),
    { re: /[rbfuRBFU]*("""|''')[\s\S]*?(?:\1|$)/y, cls: "string" },
    { re: /[rbfuRBFU]*"(?:\\[\s\S]|[^"\\\n])*"?/y, cls: "string" },
    { re: /[rbfuRBFU]*'(?:\\[\s\S]|[^'\\\n])*'?/y, cls: "string" },
    { re: /(?<=^[ \t]*)@[\w.]+/my, cls: "meta" },
    NUMBER,
    ident(PY_KW, { types: PY_TY, constants: PY_CONST, capsAreTypes: true }),
    OPERATOR, PUNCTUATION,
  ],
  ruby: [
    WS, LINE_COMMENT("#"), DQ_STRING, SQ_STRING,
    { re: /:[A-Za-z_]\w*[?!]?/y, cls: "constant" },
    { re: /@{1,2}\w+/y, cls: "variable" },
    NUMBER,
    ident(words("def end class module if elsif else unless while until for do return yield begin rescue ensure self nil true false and or not then when case require require_relative include extend attr_accessor attr_reader attr_writer puts private protected lambda proc"), { constants: words("nil true false"), capsAreTypes: true }),
    OPERATOR, PUNCTUATION,
  ],
  bash: [
    { re: /(?<=^[ \t]*)(?:[\w@~:/.-]*\$|PS [^>\n]*>) /my, cls: "prompt" },
    WS,
    { re: /(?<=^|[\s;|&(])#[^\n]*/my, cls: "comment" }, // not the # in page#section
    // Shell strings may span lines; an unterminated quote stops at the line end.
    { re: /'[^']*'|"(?:\\[\s\S]|[^"\\])*"/y, cls: "string" },
    DQ_STRING, SQ_STRING,
    { re: /\$(?:\{[^}\n]*\}|\(\(?|[\w@#?*$!-]+)/y, cls: "variable" },
    { re: /(?<=^|[\s|&;(])--?[\w-]+(?:=[^\s"']*)?/y, cls: "attr" },
    { re: /[A-Za-z_]\w*(?==)/y, cls: "variable" },
    // 1.2.0 is one number; 7300a6f (a commit) and 8080:80 (a mapping) are words.
    { re: /(?<![\w.:/@-])\d+(?:\.\d+)*(?![\w./:-])/y, cls: "number" },
    // An unterminated heredoc runs to the end, so it is never rescanned.
    { re: /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?(?:^[ \t]*\2$|(?![\s\S]))/my, cls: heredoc },
    {
      re: /[\w./~][\w.\/~:@#%+,=-]*/y,
      cls: (m, src, end, start) => {
        if (/^\d/.test(m)) return null;
        if (BASH_KW.has(m)) return "keyword";
        // A command is the first word of a line (after any prompt) or follows
        // a pipe, a separator, a condition, or a wrapper such as sudo.
        const line = src.slice(src.lastIndexOf("\n", start - 1) + 1, start);
        return /^[ \t]*(?:(?:[\w@~:/.-]*\$|PS [^>\n]*>) )?$/.test(line) ||
          /(?:[|&;(!]|\b(?:sudo|if|elif|while|until|then|do|else|time|exec|xargs|nohup|env|npx))[ \t]*$/.test(line)
          ? "function"
          : null;
      },
    },
    { re: /&&|\|\||[|;&!]|>>?|<<?|\\$/my, cls: "operator" },
    { re: /[{}()[\]]/y, cls: "punctuation" },
  ],
  sql: [
    WS, LINE_COMMENT("--"), BLOCK_COMMENT, SQ_STRING, DQ_STRING, NUMBER,
    {
      re: /[A-Za-z_]\w*/y,
      cls: (m, src, end, start, prev) => {
        const lower = m.toLowerCase();
        if (prev && prev.text === ".") return "property";
        if (lower === "true" || lower === "false" || lower === "null") return "constant";
        if (SQL_KW.has(lower)) return "keyword";
        if (SQL_TY.has(lower)) return "type";
        return /^\s*\(/.test(src.slice(end, end + 4)) ? "function" : null;
      },
    },
    { re: /<>|!=|<=|>=|\|\||::|[-+*/%=<>]/y, cls: "operator" },
    PUNCTUATION,
  ],
  json: [
    WS, LINE_COMMENT("//"), BLOCK_COMMENT,
    { re: /"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y, cls: "attr" },
    DQ_STRING, NUMBER,
    { re: /\b(?:true|false|null)\b/y, cls: "constant" },
    { re: /[{}[\],:]/y, cls: "punctuation" },
  ],
  yaml: [
    WS, LINE_COMMENT("#"),
    { re: /^(?:---|\.\.\.)$/my, cls: "meta" },
    { re: /(?<=^[ \t]*(?:- )?)[^\s#:"'-][^:\n]*(?=:(?:\s|$))/my, cls: "attr" },
    { re: /[&*][\w-]+/y, cls: "variable" },
    { re: /![\w!]+/y, cls: "meta" },
    DQ_STRING, SQ_STRING,
    { re: /\b(?:true|false|null|yes|no|on|off)\b(?!:)/y, cls: "constant" },
    NUMBER,
    { re: /(?<=^[ \t]*)-(?=\s)/my, cls: "punctuation" },
    { re: /[|>][+-]?(?=\s*$)/my, cls: "operator" },
    { re: /[{}[\],:]/y, cls: "punctuation" },
  ],
  toml: [
    WS, LINE_COMMENT("#"),
    { re: /(?<=^[ \t]*)\[\[?[^\]\n]+\]\]?/my, cls: "tag" },
    { re: /(?<=^[ \t]*)[\w."'-]+(?=\s*=)/my, cls: "attr" },
    { re: /"""[\s\S]*?"""|'''[\s\S]*?'''/y, cls: "string" },
    DQ_STRING, SQ_STRING,
    { re: /\d{4}-\d\d-\d\d(?:[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?)?/y, cls: "number" },
    NUMBER,
    { re: /\b(?:true|false|inf|nan)\b/y, cls: "constant" },
    { re: /[[\]{},.]/y, cls: "punctuation" },
    { re: /=/y, cls: "operator" },
  ],
  css: CSS_RULES,
  markdown: [
    WS,
    { re: /^#{1,6} [^\n]*/my, cls: "keyword" },
    { re: /```[\s\S]*?```/y, cls: "string" },
    { re: /`[^`\n]+`/y, cls: "string" },
    { re: /\*\*[^*\n]+\*\*|__[^_\n]+__/y, cls: "type" },
    { re: /!?\[[^\]\n]{0,300}\]\([^)\n]{0,500}\)/y, cls: "function" },
    { re: /^>[^\n]*/my, cls: "comment" },
    { re: /(?<=^[ \t]*)(?:[-*+]|\d+\.) /my, cls: "punctuation" },
  ],
};

// ---------- Tokenizer ----------

/** Tokenize with sticky rules; returns [{text, cls}] covering the whole source. */
function tokenize(src, rules) {
  const out = [];
  let pos = 0;
  let plain = "";
  let prev = null; // the last token that was not whitespace
  let prev2 = null; // the one before it
  const brackets = []; // open ( [ { so rules know where they are
  const flush = () => {
    if (plain) out.push({ text: plain, cls: null });
    plain = "";
  };
  const seen = (token) => {
    if (token.cls === "comment") return; // comments are trivia for context
    prev2 = prev;
    prev = token;
    if (token.text.length === 1 && token.cls !== "string") {
      if ("([{".includes(token.text)) brackets.push(token.text);
      else if (")]}".includes(token.text)) brackets.pop();
    }
  };
  while (pos < src.length) {
    let matched = false;
    for (const rule of rules) {
      if (rule.when && !rule.when(prev)) continue;
      rule.re.lastIndex = pos;
      const m = rule.re.exec(src);
      if (!m || m[0].length === 0) continue;
      const text = m[0];
      const cls = typeof rule.cls === "function"
        ? rule.cls(text, src, pos + text.length, pos, prev, { top: brackets[brackets.length - 1], prev2 })
        : rule.cls;
      if (Array.isArray(cls)) {
        // A nested run (template literal, tag, attribute) is balanced inside.
        flush();
        out.push(...cls);
        const last = cls.filter((t) => t.cls !== "comment" && /\S/.test(t.text));
        if (last.length) {
          prev2 = last.length > 1 ? last[last.length - 2] : prev;
          prev = last[last.length - 1];
        }
      } else if (cls) {
        flush();
        out.push({ text, cls });
        seen({ text, cls });
      } else {
        plain += text;
        if (/\S/.test(text)) seen({ text, cls: null });
      }
      pos += text.length;
      matched = true;
      break;
    }
    if (!matched) {
      const ch = src[pos];
      plain += ch;
      if (/\S/.test(ch)) seen({ text: ch, cls: null });
      pos += 1;
    }
  }
  flush();
  return out;
}

/** Tokens for one HTML or JSX tag: `<`, name, attributes, `>`. With `code`,
 * JSX `{…}` values are highlighted as code; otherwise they are strings. */
function tagTokens(tag, code) {
  const out = [];
  const open = tag.startsWith("</") ? "</" : "<";
  const name = tag.slice(open.length).match(/^[^\s>/]*/)[0];
  out.push({ text: open, cls: "punctuation" });
  if (name) out.push({ text: name, cls: /[-.]|^[A-Z]/.test(name) ? "type" : "tag" });
  // `{…}` values (JSX) are code when `code` is given, at any brace depth.
  const braces = (v) => {
    if (!code) return [{ text: v, cls: "string" }];
    const closed = v.endsWith("}") && v.length > 1;
    return [{ text: "{", cls: "punctuation" }, ...code(v.slice(1, closed ? -1 : undefined)), ...(closed ? [{ text: "}", cls: "punctuation" }] : [])];
  };
  const rest = tag.slice(open.length + name.length);
  let j = 0;
  let afterEquals = false;
  while (j < rest.length) {
    const c = rest[j];
    let k = j + 1;
    if (/\s/.test(c)) {
      while (k < rest.length && /\s/.test(rest[k])) k += 1;
      out.push({ text: rest.slice(j, k), cls: null });
    } else if (c === "{") {
      k = scanBraces(rest, j + 1);
      out.push(...braces(rest.slice(j, k)));
      afterEquals = false;
    } else if (c === '"' || c === "'") {
      const e = rest.indexOf(c, j + 1);
      k = e < 0 ? rest.length : e + 1;
      out.push({ text: rest.slice(j, k), cls: "string" });
      afterEquals = false;
    } else if (c === "=") {
      out.push({ text: "=", cls: "operator" });
      afterEquals = true;
    } else if (c === ">" || (c === "/" && rest[j + 1] === ">")) {
      k = c === ">" ? j + 1 : j + 2;
      out.push({ text: rest.slice(j, k), cls: "punctuation" });
    } else {
      while (k < rest.length && !/[\s=>"'{]/.test(rest[k]) && !(rest[k] === "/" && rest[k + 1] === ">")) k += 1;
      out.push({ text: rest.slice(j, k), cls: afterEquals ? "string" : "attr" }); // unquoted value or a name
      afterEquals = false;
    }
    j = k;
  }
  return out;
}

/** `#[derive(Debug, Clone)]`: brackets and the attribute name as meta, the
 * arguments as Rust, so types and strings keep their colours. */
function rustAttribute(m) {
  const open = m.startsWith("#![") ? "#![" : "#[";
  const inner = m.slice(open.length, -1);
  const path = (inner.match(/^\s*[\w:]+/) || [""])[0];
  return [
    { text: open, cls: "meta" },
    ...(path ? [{ text: path, cls: "meta" }] : []),
    ...tokenize(inner.slice(path.length), LANGUAGES.rust),
    { text: "]", cls: "meta" },
  ];
}

/** `cat <<'EOF' > file` … `EOF`: the body is a string, not commands. */
function heredoc(m) {
  const op = m.match(/^<<-?/)[0];
  const nl = m.indexOf("\n");
  const head = m.slice(op.length, nl);
  const delim = head.match(/^[ \t]*(['"]?)\w+\1/)[0];
  const lastNl = m.lastIndexOf("\n");
  return [
    { text: op, cls: "operator" },
    { text: delim, cls: "string" },
    ...tokenize(head.slice(delim.length), LANGUAGES.bash),
    { text: m.slice(nl, lastNl + 1), cls: "string" },
    { text: m.slice(lastNl + 1), cls: "string" },
  ];
}

// A shell prompt at the start of a line: `$ `, `user@host:~$ `, `PS C:\> `.
const PROMPT = /^[ \t]*(?:[\w@~:/.-]*\$|PS [^>\n]*>) /m;

/** A terminal session: lines after a prompt are commands; the rest is output. */
function consoleTokens(code) {
  const out = [];
  let continued = false;
  for (const line of code.split(/(?<=\n)/)) {
    if (continued || PROMPT.test(line)) {
      out.push(...tokenize(line, LANGUAGES.bash));
      continued = /\\\r?\n$/.test(line);
    } else {
      // `# note` is a comment; `## main` (git status -sb) and other `##` output is just output.
      out.push({ text: line, cls: /^\s*#(?!#)/.test(line) ? "comment" : null });
    }
  }
  return out;
}

/** HTML and XML: tags, attributes and values, comments, entities, and the
 * contents of <script> and <style> highlighted as JavaScript and CSS. */
function tokenizeMarkup(src) {
  const out = [];
  const text = (s) => {
    const re = /&(?:#x?[\da-fA-F]+|\w+);/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ text: s.slice(last, m.index), cls: null });
      out.push({ text: m[0], cls: "constant" });
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push({ text: s.slice(last), cls: null });
  };
  // A tag may not contain another `<`, so a failed attempt stops at the next one.
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![A-Za-z][^<>]*>|<\?[\s\S]*?(?:\?>|$)|<\/?[A-Za-z][^\s<>/]*(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\/?>/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) text(src.slice(last, m.index));
    const tag = m[0];
    if (tag.startsWith("<!--")) out.push({ text: tag, cls: "comment" });
    else if (tag.startsWith("<![CDATA[")) out.push({ text: tag, cls: "string" });
    else if (tag.startsWith("<!") || tag.startsWith("<?")) out.push({ text: tag, cls: "meta" });
    else {
      const open = tag.startsWith("</") ? "</" : "<";
      const name = tag.slice(open.length).match(/^[^\s>/]+/)[0];
      out.push(...tagTokens(tag));
      // Script and style bodies are code in another language.
      const lower = name.toLowerCase();
      if (open === "<" && !tag.endsWith("/>") && (lower === "script" || lower === "style")) {
        // Search the original text: lower-casing can change its length (İ).
        const closeRe = new RegExp(`</${lower}(?=[\\s>/])`, "gi");
        closeRe.lastIndex = m.index + tag.length;
        const cm = closeRe.exec(src);
        const end = cm ? cm.index : src.length;
        const body = src.slice(m.index + tag.length, end);
        if (body) {
          const json = lower === "script" && /type\s*=\s*["']?application\/(?:ld\+)?json/i.test(tag);
          out.push(...highlight(body, lower === "style" ? "css" : json ? "json" : "javascript"));
        }
        re.lastIndex = end;
        last = end;
        continue;
      }
    }
    last = m.index + tag.length;
  }
  if (last < src.length) text(src.slice(last));
  return out;
}

export function highlight(code, language) {
  const lang = ALIASES[language] || language;
  if (lang === "markup") return tokenizeMarkup(code);
  if (lang === "bash" && PROMPT.test(code)) return consoleTokens(code);
  const rules = LANGUAGES[lang];
  return rules ? tokenize(code, rules) : [{ text: code, cls: null }];
}

/** True when `language` (a fence's info string) names a language we colour. */
export function isKnownLanguage(language) {
  const lang = ALIASES[language] || language;
  return lang === "markup" || Object.hasOwn(LANGUAGES, lang);
}

/** True for fences marked as plain text or program output (`text`, `output`). */
export function isPlainText(language) {
  return ALIASES[language] === "none";
}

const TERMINAL = new Set(["bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession", "powershell", "ps1", "pwsh", "cmd", "bat"]);

/** True for fences that show a terminal session or shell commands, which are not numbered by default. */
export function isTerminal(language) {
  return TERMINAL.has(String(language || "").toLowerCase());
}

/** `"1,3-5"` -> Set {1, 3, 4, 5}. Ranges are capped, so a typo cannot hang the page. */
export function parseLineRanges(spec, max = 10000) {
  const lines = new Set();
  for (const part of String(spec || "").split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    let from = Number(m[1]);
    let to = m[2] ? Number(m[2]) : from;
    if (from > to) [from, to] = [to, from]; // {5-3} means 3 to 5
    to = Math.min(to, max);
    for (let n = from; n <= to; n += 1) lines.add(n);
  }
  return lines;
}

/**
 * Split tokens into lines, cutting tokens that span lines (block comments,
 * multi-line strings). A final newline does not start an extra empty line.
 */
export function splitLines(tokens) {
  const lines = [[]];
  for (const t of tokens) {
    const parts = t.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls: t.cls });
    });
  }
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

// ---------- Language detection for blocks without a language ----------
//
// Imported posts often have fences with no language. Each candidate scores
// points for telltale lines and loses points for things it never contains;
// the best score wins if it is clear enough. When unsure, the block stays plain.

const SHELL_COMMANDS = "git|npm|npx|yarn|pnpm|bun|deno|node|cargo|rustup|rustc|wasm-pack|trunk|cd|ls|ll|mkdir|rmdir|rm|cp|mv|cat|echo|printf|export|curl|wget|brew|apt|apt-get|yum|dnf|pacman|docker|docker-compose|kubectl|helm|ssh|ssh-keygen|ssh-add|ssh-agent|ssh-copy-id|scp|rsync|chmod|chown|touch|pip|pip3|python|python3|poetry|go|dotnet|mvn|gradle|gh|source|sudo|nvm|code|open|grep|find|sed|awk|tar|unzip|zip|make|cmake|which|whoami|pwd|ps|kill|top|systemctl|service|journalctl|netstat|ping|nslookup|dig|openssl|gpg|tree|head|tail|less|wc|sort|uniq|xargs|tee|history|alias|ln|du|df|vercel|netlify|firebase|heroku|aws|gcloud|az|terraform|ng|vue|tsc|eslint|prettier|jest|vitest|webpack|vite|bundle|gem|rails|composer|php|flutter|xcode-select|nohup|crontab|env|set|setx|Get-\\w+|Set-\\w+|New-\\w+";

// Real HTML and SVG element names, or a custom element (has a dash), so that
// placeholders such as `<type>` or `<description>` do not look like markup.
const HTML_TAG = "(?:html|head|body|div|span|p|a|ul|ol|li|dl|dt|dd|h[1-6]|section|article|aside|header|footer|nav|main|form|fieldset|legend|input|button|img|picture|source|video|audio|track|canvas|template|slot|script|style|link|meta|title|base|table|caption|thead|tbody|tfoot|tr|td|th|label|select|option|optgroup|textarea|output|progress|meter|svg|path|circle|rect|line|polyline|polygon|g|defs|use|symbol|br|hr|b|i|u|s|small|strong|em|mark|abbr|cite|q|code|kbd|samp|pre|blockquote|figure|figcaption|dialog|details|summary|iframe|object|embed|noscript|time|address|sup|sub|[a-z][\\w]*-[\\w-]+)";
const STARTS_AS_MARKUP = new RegExp(`^<(?:!doctype|!--|\\?xml|${HTML_TAG})[\\s>/]`, "i");

/** Code with its string literals emptied, so HTML inside JS strings is not
 * mistaken for markup. */
const stripStrings = (src) => src.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/g, '""');

const DETECTORS = {
  markup: [
    [new RegExp(`^\\s*<(?:!doctype|!--|\\?xml|${HTML_TAG})\\b[^>]*>`, "i"), 6],
    [new RegExp(`</${HTML_TAG}>`, "gi"), 2],
    [new RegExp(`^\\s*<${HTML_TAG}(?:\\s+[\\w:@.-]+(?:\\s*=\\s*(?:"[^"]*"|'[^']*'))?)*\\s*/?>\\s*$`, "gim"), 1],
    [/^\s*(?:const|let|var|function|import|export|class)\b/gm, -4],
    [/\b(?:fn|def)\s+\w+\(/g, -4],
    [/^\s*\/\/|=>|^\s*[\w$]+(?:\.[\w$]+)+\s*=[^=]/gm, -3],
    [/^\s*(?:[-*+] +|\d+\. )\S|\*\*\w/gm, -3], // Markdown prose
  ],
  css: [
    [/^[ \t]*(?:[@.#:*\[]|[a-z][\w-]*)[^{};=\n]*\{\s*$/gim, 2],
    [/[.#][\w-]+\s*\{\s*[\w-]+\s*:[^;{}\n]+;/g, 3], // .a{margin:0;}
    [/^[ \t]*[.#][\w-]+(?:\s*[,>+~]\s*[.#]?[\w-]+|\s+[.#]?[\w-]+|[.#:][\w-]+)*\s*\{\s*(?:\/\*[^*]*\*\/\s*)?\}\s*$/gm, 2], // .a { }
    [/^[ \t]*-{0,2}[a-z][\w-]*\s*:\s*[^;{}\n=]+;\s*(?:\/\*.*\*\/)?\s*$/gim, 1.5],
    [/@media|@keyframes|@import|@font-face|@supports|@layer|@container|@scope|@property|:root\b|:host\b|::slotted|::part|!important|::?(?:hover|focus|before|after|nth-child|root|not|has|is|where)\b/g, 3],
    [/\b(?:for|while|switch|catch)\s*\(/g, -4],
    // `fetch(url, {` and `headers: {` open JS objects, not CSS rules.
    [/,\s*\{\s*$|^\s*['"]?[\w$-]+['"]?\s*:\s*\{\s*$|['"][^'"\n]*['"]\s*,\s*\{/gm, -3],
    [/\b\d+(?:px|rem|em|vh|vw|vmin|ms|deg|fr)\b/g, 1],
    [/\bvar\(--[\w-]+\)/g, 3],
    [/\b(?:const|let|var|function|return|import|export|fn|def|if|else)\b|=>|===|\bconsole\.|\(\)\s*\{/g, -4],
    [/\b(?:class|struct|impl|match|enum|trait|try|loop|mod|interface)\s+\w/g, -3],
  ],
  javascript: [
    [/\b(?:const|let|var)\s+[\w${[]/g, 2],
    [/\bfunction\b\*?\s*[\w$]*\s*\(/g, 2],
    [/=>/g, 2],
    [/\bconsole\.\w+\(/g, 3],
    [/\b(?:document|window|navigator|localStorage|customElements)\.\w+/g, 3],
    [/^\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?['"][^'"]+['"]/gm, 3],
    [/^\s*export\s+(?:default|const|let|function|class|async|\{)/gm, 3],
    [/\b(?:async|await)\b/g, 1],
    [/\bnew\s+[A-Z][\w$]*\(/g, 1],
    [/\bthis\.\w+/g, 1],
    [/===|!==|\?\?|\?\./g, 2],
    [/\b(?:addEventListener|removeEventListener|dispatchEvent|querySelector(?:All)?|getElementById|fetch|setTimeout|setInterval|JSON\.(?:parse|stringify)|Promise\.\w+|require)\(/g, 3],
    [/\.(?:setAttribute|getAttribute|classList|textContent|innerHTML|appendChild|removeChild|dataset|style)\b/g, 2],
    [/^\s*[\w$]+(?:\.[\w$]+)+\s*=[^=\n]*;\s*(?:\/\/[^\n]*)?$/gm, 2.5], // obj.prop = value;
    [/^\s*[\w$'")\]]+(?:\.[\w$]+)*\.[\w$]+\([^\n]*\);\s*(?:\/\/[^\n]*)?$/gm, 1.5], // obj.method(…);
    [/\$\(\s*['"`]/g, 3], // jQuery
    [/^\s*\}\)\s*;?\s*$/gm, 2], // }); closing a call with an object or callback
    [/^\s*\/\/ /gm, 0.5],
    [/\bmodule\.exports\b|\bprototype\b/g, 3],
    [/\bclass\s+[\w$]+(?:\s+extends\s+[\w$.]+)?\s*\{/g, 3],
    [/\bconstructor\s*\(|\bsuper\(/g, 2],
    [/\);\s*$/gm, 0.5],
    [/\bundefined\b|\bnull\b/g, 0.5],
    [/\b(?:fn|let\s+mut|impl|pub\s+fn|def|elif|func)\b|::\w+|println!|^\s*#include/gm, -3],
  ],
  typescript: [
    [/\binterface\s+\w+(?:<[^>]*>)?\s*(?:extends\s+[\w<>, ]+)?\{/g, 4],
    [/\btype\s+\w+(?:<[^>]*>)?\s*=/g, 3],
    [/[\w)\]]\??:\s*(?:string|number|boolean|void|any|unknown|never|Promise<|Record<|Array<)\b/g, 3],
    [/\b(?:private|public|protected|readonly)\s+\w+\s*:/g, 3],
    [/\bas\s+(?:string|number|const|unknown|any)\b/g, 2],
    [/\b(?:fn|let\s+mut|impl|def)\b/g, -4],
  ],
  rust: [
    [/\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/g, 3],
    [/\blet\s+(?:mut\s+)?[\w(]/g, 1],
    [/\blet\s+mut\b/g, 3],
    [/\bimpl\b(?:<[^>]*>)?\s+[\w:<>]+/g, 3],
    [/\bpub\s+(?:\([\w ]+\)\s+)?(?:fn|struct|enum|mod|trait|use|const|type)\b/g, 3],
    [/^\s*use\s+[\w:]+(?:::\{[^}]*\})?\s*;/gm, 3],
    [/\b\w+::\w+/g, 1],
    [/\b(?:println|print|eprintln|format|vec|panic|assert|assert_eq|write|writeln|matches)!\s*[([]/g, 4],
    [/->\s*[\w&(<]/g, 1],
    [/&(?:mut\s+|'\w+\s+)?(?:self|str)\b/g, 3],
    [/#\[(?:derive|cfg|test|tokio|wasm_bindgen)/g, 4],
    [/\b(?:Some|None|Ok|Err)\b/g, 1],
    [/\.unwrap\(\)|\.clone\(\)|\.iter\(\)|::new\(/g, 2],
    [/\b(?:const|var)\s+\w+\s*=|=>\s*\{|===|function\b|console\./g, -3],
  ],
  python: [
    [/^\s*def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*$/gm, 4],
    [/^\s*from\s+[\w.]+\s+import\s+/gm, 4],
    [/^\s*import\s+[\w.]+(?:\s+as\s+\w+)?\s*$/gm, 2],
    [/^\s*class\s+\w+(?:\([^)]*\))?:\s*$/gm, 4],
    [/^\s*(?:if|elif|else|for|while|with|try|except|finally)\b[^{;\n]*:\s*$/gm, 2],
    [/\bself\.\w+/g, 1],
    [/\bprint\(/g, 1],
    [/\b(?:True|False|None)\b/g, 1],
    [/^\s*@\w+/gm, 1],
    [/;\s*$|\{\s*$|\b(?:const|let|var|function|fn)\b|=>/gm, -3],
  ],
  go: [
    [/^\s*package\s+\w+\s*$/gm, 5],
    [/\bfunc\s+(?:\([^)]*\)\s*)?\w+\s*\(/g, 4],
    [/:=/g, 2],
    [/\bfmt\.\w+\(/g, 4],
    [/\b(?:fn|let|const|function|def)\b/g, -3],
  ],
  clike: [
    [/^\s*#include\s*[<"]/gm, 6],
    [/\bpublic\s+(?:static\s+)?(?:void|class|int|String)\b/g, 4],
    [/\bSystem\.out\.print/g, 5],
    [/\bint\s+main\s*\(/g, 5],
    [/\bstd::(?:cout|cin|string|vector)\b/g, 5],
    [/\b(?:fn|let|const|function|def)\b|=>/g, -3],
  ],
  sql: [
    [/\bselect\b[\s\S]+?\bfrom\b/gi, 4],
    [/\b(?:create|alter|drop)\s+(?:table|index|view|database|schema)\b/gi, 5],
    [/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b/gi, 5],
    [/\b(?:where|join|group\s+by|order\s+by|primary\s+key)\b/gi, 1],
    [/\b(?:const|let|function|def|fn)\b|=>|[{}]\s*$/gm, -4],
  ],
  json: [],
  yaml: [
    [/^[ \t]*(?:- )?[\w.-]+:(?:[ \t]+[^\s{;][^;]*)?[ \t]*$/gm, 1],
    [/^[ \t]*- [\w"'./-]/gm, 0.5],
    [/^(?:name|on|jobs|steps|runs-on|uses|with|env|services|version|image|ports|volumes|build|deploy|apiVersion|kind|metadata|spec):/gm, 2],
    [/[;{}()]|=>|\b(?:const|let|function|def|fn|return)\b/g, -2],
  ],
  toml: [
    [/^\[\[?[\w.-]+\]\]?\s*$/gm, 3],
    [/^[\w.-]+\s*=\s*(?:"|'|\d|\[|\{|true|false)/gm, 1.5],
    [/[;(]|=>|\b(?:const|let|function|def|fn)\b/g, -3],
  ],
  bash: [
    [new RegExp(`^[ \\t]*(?:[\\w@~:/.-]*\\$ |> )?(?:sudo\\s+)?(?:${SHELL_COMMANDS})(?=\\s|$)`, "gm"), 3],
    [/^[ \t]*[\w@~:/.-]*\$ \S/gm, 3],
    [/^[ \t]*#(?!include)[^\n]*$/gm, 0.25],
    [/(?:^|\s)--?[a-z][\w-]*/gm, 0.5],
    [/\s(?:&&|\|\|)\s|\s\|\s|\s>>?\s/g, 1],
    [/^[ \t]*(?:if \[|for \w+ in |while |fi$|done$|esac$)/gm, 3],
    [/\$\{?\w+\}?/g, 0.5],
    [/\b(?:const|let|function|def|fn)\b|=>|;\s*$|\{\s*$|^\s*\}\s*$|\.\w+\(/gm, -3],
  ],
};

function score(code, rules) {
  let total = 0;
  for (const [re, weight] of rules) {
    if (re.global) {
      re.lastIndex = 0;
      let n = 0;
      while (re.exec(code) && n < 4) n += 1;
      total += n * weight;
    } else if (re.test(code)) {
      total += weight;
    }
  }
  return total;
}

export function detectLanguage(code) {
  const src = code.trim();
  if (!src) return null;
  // Merge-conflict markers around prose are not any language.
  if (/^(?:<{7}|>{7}) |^={7}$/m.test(src)) return null;
  // JSON, also with // comment lines (as in config files).
  const uncommented = /^[[{/]/.test(src) ? src.slice(0, 20000).replace(/^[ \t]*\/\/[^\n]*\n?/gm, "").trim() : "";
  if (/^[[{]/.test(uncommented) && /[\]}]$/.test(uncommented)) {
    try {
      JSON.parse(uncommented);
      return "json";
    } catch {
      // not JSON; keep looking
    }
  }
  // A block that opens and closes with tags is markup, even with scripts inside.
  if (STARTS_AS_MARKUP.test(src) && />$/.test(src)) return "markup";
  return detectByScore(src.slice(0, 4000));
}

function detectByScore(src) {
  const lines = src.split("\n").filter((l) => l.trim()).length;
  const withoutStrings = stripStrings(src);
  let best = null;
  let bestScore = 0;
  let second = 0;
  for (const [lang, rules] of Object.entries(DETECTORS)) {
    const s = score(lang === "markup" ? withoutStrings : src, rules);
    if (s > bestScore) {
      second = bestScore;
      bestScore = s;
      best = lang;
    } else if (s > second) {
      second = s;
    }
  }
  // TypeScript only wins on top of JavaScript evidence.
  if (best === "typescript" && score(src, DETECTORS.javascript) < 2) return null;
  if (best === "javascript" && score(src, DETECTORS.typescript) >= 3) best = "typescript";
  // YAML and TOML are easy to imagine in any key-value text; demand more.
  const needed = best === "yaml" ? Math.max(3, lines * 0.6) : 3;
  if (!best || bestScore < needed || bestScore - second < 1) return null;
  return best;
}
