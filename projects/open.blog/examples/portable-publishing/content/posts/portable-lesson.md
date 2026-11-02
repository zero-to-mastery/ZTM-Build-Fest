---
title: A lesson that travels
date: 2026-10-24
profile: research
syndicationId: portable-lesson-example
doi: 10.5555/portable.lesson
license: https://creativecommons.org/licenses/by/4.0/
sourceUrl: https://source.example.org/portable-lesson
comments: open
tags: [rust, portability]
cover: /images/exercise.svg
coverAlt: Diagram of the exercise
privateNote: PRIVATE_FRONTMATTER_SENTINEL
---
## Abstract

One canonical lesson preserves its evidence, answers, and runnable source across platforms.
The [lesson section](#lesson) contains the exercises; the [reference](#references) describes
the supporting evidence.

## Lesson

> [!TIP]
> Keep the source and explanation together, even when the destination cannot run code.

```quiz
What does the Rust example print?
- [ ] 7
- [x] 42
> Multiplication produces the answer before it is printed.
```

```rust runnable title="main.rs"
fn main() {
    println!("{}", 6 * 7);
}
```

Expected output: **42**.

```python runnable
print(6 * 7)
```

```web runnable title="A static web fallback"
---html
<button id="answer">Reveal the answer</button>
<output id="result"></output>
---css
button { color: navy; }
---js
document.querySelector("#answer").onclick = () => {
  document.querySelector("#result").textContent = "42";
};
```

## Watch and review

[Watch the walkthrough](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

00:00 Introduction
00:15 Work through the example

![Diagram of the exercise](/images/exercise.svg)

<!-- PRIVATE_COMMENT_SENTINEL -->

## References

1. [Supporting study](https://doi.org/10.1000/portable.reference#results)
