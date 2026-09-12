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

## Local Test

Use Node 20 or newer.

```powershell
npm ci
npx playwright install chromium
$env:BC_WEBCENTRAL_USERNAME="your_username"
$env:BC_WEBCENTRAL_PASSWORD="your_password"
npm run scrape:clubs
```

Optional:

```powershell
npm run scrape:clubs -- --limit=5 --dry-run
```

During each run, Playwright writes the logged-in browser session to
`.auth/webcentral-storage-state.json` so the same browser context can keep using
the WebCentral session while scraping event detail pages.
