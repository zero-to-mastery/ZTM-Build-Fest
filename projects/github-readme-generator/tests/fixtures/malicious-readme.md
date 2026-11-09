# Security fixture

<script>window.compromised = true</script>
<iframe src="https://example.com"></iframe>
<object data="data:text/html,<script>alert(1)</script>"></object>
<embed src="https://example.com">
<form action="https://example.com"><input autofocus><button>Send</button></form>
<img src="./missing.png" onerror="window.compromised=true" class="modal toast">
<svg><script>window.compromised=true</script><a href="javascript:alert(1)">Click</a></svg>
<a href="java&#x09;script:alert(1)" onclick="alert(1)">Bad link</a>
<img src="data:image/svg+xml,<svg onload='alert(1)'></svg>">
<picture><source srcset="javascript:alert(1) 1x, data:text/html,attack 2x"><img src="javascript:alert(1)"></picture>

[Unsafe](javascript:alert%281%29)
[Unsafe data](data:text/html,test)

- [x] Legitimate disabled task checkbox

<details><summary>Legitimate details</summary>Useful text</details>

<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">
