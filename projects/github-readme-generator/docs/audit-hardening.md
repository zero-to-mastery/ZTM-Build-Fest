# Repository audit hardening

Open **GitHub → README audit**, load repository pages, select repositories and choose **Audit selected**. The normal scan analyzes text locally, including possible TODO/project-name placeholders and combined Create React App, Vite/React and Next.js starter phrases. Code examples, inline code and HTML comments are excluded. These English heuristics are advisory: a TODO can be intentional, and retained starter text does not prove an untouched template.

Each assessed README offers **Check history and links**. This explicit action contacts GitHub and up to 20 linked hosts, one URL at a time. It sends URL requests, never the README source. Relative links/images use the repository branch and README path. The existing health checker handles safe URLs, caching, HEAD/GET restrictions and image targets. Only observed HTTP 404/410 produces an unavailable-resource finding. CORS, offline, timeout and access restrictions remain unverifiable, not broken. Findings are escaped text, not embedded remote HTML. Remote checks are a snapshot, not a guarantee; anchors are not requested. Repeating a check within five minutes reuses cached observations.

## Observed history, not a stale-doc verdict

The [GitHub commits endpoint](https://docs.github.com/en/rest/commits/commits#list-commits) is queried for the root README path on its default branch. If the observed modification is at least 90 days old, a second request samples at most 30 commits from the past 30 days. A review suggestion requires at least 10 distinct later commits spanning at least seven days. Dates in the future, missing history, one recent push and a burst on one day cannot trigger it.

The message is: “README may need review — repository has significant activity after the last observed README update.” This explains the observed dates and count and explicitly says activity does not prove outdated documentation. Commit dates can be rewritten and path history can miss renames; sparse/incomplete observations mean no claim. It does not infer that changes require documentation. Only a human can decide that.

## Scale and recovery

- Load up to ten pages of 100 public owned repositories. Fork/archive filters and explicit selection still apply.
- README fetching uses three workers; source caching stays below 20 MB and 1,000 entries. Results retain evidence and metadata rather than another copy of every README. The table/queue render 25 rows per page and analysis uses the existing Worker.
- HTTP 502/503/504 and network errors receive one retry after 300 ms. Cancellation interrupts that delay. Other failures can be retried explicitly. Rate limits are never automatically hammered: scheduling pauses and the client honors exposed Retry-After/reset headers, with a minimum 60-second cooldown. Successful assessments stay visible.
- The final message distinguishes attempted failures from repositories not yet checked. Repeating Audit selected retains successes and retries incomplete work; Fetch fresh rechecks completed assessments. An unauthenticated real account may exhaust GitHub's quota well before 1,000 README requests; pagination capacity is not a quota bypass.
- History records are capped at 1,000 and expire after five minutes. Health uses its existing 500-entry/five-minute cache. Deeper checks are per repository, not automatically multiplied over the account. Rate limits stop further link checks.

Placeholder, history and unavailable-resource findings can add an attention-queue candidate even when its type-specific sections are present. Existing revision-bound intentionally-minimal and ignore preferences still apply. None of these findings changes source, exported Markdown, classification thresholds, or developer rankings.

Synthetic tests exercise the actual fetch/analyze pipeline with 100, 500 and 1,000 repositories. They assert completion, concurrency and retained-source bounds rather than tight timing limits or live-service availability. Real network duration and quotas vary.
