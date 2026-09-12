# Automated CampusGroups Scrape

This run reads the public CampusGroups mobile calendar JSON feed, ignores past
events, selects the next 5 upcoming events, logs into Brooklyn College WebCentral,
opens each event page, and uploads enriched event docs to Firebase.
Flyers are compressed to JPEG, and flyer icons use the same importer contract:
a tiny 84x84 square PNG at `events/<eventId>/flyerIcon.png`.
Flyer bytes are fetched through Playwright's request API before canvas resizing
so browser CORS rules cannot block icon generation.

Past events should not be archived or deleted just because they are removed from
the CampusGroups JSON feed later. The feed is used as an import source, not as a
delete authority.

## GitHub Setup

Add repository secrets in GitHub:

- `BC_WEBCENTRAL_USERNAME`
- `BC_WEBCENTRAL_PASSWORD`

The workflow runs daily at `10:15 UTC`, and can also be run manually from
Actions -> Scrape Clubs Events -> Run workflow.

## Weekly Club Status Scrape

The club status workflow reads the public all-clubs page first:

`https://www.clubs.brooklyn.cuny.edu/club_signup?view=all&`

It ignores departments, compares remaining clubs to the Firebase `clubs`
collection, and writes `flag: "active"` or `flag: "inactive"` on matched clubs.
Clubs with `Group Not Registered Yet` are inactive unless they also show
`Pending Approval`, which stays active. If two-thirds or more clubs are not
registered yet, the run skips all Firebase flagging for safety.

For existing clubs, the only normal update is `flag`. If an active club has an
empty or missing Firebase description and the public list has a mission, the
mission is copied into `description`. Descriptions containing any text,
including a single space, are left alone.

New clubs get a Firebase club doc using the official club name, the
`campusGroupsClubId`, `sourceUrl`, mission description, website/social links,
and a Storage icon. The authenticated CampusGroups about page is opened only
when new non-department clubs are found and an icon/social links are needed.
That auth uses the same `BC_WEBCENTRAL_USERNAME` and `BC_WEBCENTRAL_PASSWORD`
secrets as the club-event scraper.

The workflow runs weekly on Mondays at `11:20 UTC`, and can also be run manually
from Actions -> Scrape Club Status -> Run workflow.

## Local Test

Use Node 20 or newer.

```powershell
npm ci
npx playwright install chromium
$env:BC_WEBCENTRAL_USERNAME="your_username"
$env:BC_WEBCENTRAL_PASSWORD="your_password"
npm run scrape:clubs
```

For the weekly club status scraper:

```powershell
npm run scrape:club-status -- --dry-run
```

Optional:

```powershell
npm run scrape:clubs -- --limit=5 --dry-run
```

During each run, Playwright writes the logged-in browser session to
`.auth/webcentral-storage-state.json` so the same browser context can keep using
the WebCentral session while scraping event detail pages.
