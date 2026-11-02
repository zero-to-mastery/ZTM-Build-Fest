# Field journals and private-by-default tracks

Use the Field journal profile for hikes, paddles, field surveys, restoration days, and
other place-based notes. The post remains ordinary Markdown; the profile adds a compact
field summary, optional route and elevation drawings, and explicit location privacy.

For a complete working example, see
[`content/posts/2026-10-23-a-wet-morning-on-the-ridge.md`](../content/posts/2026-10-23-a-wet-morning-on-the-ridge.md).
It includes a cover image, narrative trail log, field observations, access and stewardship
notes, and privacy-safe route and elevation drawings.

## Start a field note

Select **Field journal** under **Settings → Content profile**, or author the fields directly:

```yaml
profile: field-journal
activity: Hike
location: Northern ridge
locationPrivacy: trimmed
distanceKm: 8.4
elevationGainM: 420
duration: 2 hr 15 min
conditions: Cool, windy, and muddy above the tree line
```

Use the Markdown body for observations, photos, accessibility notes, stewardship work, and
the story of the outing. Conditions are observations written by the author; OpenBlog does
not fetch or imply historical weather data.

## Import a GPX track

Open **Field Review** in Admin Studio (`Alt+5`), choose the privacy mode, and select a GPX
file. Analysis happens locally in the browser. OpenBlog calculates distance, positive
elevation gain, elapsed time when timestamps exist, a normalized route outline, and an
elevation profile. No map, weather, or tracking service is contacted.

| Mode | Published route data |
| --- | --- |
| **Hidden** | Statistics and elevation profile only; no route outline or source GPX. This is the default. |
| **Trimmed** | Removes the chosen distance from both endpoints, then saves only normalized drawing points. |
| **Approximate** | Saves normalized drawing points but no geographic coordinates or source GPX. |
| **Exact** | Privately stages the original GPX, then publishes it as a downloadable static asset only when the post saves successfully. |

Normalized points describe a shape in an SVG view box, not latitude and longitude. Hidden,
trimmed, and approximate imports never upload the source file. Exact mode requires a human
review because it can reveal a home, campsite, sensitive species, or fragile habitat.
Changing a saved Exact journal to another privacy mode removes its OpenBlog-managed public
track and moves the source file to `.openblog/trash/tracks/` for recovery. Deleting the
journal does the same. Abandoned private staging files can be discarded from the editor
and are pruned after 24 hours when another GPX is staged.

GPX calculations are deterministic summaries, not navigation or safety guidance. Check
measurements against the recording device when accuracy matters, and do not rely on the
published route for emergency or backcountry navigation.
