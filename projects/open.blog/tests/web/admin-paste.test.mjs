import assert from "node:assert/strict";
import test from "node:test";

import { PASTE_LIMITS, pasteNotice, pasteToMarkdown, safePastedUrl } from "../../web/admin/paste.js";

const md = (html, options) => pasteToMarkdown(html, options).markdown;

const WORD = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{font-family:"Calibri"}</style>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]--></head><body lang=EN-US style='tab-interval:.5in'>
<!--StartFragment--><h1 class=MsoTitle><span style='font-size:20.0pt'>Welcome <o:p></o:p></span></h1>
<p class=MsoNormal style='margin-bottom:0in'>We make <b style='mso-bidi-font-weight:normal'>fresh</b> bread and <i>pies</i>.<o:p></o:p></p>
<p class=MsoListParagraph style='text-indent:-.25in'><![if !supportLists]><span>&middot;&nbsp;</span><![endif]>Sourdough</p>
<p class=MsoListParagraph>Rye</p>
<p class=MsoNormal>Visit <a href="https://example.com/menu?a=1" target="_blank" style="color:blue">our menu</a>.</p><!--EndFragment--></body></html>`;

const DOCS = `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-1234-abcd"><h2 dir="ltr" style="line-height:1.38"><span style="font-size:16pt;font-weight:400">Opening hours</span></h2>
<p dir="ltr"><span style="font-weight:700">Open</span><span style="font-style:italic"> daily</span> except <a href="https://www.google.com/url?q=https://example.com/closed&amp;sa=D"><span style="color:#1155cc">holidays</span></a></p>
<ul style="margin-left:-36pt"><li dir="ltr"><p dir="ltr"><span>Monday to Friday</span></p></li><li dir="ltr"><p dir="ltr"><span>Saturday</span></p>
<ul><li><p>Mornings only</p></li></ul></li></ul>
<ol start="3"><li>Third</li><li>Fourth</li></ol></b>`;

const WEB = `<article class="post"><nav><a href="/">Home</a></nav><h3 id="x">Why bread?</h3>
<p>Because <strong>it is good</strong> &amp; cheap.<br>Second line</p><blockquote><p>Eat well.</p><p>Live well.</p></blockquote>
<p><img src="https://example.com/loaf.jpg" alt="A round loaf" width="400"><img src="https://tracker.example/p.gif" width="1" height="1" alt=""><img src="https://example.com/nodescription.jpg"></p>
<pre><code>let a = 1;\nlet b = "&lt;x&gt;";</code></pre>
<table><tr><td>Cell A</td><td>Cell B</td></tr></table><div hidden>secret</div><p style="display:none">gone</p></article>`;

test("a Word fragment keeps its heading, emphasis, list and link", () => {
  assert.equal(
    md(WORD),
    "# Welcome\n\nWe make **fresh** bread and _pies_.\n\n- Sourdough\n- Rye\n\nVisit [our menu](https://example.com/menu?a=1).",
  );
});

test("a Google Docs fragment keeps headings, bold, italic, links and lists, and ignores its wrapper", () => {
  const out = md(DOCS);
  assert.match(out, /^## Opening hours\n\n\*\*Open\*\* _daily_ except \[holidays\]\(https:\/\/www\.google\.com\/url\?q=https:\/\/example\.com\/closed&sa=D\)/);
  assert.ok(!out.includes("**Opening"), "a wrapper bold with normal weight is not bold");
  assert.match(out, /- Monday to Friday\n- Saturday\n- Mornings only/);
  assert.match(out, /3\. Third\n4\. Fourth$/);
});

test("a web page keeps meaning, drops hidden content, tracking pictures and undescribed pictures", () => {
  const result = pasteToMarkdown(WEB);
  assert.match(result.markdown, /### Why bread\?/);
  assert.match(result.markdown, /Because \*\*it is good\*\* & cheap\.\nSecond line/);
  assert.match(result.markdown, /> Eat well\. Live well\./);
  assert.match(result.markdown, /!\[A round loaf\]\(https:\/\/example\.com\/loaf\.jpg\)/);
  assert.match(result.markdown, /```\nlet a = 1;\nlet b = "&lt;x>";\n```|```\nlet a = 1;\nlet b = "<x>";\n```/);
  assert.match(result.markdown, /Cell A Cell B/);
  assert.ok(!/secret|gone|tracker/.test(result.markdown));
  assert.equal(result.keptImages, 1);
  assert.equal(result.droppedImages, 1, "only the undescribed real picture is flagged; the tracking pixel is quiet");
  assert.match(pasteNotice(result), /One picture was left out because it has no description/);
});

test("headings can be pinned to one level", () => {
  assert.equal(md("<h1>A</h1><h4>B</h4>", { headingLevel: 2 }), "## A\n\n## B");
});

test("headings can be kept below a page title", () => {
  assert.equal(md("<h1>A</h1><h3>B</h3>", { minHeading: 2 }), "## A\n\n### B");
});

const HOSTILE = [
  `<script>alert(1)</script><p>ok</p>`,
  `<p onclick="alert(1)" style="x:expression(alert(1))">hi</p>`,
  `<a href="javascript:alert(1)">click</a>`,
  `<a href="  JaVaScRiPt:alert(1)">click</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD4=">click</a>`,
  `<a href="//evil.example/x">click</a>`,
  `<img src="x" onerror="alert(1)" alt="boom">`,
  `<img src="data:image/png;base64,AAAA" alt="inline">`,
  `<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">`,
  `<svg><script>alert(1)</script></svg><math><mi xlink:href="javascript:alert(1)">x</mi></math>`,
  `<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`,
  `<p>&lt;img src=x onerror=alert(1)&gt;</p>`,
  `<p><!--<script>alert(1)</script>--></p>`,
  `<p>a<script>alert(1)</script>b</p>`,
  `<style>p{background:url(javascript:alert(1))}</style><p>x</p>`,
  `<form action="https://evil.example"><input name=q><button>go</button></form>`,
  `<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>`,
  `<p>&amp;lt;b&amp;gt;</p>`,
];

