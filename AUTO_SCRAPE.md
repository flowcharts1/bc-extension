# Automated CampusGroups Scrape

This run reads the public CampusGroups mobile calendar JSON feed, ignores past
events, selects the next 15 upcoming events, logs into Brooklyn College WebCentral,
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
collection, and writes `flag`, `active`, and `inactive` on matched clubs.
Clubs with `Group Not Registered Yet` are inactive even if they also show
`Pending Approval`. Even if most clubs are not registered yet, the run still
updates Firebase status fields so the website reflects CampusGroups.

For existing clubs, the normal update is `flag`, `active`, and `inactive`. If
an active club has an empty or missing Firebase description and the public list
has a mission, the mission is copied into `description`. Descriptions
containing any text, including a single space, are left alone.

New clubs get a Firebase club doc using the official club name, the
`campusGroupsClubId`, `sourceUrl`, mission description, social media links,
and a Storage icon. The authenticated CampusGroups about page is opened only
when new non-department clubs are found and an icon/social links are needed.
That auth uses the same `BC_WEBCENTRAL_USERNAME` and `BC_WEBCENTRAL_PASSWORD`
secrets as the club-event scraper.

The workflow runs weekly on Mondays at `11:20 UTC`, and can also be run manually
from Actions -> Scrape Club Status -> Run workflow.

## Weekly Biology Seminar Scrape

The Biology seminar workflow reads:

`https://www.brooklyn.edu/biology/seminars/`

It only parses the Upcoming Seminars section, ignores rows that say
`No seminar`, and ignores past seminar dates. Event docs use stable IDs in the
form `bio_YYYY-MM-DD`, so a changed speaker or topic for the same seminar date
updates the existing Firebase event instead of creating a duplicate. If a future
seminar that was previously imported is changed to `No seminar` or disappears
from the upcoming schedule, the workflow archives that event.

The event title is always `Shirlanna Alexis Biology Seminar Series`. The
description starts with the Biology Seminar Series blurb, then `This lecture's
title is: "..."`, then the speaker on the next line. The event flyer is
`https://bcbrooklyn.com/images/bioseminar.png`; the event icon uses the Biology org
icon from Firebase when available.

The workflow runs weekly on Mondays at `11:15 UTC`, and can also be run
manually from Actions -> Scrape Biology Seminars -> Run workflow.

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

For the weekly Biology seminar scraper:

```powershell
npm run scrape:biology -- --dry-run
```

Optional:

```powershell
npm run scrape:clubs -- --limit=15 --dry-run
```

During each run, Playwright writes the logged-in browser session to
`.auth/webcentral-storage-state.json` so the same browser context can keep using
the WebCentral session while scraping event detail pages.
