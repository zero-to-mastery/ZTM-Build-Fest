# Application pages

This browser application uses in-memory screen state rather than server routes. Refreshing returns to welcome. All figures and explanations are HTML; illustrations are static assets.

| Screen | Purpose | Next action |
| --- | --- | --- |
| Welcome | Explain the business-analytics lesson in the hero; list learning outcomes and choose Guided/Explore in a separate setup section | Choose how to learn, then Start lesson / Explore shop |
| A normal day | Show the revenue calculation once; reason about the information needed to compare profit | Choose a response, then Continue |
| Costs | Derive cup costs and operating costs; compare two ways of improving profit | Choose a response, then Continue |
| Prediction | Predict the effect of the worked promotion before the reveal | Choose a response, then Continue |
| Promotion | See the discounted price, assumed turnout and additional cup costs | Back / Continue |
| Comparison | Show normal/promotion daily revenue, total costs and profit side by side; explain the difference | Back / Continue |
| Experiment | Compact controls/results overlay the shop scene on wide screens; edit cups per day, selling price before discount, percentage and staffing | Run the day / See summary |
| Results | Show the selected campaign inputs, normal-day reference, and open daily/monthly tables side by side on wide screens | Try again / Back to welcome |

## Model and state

- Guided uses 100 cups at $5. The promotion assumes 140 cups at a 10% discount.
- Explore setup freezes a custom normal-day baseline. Its price supplies the initial campaign price; users can then edit the campaign price and discount without changing the normal-day reference.
- Editing experiment inputs makes the completed result stale. Run again before viewing results.
- Price before discount applies to the promotion only. The normal-day reference stays frozen until the user changes setup. Each completed snapshot records its price, percent, cups and staffing.
- Editable campaign bounds: 80–180 cups in tens, price $3–$10 in $0.50 steps, discount 0–100 in whole percentages, extra staffing $0/$50/$100/$150. Discounted unit price is rounded to cents once before multiplying cups.
- Restore promotion resets all campaign inputs (140 cups, normal-day price, 10% discount, no extra staffing), without replacing the baseline. Starting a changed Explore setup creates a new reference and resets dependent inputs/results.
- Guided and Explore keep separate experiment drafts during the session. Restart lesson restores Guided presets.
- Monthly estimates multiply every included revenue and cost line by 26 identical trading days.
- The summary snapshots cups sold per day, selling price before discount, discount percent and actual price charged, using the completed run rather than a draft. Daily/monthly tables stack on narrow screens. The experiment also becomes image-then-controls on narrow screens so fields and results remain readable without covering the characters.
- Answers are session-only and persist across Back/Continue. A new/restarted lesson clears them. On question and prediction screens Continue is disabled until any answer is selected. Correctness never prevents continuation; explanatory feedback supports learning, without scores.
- The fluid lesson frame uses a compact header, Sales / Costs / Promotion / Your turn indicators, a larger static scene and one teaching region. Back/Continue sits immediately beneath the scene on wide screens, and follows the teaching region on narrow screens for a natural reading order. The order/preparation/payment strip is removed. Comparison figures serve deliberate cross-day recall. Stage indicators do not skip steps.

## Extension points

`src/model.js` owns the financial rules. Guided teaching uses the 10% example; the experiment exposes other whole-number percentages and a separate price before discount. Other promotion kinds still need their own tested accounting rules and explanations. Turnout remains an independent input, not demand inferred from discount size. The illustration does not drive the calculation.

## Accessibility

Use keyboard-operable mode/answer buttons, labeled native fields, native disabled Continue with a visible instruction, disclosures, focus and semantic tables. Screen headings receive focus after navigation; selecting an answer retains focus and announces feedback. Completed results are announced and focused without replaying the lesson. Choices have modest hover/focus and one-time entry emphasis; reduced motion removes movement. No looping pulse or audio. Image failures retain text/calculations. At narrow or zoomed widths content stacks and scrolls naturally; no instructional content is clipped to force a viewport fit.
