# Gate of Embers — a lesson

Canonical: <https://example.test/blog/video-lesson/>

A lesson about the café gate, with a [relative link](https://example.test/blog/reference/) and a [section link](https://example.test/blog/video-lesson/#chapters).

## Chapters

00:00 The gate opens
00:14 A warning & a `<script>` in the *dark*
1:02:03 Into the ruin — Ünter

> **Note:**
> Nested inside a callout:
>
> **src/\<main\> \& 'lib'.rs**
> 
> ```rust
> fn main() { println!("</code></pre><script>alert(1)</script>"); }
> ```
> 
> [Open in Rust Playground](https://play.rust-lang.org/?version=stable&mode=debug&edition=2021&code=fn+main%28%29+%7B+println%21%28%22%3C%2Fcode%3E%3C%2Fpre%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E%22%29%3B+%7D%0A).
> 
> [Run and edit this example on the canonical article](https://example.test/blog/video-lesson/).


An indented block after a titled runnable fence stays plain code:

    cargo run --release

**Question:** Which tag opens a **disclosure** without `<script>`?

1. `<dialog onclick="alert(1)">`
2. `<details>`
3. `<ob-quiz>`

**Answer:** 2. `<details>`

> **Explanation:** Native disclosure works without JavaScript — even in Zürich.


**Question:** Is the answer shown before the reader asks?

1. No
2. Yes

**Answer:** 1. No


**HTML**

```html
<button onclick="alert(1)">Hi</button>
```

**CSS**

```css
button { color: red; }
```

**JavaScript**

```js
document.body.append('</script><img src=x onerror=alert(1)>');
```

[Try it on the canonical article](https://example.test/blog/video-lesson/).


```python
print("runs on the canonical page")
```

[Run and edit this example on the canonical article](https://example.test/blog/video-lesson/).


- [A pen about gates <3](https://codepen.io/u/pen/abc)

  A loose list item keeps its embed link.

[See the Pen on CodePen](https://codepen.io/team/acme/pen/xyz)

![The café gate](https://example.test/blog/images/caf%C3%A9-gate.png)
## Video details

- Episode: Season 1, episode 3
- Production credits: Writing by Mira \& \<Lantern\> Team
- Video: [Gate of Embers — a lesson](https://youtu.be/dQw4w9WgXcQ)

> **Portable fallback:** The source code and canonical run/edit link are preserved; eligible Rust examples also link to the external Playground. Review: Review the preserved source and keep the canonical link for editing or execution.

> **Portable fallback:** The question and answer are preserved; scoring, retry, and remembered attempts are unavailable. Review: Review the static question and answer; keep the canonical link when scoring or retries matter.

> **Portable fallback:** The question and answer are preserved; scoring, retry, and remembered attempts are unavailable. Review: Review the static question and answer; keep the canonical link when scoring or retries matter.

> **Portable fallback:** The HTML, CSS, and JavaScript sources are preserved; the live preview remains on the canonical article. Review: Review the preserved source and keep the canonical link for editing or execution.

> **Portable fallback:** The source code and canonical run/edit link are preserved; eligible Rust examples also link to the external Playground. Review: Review the preserved source and keep the canonical link for editing or execution.

[Join the discussion on the canonical article](https://example.test/blog/video-lesson/#ob-discussion)