test("hostile clipboard HTML never produces markup in the Markdown", () => {
  for (const html of HOSTILE) {
    const out = md(html);
    assert.ok(!/<\/?[a-z!?]/i.test(out), `markup in output for ${html}: ${out}`);
    assert.ok(!/javascript:|data:text|onerror|onclick|expression\(/i.test(out.replace(/&lt;[^\n]*/g, "")), `${html}: ${out}`);
    assert.ok(!/\]\((?!https?:|mailto:|\/|#|\.)/i.test(out), `unsafe link target in ${html}: ${out}`);
  }
  assert.equal(md(`<p>ok</p><script>alert(1)</script>`), "ok");
  assert.equal(md(`<a href="javascript:alert(1)">click</a>`), "click");
  assert.equal(md(`<p>&lt;script&gt;x&lt;/script&gt;</p>`), "&lt;script>x&lt;/script>");
});

test("a link keeps only a safe scheme and an address that cannot end its own Markdown", () => {
  assert.equal(safePastedUrl("https://example.com/a b)"), "https://example.com/a%20b%29");
  assert.equal(safePastedUrl("javascript:alert(1)"), "");
  assert.equal(safePastedUrl("vbscript:x"), "");
  assert.equal(safePastedUrl("//evil.example"), "");
  assert.equal(safePastedUrl("/about/"), "/about/");
  assert.equal(safePastedUrl("/\\evil.example"), "");
  assert.equal(safePastedUrl("https://a.example\\b"), "");
  assert.equal(safePastedUrl("mailto:a@example.com"), "mailto:a@example.com");
  assert.equal(safePastedUrl("https://exa\nmple.com"), "");
});

test("Markdown characters in pasted words are escaped and block markers are defused", () => {
  assert.equal(md("<p>2 * 3 = [six] _x_</p>"), "2 \\* 3 = \\[six\\] \\_x\\_");
  assert.equal(md("<p># not a heading</p>"), "\\# not a heading");
  assert.equal(md("<p>- not a list</p>"), "\\- not a list");
  assert.equal(md("<p>1. not a list</p>"), "\\1. not a list");
  assert.equal(md("<p>&gt; not a quote</p>"), "\\> not a quote");
});

test("malformed, deep, empty and huge input is handled without throwing", () => {
  for (const html of ["", "   ", null, undefined, "<", "<<<>>>", "<p", "<a href='x", "</p></div>", "<b><i>x</b></i>", "<ul><li>a<li>b</ul>", "<!--", "<![CDATA[x]]>"]) {
    assert.doesNotThrow(() => pasteToMarkdown(html), String(html));
  }
  assert.equal(md("<ul><li>a<li>b</ul>"), "- a\n- b");
  assert.equal(md("<b><i>x</b></i>"), "**_x_**");
  const deep = "<div>".repeat(5000) + "deep words" + "</div>".repeat(5000);
  assert.match(md(deep), /deep words/);
  const huge = pasteToMarkdown("<p>x</p>".repeat(PASTE_LIMITS.html));
  assert.equal(huge.markdown, "");
  assert.equal(huge.tooLong, true);
  const many = pasteToMarkdown("<p>word</p>".repeat(5000));
  assert.equal(many.blocks.length, PASTE_LIMITS.blocks);
});

test("nested bold is written once and spaces stay outside the marks", () => {
  assert.equal(md("<p><b>a <b>b</b> </b>c</p>"), "**a b** c");
  assert.equal(md("<p>x<strong> bold </strong>y</p>"), "x **bold** y");
});

test("the notice speaks plainly and says how to paste plain text", () => {
  assert.equal(pasteNotice({ droppedImages: 0, formatted: false }), "");
  assert.match(pasteNotice({ droppedImages: 3, formatted: true }), /3 pictures were left out.*Ctrl\+Shift\+V/);
  assert.equal(pasteNotice({}, { plain: true }), "Pasted as plain text.");
});
