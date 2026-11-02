# Mnix portfolio theme

Saved before restoring Constellation's original navy, blue, and gold appearance.

- `palette.css`: reusable dark/light color variables for your portfolio. Load after your base CSS and use `var(--page)`, `var(--text)`, `var(--accent)`, etc.
- `preview.css` and `studio-layout.css`: exact snapshots of the complete styles of the pre-5.0 Studio at the time of preservation. They include layout and component rules for that old interface (`src/preview.mjs`, since removed), not the current Studio in `src/app/`. Load them in that order only as a reference for the original appearance.
- `constellation.json`: a settings file that renders the Mnix constellation with a transparent background for your portfolio. In the Studio, open your own account, press **Get it** → **Save the settings file** → **Open a settings file**, and choose this file. Then use **Get it** → **Download an image** or **Put it on a website**. With the CLI, pass `--config themes/mnix-portfolio/constellation.json`.

The built-in theme remains available as **Mnix** under **Theme** in the Studio's **Look** tab. Existing Mnix configs and shares retain their palette.

Dark: charcoal `#111111`, olive borders `#555a38`, yellow accent/stars `#e3de13`. Light: ivory `#fafaf3`, olive accent `#595600`, gold stars `#8b8500`.
