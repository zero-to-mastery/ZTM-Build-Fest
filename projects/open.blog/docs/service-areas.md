# Service areas

A service area is a town you serve. You list them once in `openblog.json`, under `serviceAreas`. A site without
the member builds exactly as it did before ([ADR 0314](adr/0314-service-areas-are-a-versioned-list-of-towns-in-openblog-json-checked-for-duplicates-with-regions-formatted-from-a-bundled-list-and-absent-means-nothing-changes.md)).

```json
{
  "serviceAreas": {
    "version": 1,
    "areas": [
      { "town": "Bend", "region": "OR", "note": "within 30 miles" },
      { "town": "Sisters", "region": "Oregon" }
    ]
  }
}
```

- **`town`** and **`region`** are required and are checked the way a job's `place.town` and `place.region` are
  ([Jobs](jobs.md)): a plain name, with no digits and no commas, so a street address or postal code is refused.
  Nothing finer than a town is ever stored or published.
- **`region`** is formatted from a bundled list of US states (and DC) and Canadian provinces and territories:
  `Oregon`, `oregon` and `OR` are all stored as `OR`. A region the list does not know is kept as you wrote it.
- **`note`** is optional: one line of plain text, at most 120 characters, such as `within 30 miles`. It is shown
  as written.
- A bare list of areas is read as version 1. A newer `version` is refused with a message and the file is not
  changed.

## What is refused

Every problem is a sentence that names the entry and the field, and all of them are shown, in `openblog check`
and `openblog build`:

- the same town and region twice, ignoring case and spelling of the region
  (``serviceAreas entry 2: Bend, OR is already listed as entry 1; list each town once``). The same town in two
  regions is fine.
- a missing town or region, a town that looks like an address, a note over one line or 120 characters, a key this
  release does not know.
- more than 100 areas: a page for every town in a region is thin content.

Each area's address is derived from its town, `/areas/bend/`. A town listed in two regions gets the region added
(`/areas/portland-me/`, `/areas/portland-or/`), so the same list always gives the same addresses in any order.

## What the build makes

A site that lists at least one area gets ([ADR 0315](adr/0315-service-area-pages-are-rendered-from-the-area-list-the-services-and-the-jobs-towns-alone-with-an-honest-empty-state-and-no-address-beyond-a-town.md)):

- `/areas/`: every area with its note and how many jobs are posted there.
- `/areas/<town>/`: one page per area with your services (linked, when you have a
  [services collection](services.md)), the ten newest jobs whose `place.town` and `place.region` are that town,
  and your business facts block ([Configuration](configuration.md#business-facts)). Jobs match on the town and
  region only, with the region spelled any way the bundled list knows (`Oregon` matches `OR`); a job in a
  nearby town is not shown, because open.blog does not store coordinates.
- **No address, ever.** A job appears as its title, link and date. Street, address and anything else in a job's
  file never reach an area page.
- **An honest empty state.** A town with no posted jobs says "Work in Redmond, OR is not yet posted. A finished
  job there will appear on this page." and still lists your services. Nothing is padded.
- `areaServed` structured data: each page carries your business (or the site title as an organization) with
  `areaServed` for that town, and, when you have set business facts, the home page's `LocalBusiness` lists every
  area. Only configured towns and regions are emitted; no address, coordinates or distance. Text is escaped so
  nothing can break the page.
- The index and each page in `sitemap.xml` and `llms.txt`, and an **Areas** link in the header navigation
  (unless your own `nav` already links to `/areas/`). `areas` can no longer be a page or post address once you
  list areas.

A site with no `serviceAreas` builds exactly as it did before.
