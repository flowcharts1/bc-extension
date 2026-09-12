# Automated CampusGroups Scrape

This test run logs into Brooklyn College WebCentral, opens the CampusGroups
calendar, parses event pages, and prints a random sample of event names plus
locations. It does not connect to Firebase or upload anything.

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
npm run scrape:clubs -- --limit=10 --sample-size=3
```

During each run, Playwright writes the logged-in browser session to
`.auth/webcentral-storage-state.json` so the same browser context can keep using
the WebCentral session while scraping event detail pages.
