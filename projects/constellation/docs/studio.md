# The Studio

The Studio turns a GitHub account's public projects into a star map you can
change and take with you. It has three parts: **Home**, where you choose an
account; the **Studio** itself, where the map fills the screen and one panel
holds the settings; and **Get it**, where the map leaves the Studio.

Open it at <https://mnichols08.github.io/constellation/>, or run it yourself
with `npm run preview` (see the [main README](../README.md#run-locally)).

## Home

1. Type a GitHub username (a person or an organization) in the field.
2. Press **Show my sky**.

While your projects load you see "Finding your projects…" and a **Cancel**
button. If the account can't be found, has no public projects, or GitHub has
paused requests, the message appears under the field and nothing else changes.

Other choices on Home:

- **Try an example** opens a built-in example sky. It works offline and makes
  no GitHub requests. You can't save it or add it to a profile.
- **Your saved designs (n)** appears when this browser has saved designs.
- **Sign in** (top right) appears when this copy of Constellation has sign-in
  set up. See [Sign in](#sign-in).
- **How it works**, at the bottom, opens a one-page guide with a live example
  sky you can switch between layouts and themes. It explains the three steps,
  how to read the map, and what signing in does with your data. It draws the
  example offline, without asking GitHub for anything.
- **Star on GitHub**, also at the bottom, opens the project's repository in a
  new tab so you can star it without losing your place. The How it works page
  offers it too.

Links to the Studio show a preview image in chat apps and social sites. To
rebuild it after changing the default look, run
`node scripts/build-og-image.mjs`.

Home remembers the last username you opened in this browser.

### Coming back

Your current design is saved as a draft in this browser as you work. When you
open the same account again you see "Welcome back. We restored your last
design." with a **Start fresh** button. Reloading the page reopens the same
account and draft.

A share link carries its own design, so opening one never touches your draft.

## The map

The map takes most of the screen: at least 55% of a desktop window and at
least 35% of a phone screen. Its title, for example "The sky of @you · 16
projects", sits in the top-left corner. On a phone the map and the tabs stay
put while the settings below them scroll.

- **Click or tap a star** to see its card. Tap empty sky to close it.
- **Drag a star** to move it. Moving a star is a change like any other, so
  Undo puts it back. Stars can't be moved while they are moving themselves:
  when **Motion** is **Lively** (stars drift), or when rings spin in the
  **Rings** layout (stars ride the rings).

New skies move gently: stars twinkle and the orbit rings slowly turn. Choose
**Motion** in the **Details** tab: **Still**, **Gentle** or **Lively** (rings
turn faster and stars drift). Fine-tune has each part separately (**Twinkling
stars**, **Spinning rings**, **Floating stars**). Motion also plays in the SVG on
your README. Anyone whose device asks for reduced motion sees a still map.

With the keyboard, the map is a single Tab stop:

- **Tab** reaches the map, landing on the selected star (or the first one).
  Tab again goes on to the settings.
- **Arrow keys** move between stars in that direction. **Home** and **End**
  jump to the first and last star.
- **Enter** or **Space** opens the star's card.
- To move a star with the keyboard, press **Move it** in its card, use the
  arrow keys, then press **Enter**. **Escape** stops moving. A whole keyboard
  move is one Undo step.

If a change can't be drawn, for example because your filters leave no
projects, the map says why and offers **Undo the last change**. The previous
map stays underneath, dimmed.

### The star card

The card shows the project's name, description and facts from GitHub
(language, stars, the year it started, when it was last updated, and whether
it is a fork or archived). It has three buttons:

- **Feature it** makes the project stand out. Press it again to undo.
- **Hide it** takes the project off the map. A message offers **Undo**.
- **Open on GitHub** opens the project page (not shown for the example sky).

Below that, the card explains the star in plain sentences:

| Heading | What it tells you |
| --- | --- |
| **Why it’s here** | Whether you picked it, every project fits, or it is one of your most-starred, most recent, or first A–Z projects |
| **Featured** | Shown only when you featured it |
| **Where it sits** | What position means in your current layout, for example "It sits with your other TypeScript projects" in Galaxy |
| **Its size** | What size shows, and this project's value when it comes from GitHub |
| **Its colour** | What colour shows, for example its main language |

Each sentence says where it comes from: **From GitHub**, **Worked out by
Constellation**, or **Your choice**. Position and size describe your settings
and public GitHub data. They are not a rating of the project or of you.

Press Escape or the close button to close the card. Focus goes back to the star.

## The panel: four tabs

The panel beside the map (below it on a phone) has four tabs. Use the mouse, or
focus a tab and use the Left and Right arrow keys.

| Tab | What you change |
| --- | --- |
| **Look** | **Theme** (picture cards drawn from your own projects), **Background** (Plain, Stars, Deep space, Milky Way), **Star shape**, **Glow** |
| **Layout** | **Pick a layout**: Galaxy, Rings, Solar system, Orbits, Web, Scatter, Skills, Eras, Through time. Under **Connections**: **Connect projects that share** (Languages, Topics, Both), **Lines** (Strongest, All), **Orbit shape** (Round, the default for new designs, or Wide to fill a README banner), **Orbit rings** |
| **Projects** | The list of your projects. Tick a box to put a project on the map, press its star to feature it, or search the list. **Choose automatically** returns to automatic picking. Under **Choosing projects**: **Most projects to show**, **When there are too many, keep** (Most starred, Most recent, A to Z), **Include forks**, **Include archived projects** |
| **Details** | **Star size shows**, **Star colour shows**, **Project names**, **Name size**, **Motion** (Still, Gentle, Lively), **Show a key**, **Title** |

The theme and layout cards are small live previews of your own map with that
choice applied. A layout that can't work with your projects is marked and says
why. For example, **Through time** needs projects from at least three different
years.

Changing a setting redraws the map straight away. It never asks GitHub for
more data.

## Undo and Redo

**Undo** and **Redo** are the arrow buttons in the top bar. Their tooltips name
the change they will undo or redo.

| Shortcut | Action |
| --- | --- |
| Ctrl+Z (Command+Z on a Mac) | Undo |
| Ctrl+Shift+Z or Ctrl+Y | Redo |

The shortcuts don't fire while you are typing in a field. Every change to the
design can be undone: settings, moved stars, featured and hidden projects,
**Shuffle**, opening a settings file or saved design, and starting over.
Dragging a slider counts as one step. The Studio keeps the last 100 steps until
you load another account or reload the page.

## Shuffle

**Shuffle** in the top bar tries a new look and layout: theme, shapes, glow,
connections, and one of the layouts that show every project as its own named
star (Galaxy, Rings, Solar system, Orbits, Web and Scatter). It never changes
which projects are on the map, what each star stands for, your featured
projects or your custom CSS. Pressing it again updates the same message
("Shuffled 3 times"). **Undo** brings your design back, one shuffle at a time.

## Save and saved designs

**Save** keeps the current design in this browser under a name.

1. Press **Save**. A name like "My sky – October 22" is suggested.
2. Change the name if you like, then press **Save**. If the name is already
   used for this account, the button reads **Replace**.

You can keep up to 30 saved designs per account, with names up to 80
characters. **Save** isn't available for the example sky.

Open **Your saved designs** from Home. Designs are grouped by account. **Open**
loads one; opening a design for a different account loads that account first.
To delete a design, press its delete button twice.

Saved designs live only in this browser. To keep a copy elsewhere, or to move
a design to another computer, use **Get it** → **Save the settings file**.

## Fine-tune

**Fine-tune every setting**, at the bottom of the panel, opens every option in
one searchable list. The tabs show only the most useful settings; Fine-tune has
the rest, such as colours, line thickness, filters, motion, image shape and
the settings that need sign-in.

- **Search settings** filters the list as you type (try "glow", "forks" or
  "title").
- Settings are grouped as **Look**, **Layout**, **Projects**, **Details**,
  **Size and format** and **Data**. **Data** settings need sign-in; until you
  sign in they say "Sign in with GitHub to use this."
- **Edit all settings as JSON** shows the whole design as text. Edit it or
  paste a settings file, then press **Apply**. Invalid JSON, unknown versions
  and files over 250 KB are refused with a message, and your design stays as
  it was. **Reset** puts back the current settings.
- **Start over with the default design** resets everything. Press it twice to
  confirm. Undo still brings your design back.

Press **Done** to close.

## Get it

**Get it** is the one main button in the top bar. It asks "Where should your
map go?" and offers five choices:

| Choice | What you get |
| --- | --- |
| **Add it to your GitHub profile** | A daily GitHub Action that redraws your map every day (see below) |
| **Download an image** | **Download SVG** (sharp at any size, best for READMEs and websites) or **Download PNG** (for slides, documents and social posts) |
| **Put it on a website** | **Download interactive page**: one HTML file where visitors can zoom, search and click stars. Also **Download SVG** with ready-made image code, and **Download portfolio package** |
| **Share a link** | **Copy link** to a link anyone can open to see this design, drawn from the account's public projects. On phones, **Share…** opens your device's share sheet |
| **Save the settings file** | **Download settings file** saves the design as JSON. **Open a settings file** loads one and replaces the current design (Undo brings it back) |

Every download confirms itself in the dialog, for example "Saved
constellation-you.svg to your downloads." If your current settings can't be
drawn, Get it won't export an out-of-date map: it says so and offers **Undo the
last change**.

### Add it to your GitHub profile

Four steps on GitHub. You only do this once.

1. **Add this file to your profile repository.** The **Repository** field
   suggests `you/you` (or `org/.github` for an organization). If you type just
   a name, it offers a one-click fix such as "Did you mean you/you?". Press
   **Create the file on GitHub** to open GitHub with the workflow filled in,
   then press GitHub's green **Commit changes** button. Or **Copy the file** and
   add it yourself as `.github/workflows/constellation.yml`. **Show the file**
   lets you read it first.
2. **Run it once.** Press **Open the Actions page**, choose "Daily
   constellation", then "Run workflow". It takes about a minute. A green tick
   means your picture is ready; a red cross means something went wrong (see
   **What can go wrong?**).
3. **Paste this into your README.** Copy the snippet, then press **Edit your
   README on GitHub** and paste it anywhere, for example at the top. The
   snippet's last line credits the tool that made your picture; keep it if you
   like, or delete it.
4. **See it on your profile.** **Open your profile** to check the result.

Nothing is published until the workflow runs. After that it refreshes every
day. The workflow uses GitHub's own token; you don't create one. See
[Publishing](publishing.md) for what the workflow does and how it fails safely.

A link can't hold a very large design. If yours is too big, **Share a link**
says so and offers **Save the settings file instead**.

## Sign in

You can map any public account without signing in. Signing in lets
Constellation read your pinned projects, every language in each project, and
your recent activity. That unlocks the **Data** settings in Fine-tune: **Start
from** (All public projects or Pinned projects), **Highlight recent activity**,
**Recent means the last** and **Show when you usually code**.

- On the hosted Studio, press **Sign in** on Home, then **Continue with
  GitHub**. The site owner must set this up first; see
  [GitHub sign-in deployment](github-oauth.md).
- On a local preview, **Use a personal access token (local only)** lets you
  paste a read-only token. If the preview server already uses `GH_TOKEN` from
  `.env`, Home shows **Signed in locally** instead.
- When signed in, the Home button reads **Signed in as @you**. It opens a
  dialog with **Sign out** and **Show my sky**.

## Privacy: what stays where

**Stays in this browser**

- Your draft and saved designs (`localStorage`, keyed by account).
- The last username you opened and whether you have seen the map hint.
- Cached public GitHub responses for this tab session (`sessionStorage`, up to
  15 minutes), so reloading soon after doesn't ask GitHub again.

**Never stored**

- Your sign-in. The token lives only in this tab's memory and is gone when you
  close or reload it. It is never written to settings files, share links,
  saved designs or images.

**Goes to GitHub**

- Opening a public account without signing in makes two requests from your
  browser: the account's profile and one page of up to 100 public projects.
- When you are signed in, opening an account also reads each project's
  language details ("Reading project details…"). Pinned projects and recent
  activity are read only for the settings that use them.
- Changing the design, shuffling, undoing, saving and every **Get it** choice
  make no GitHub requests. **Create the file on GitHub** and **Open the Actions
  page** only open GitHub pages for you to act on.

**Goes to whoever you share with**

- A share link holds the account name and your settings. Anyone who opens it
  sees the map drawn from that account's current public projects.
- A settings file holds your settings only, never data or credentials.

See the [security model](security-model.md) and
[GitHub request caching](github-data-cache.md) for limits and details.

## Accessibility

Every control has a visible label and works with the keyboard. The Studio
respects your reduced-motion setting, reflows down to 320 px wide, and is
checked with axe on every screen. See [Accessibility](accessibility.md).

## What the map means

The [Reading a constellation](semantic-studio.md#reading-a-constellation)
section explains what rings, colour, size and glow can mean, and which parts
are only decoration.
