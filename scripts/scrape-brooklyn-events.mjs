import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { URL } from 'url';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBk3RyolpOBCEmGR9iqqvphkl8r-JNtDFY',
  authDomain: 'bcbrooklyn-data.firebaseapp.com',
  projectId: 'bcbrooklyn-data',
  storageBucket: 'bcbrooklyn-data.firebasestorage.app',
  messagingSenderId: '420950247250',
  appId: '1:420950247250:web:42259d89031803474f9c8b'
};

const DEFAULT_API_URL = 'https://www.brooklyn.edu/wp-json/tribe/events/v1/events';
const ARTIFACTS_DIR = path.resolve('artifacts');
const MAX_UPLOAD_EVENTS = 15;
const PAGE_SIZE = 300;
const PER_PAGE = Number(getArgValue('--per-page')) || 50;
const REQUEST_TIMEOUT_MS = Number(getArgValue('--timeout-ms')) || 45000;

const authToken = process.env.FIREBASE_AUTH_TOKEN || '';
const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const repairDatesOnly = process.argv.includes('--repair-dates-only');
const limit = Math.min(Math.max(Number(getArgValue('--limit')) || MAX_UPLOAD_EVENTS, 1), MAX_UPLOAD_EVENTS);

function getArgValue(name) {
  const arg = process.argv.find(value => value === name || value.startsWith(name + '='));
  if (!arg) return '';
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  const idx = process.argv.indexOf(arg);
  return process.argv[idx + 1] || '';
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return normalize(value)
    .replace(/&#038;|&amp;/gi, '&')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8220;|&ldquo;/gi, '"')
    .replace(/&#8221;|&rdquo;/gi, '"')
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' '));
}

function firstArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function addMonths(date, months) {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function todayInNewYork() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function defaultStartDate() {
  return getArgValue('--start-date') || todayInNewYork();
}

function defaultEndDate() {
  return getArgValue('--end-date') || ymd(addMonths(new Date(`${defaultStartDate()}T00:00:00.000Z`), 2));
}

function maxPostingDate() {
  return ymd(addMonths(new Date(`${todayInNewYork()}T00:00:00.000Z`), 2));
}

function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = Object.assign({
      'User-Agent': 'bc-brooklyn-importer/1.0'
    }, options.headers || {});
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    const req = https.request(target, { method: options.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ body, headers: res.headers, statusCode: res.statusCode });
          return;
        }
        reject(new Error(`HTTP ${res.statusCode} for ${url}\n${body.toString('utf8').slice(0, 800)}`));
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`)));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function requestText(url, options = {}) {
  const { body } = await requestBuffer(url, options);
  return body.toString('utf8');
}

async function requestJson(url, options = {}) {
  const text = await requestText(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) }
  });
  return JSON.parse(text);
}

function apiUrl(page) {
  const explicit = getArgValue('--feed-url') || process.env.BROOKLYN_EVENTS_API_URL || '';
  const url = new URL(explicit || DEFAULT_API_URL);
  if (!explicit || !url.searchParams.has('start_date')) url.searchParams.set('start_date', defaultStartDate());
  if (!explicit || !url.searchParams.has('end_date')) url.searchParams.set('end_date', defaultEndDate());
  if (!url.searchParams.has('per_page')) url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('page', String(page));
  return url.toString();
}

function getEvents(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.events)) return data.events;
  return [];
}

function totalPages(data) {
  const value = Number(data.total_pages || data.totalPages || data.pages);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

async function fetchBrooklynEvents() {
  const inputJson = getArgValue('--input-json');
  if (inputJson) {
    const raw = await fs.readFile(path.resolve(inputJson), 'utf8');
    return getEvents(JSON.parse(raw));
  }

  const first = await requestJson(apiUrl(1));
  const events = getEvents(first);
  for (let page = 2; page <= totalPages(first); page += 1) {
    const data = await requestJson(apiUrl(page));
    events.push(...getEvents(data));
  }
  return events;
}

function eventTitle(evt) {
  return decodeEntities(evt.title && typeof evt.title === 'object' ? evt.title.rendered : evt.title);
}

function eventDateKey(evt) {
  return normalize(evt.start_date).slice(0, 10);
}

function formatDate(evt) {
  return eventDateKey(evt);
}

function timeLabelFromDetails(details) {
  if (!details || details.hour === undefined) return '';
  let hour = Number(details.hour);
  const minutes = String(details.minutes || '00').padStart(2, '0');
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minutes} ${suffix}`;
}

function formatTime(evt) {
  if (evt.all_day) return 'All Day';
  const start = timeLabelFromDetails(evt.start_date_details);
  const end = timeLabelFromDetails(evt.end_date_details);
  if (start && end) return `${start} - ${end}`;
  return start || '';
}

function starttime(evt) {
  const details = evt.start_date_details || {};
  if (!details.hour) return null;
  return String(details.hour).padStart(2, '0') + String(details.minutes || '00').padStart(2, '0');
}

function organizersOf(evt) {
  return firstArray(evt.organizer)
    .filter(org => org && typeof org === 'object')
    .map(org => ({
      orgId: `b_${normalize(org.id || org.ID || org.organizer_id || org.slug || org.organizer)}`,
      sourceId: normalize(org.id || org.ID || org.organizer_id || org.slug || org.organizer),
      name: decodeEntities(org.organizer || org.name || org.title || org.slug || org.id),
      website: normalize(org.website || org.url || org.link || org.organizer_website)
    }))
    .filter(org => org.name);
}

function primaryOrganizer(evt) {
  return organizersOf(evt)[0] || { orgId: '', sourceId: '', name: '', website: '' };
}

function isConservatoryOfMusicEvent(evt) {
  return organizersOf(evt).some(org => /conservatory of music/i.test(org.name));
}

function venueText(evt) {
  const pieces = [];
  for (const venue of [...firstArray(evt.venue), ...firstArray(evt.venues)]) {
    if (!venue || typeof venue !== 'object') continue;
    pieces.push(venue.venue, venue.name, venue.address, venue.city, venue.state, venue.zip, venue.country, venue.full_address);
  }
  pieces.push(evt.venue_name, evt.location, evt.address);
  return stripHtml(pieces.filter(Boolean).join(' '));
}

function venueSlugText(evt) {
  return stripHtml([...firstArray(evt.venue), ...firstArray(evt.venues)].map(venue => {
    if (!venue || typeof venue !== 'object') return '';
    return [venue.venue, venue.name, venue.slug, venue.url].filter(Boolean).join(' ');
  }).join(' '));
}

function isCampusEvent(evt) {
  const place = venueSlugText(evt);
  if (evt.is_virtual || evt.virtual_url || /\b(online|virtual|zoom|webinar|webex|teams)\b/i.test(place)) return false;
  const venue = venueText(evt);
  if (!venue) return false;
  return /brooklyn college|2900 bedford|bedford ave|brooklyn,\s*ny|boylan|ingerson|ingersoll|whitehead|west quad|library|roosevelt|tow center|student center|whitman|gershwin|new ingersoll|plaza|gymnasium|quad|cafeteria|cafe|tow center/i.test(venue);
}

function isUpcoming(evt) {
  const date = eventDateKey(evt);
  return date >= todayInNewYork() && date <= maxPostingDate();
}

function imageUrl(evt) {
  if (!evt.image) return '';
  if (typeof evt.image === 'string') return evt.image;
  if (typeof evt.image === 'object') return normalize(evt.image.url || evt.image.src || evt.image.full?.url || evt.image.thumbnail?.url);
  return '';
}

function normalizeTitleForMatch(value) {
  return decodeEntities(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeStoredDate(value) {
  const text = normalize(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return text;
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function docIdFromName(name) {
  return String(name || '').split('/').pop();
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return value;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) {
    const asNumber = Number(value.integerValue);
    return Number.isSafeInteger(asNumber) ? asNumber : value.integerValue;
  }
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in value) return decodeFirestoreFields(value.mapValue.fields || {});
  return value;
}

function decodeFirestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function firestoreCollectionUrl(collectionName, pageToken = '') {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${collectionName}`);
  url.searchParams.set('key', FIREBASE_CONFIG.apiKey);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

function firestoreDocumentUrl(collectionName, docId) {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${collectionName}/${encodeURIComponent(docId)}`);
  url.searchParams.set('key', FIREBASE_CONFIG.apiKey);
  return url.toString();
}

async function fetchCollection(collectionName) {
  const docs = [];
  let pageToken = '';
  do {
    const page = await requestJson(firestoreCollectionUrl(collectionName, pageToken));
    docs.push(...(page.documents || []).map(doc => ({
      id: docIdFromName(doc.name),
      data: decodeFirestoreFields(doc.fields || {})
    })));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return docs;
}

function firestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === 'object') return { mapValue: { fields: firestoreFields(value) } };
  return { stringValue: String(value) };
}

function firestoreFields(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, firestoreValue(value)]));
}

function classAttrHas(attrs, className) {
  const match = String(attrs || '').match(/\bclass\s*=\s*["']([^"']+)["']/i);
  if (!match) return false;
  return match[1].split(/\s+/).includes(className);
}

function anchorFromHtml(html, baseUrl) {
  const match = String(html || '').match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
  if (!match) return null;
  const attrs = match[1] || '';
  const label = stripHtml(match[2] || '');
  const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
  const href = hrefMatch ? hrefMatch[1] : '';
  if (!href || !label) return null;
  try {
    return { label, url: new URL(href, baseUrl).href };
  } catch (_) {
    return { label, url: href };
  }
}

function findEventCtaLinkInHtml(html, baseUrl) {
  const wrapperPattern = /<div\b([^>]*)>([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = wrapperPattern.exec(html)) !== null) {
    if (!classAttrHas(match[1], 'event-cta-wrapper')) continue;
    const link = anchorFromHtml(match[2], baseUrl);
    if (link) return link;
  }
  return null;
}

async function findRegisterLink(evt) {
  if (!evt.url) return null;

  try {
    const html = await requestText(evt.url, { headers: { Accept: 'text/html' } });
    return findEventCtaLinkInHtml(html, evt.url);
  } catch (err) {
    console.warn(`Event CTA lookup failed for ${evt.id}: ${err.message.split('\n')[0]}`);
    return null;
  }
}

function buildOrgMap(orgDocs) {
  return new Map(orgDocs.map(doc => [doc.id, doc.data]));
}

function buildClubTitleSet(eventDocs) {
  const titles = new Set();
  for (const doc of eventDocs) {
    const type = normalize(doc.data.type).toLowerCase();
    const eventId = normalize(doc.data.eventId || doc.id);
    if (type === 'club event' || eventId.startsWith('c_')) {
      const key = normalizeTitleForMatch(doc.data.title);
      if (key) titles.add(key);
    }
  }
  return titles;
}

function buildExistingIdSet(eventDocs) {
  return new Set(eventDocs.map(doc => normalize(doc.data.eventId || doc.id)).filter(Boolean));
}

async function mergeEvent(evt, orgMap, clubTitleSet) {
  const org = primaryOrganizer(evt);
  const orgData = orgMap.get(org.orgId) || {};
  const eventId = `b_${evt.id}`;
  const eventImageUrl = imageUrl(evt);
  const fallbackIcon = orgData.icon || '';
  const fallbackIconPath = orgData.iconPath || '';
  const link = await findRegisterLink(evt);
  const title = eventTitle(evt);
  const archived = clubTitleSet.has(normalizeTitleForMatch(title));
  const type = isConservatoryOfMusicEvent(evt) ? 'performance' : 'brooklyn event';

  return {
    eventId,
    brooklynId: String(evt.id || ''),
    title,
    date: formatDate(evt),
    time: formatTime(evt),
    starttime: starttime(evt),
    room: venueText(evt),
    type,
    description: stripHtml(evt.description || evt.excerpt || ''),
    club: org.name,
    clubId: org.orgId,
    org: org.name,
    orgId: org.orgId,
    'org-website': org.website || orgData.website || orgData['org-website'] || '',
    flyer: eventImageUrl || fallbackIcon,
    flyerPath: '',
    flyerIcon: eventImageUrl || fallbackIcon,
    flyerIconPath: eventImageUrl ? '' : fallbackIconPath,
    links: link ? [{ label: link.label, url: link.url }] : [],
    source: 'brooklyn.edu',
    sourceUrl: evt.url || '',
    archived,
    confirmed: 1
  };
}

async function uploadEvent(event) {
  const fields = firestoreFields(event);
  fields.createdAt = { timestampValue: new Date().toISOString() };
  await requestJson(firestoreDocumentUrl('events', event.eventId), {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
    headers: { 'Content-Type': 'application/json' }
  });
}

async function repairExistingBrooklynDates(eventDocs) {
  const repairs = eventDocs
    .filter(doc => normalize(doc.data.eventId || doc.id).startsWith('b_'))
    .map(doc => ({ id: doc.id, oldDate: normalize(doc.data.date), newDate: normalizeStoredDate(doc.data.date) }))
    .filter(item => item.oldDate && item.newDate && item.oldDate !== item.newDate);

  if (!repairs.length) {
    console.log('No existing Brooklyn event date formats need repair.');
    return [];
  }

  for (const repair of repairs) {
    if (dryRun) {
      console.log(`DRY RUN repair ${repair.id}: ${repair.oldDate} -> ${repair.newDate}`);
      continue;
    }
    await requestJson(firestoreDocumentUrl('events', repair.id), {
      method: 'PATCH',
      body: JSON.stringify({ fields: { date: { stringValue: repair.newDate }, updatedAt: { timestampValue: new Date().toISOString() } } }),
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`Repaired ${repair.id}: ${repair.oldDate} -> ${repair.newDate}`);
  }

  return repairs;
}

async function main() {
  console.log(`Reading Brooklyn.edu events (${getArgValue('--input-json') ? path.resolve(getArgValue('--input-json')) : apiUrl(1)})`);
  const [rawEvents, existingEvents, orgDocs] = await Promise.all([
    fetchBrooklynEvents(),
    fetchCollection('events'),
    fetchCollection('orgs')
  ]);
  const existingIds = buildExistingIdSet(existingEvents);
  const clubTitleSet = buildClubTitleSet(existingEvents);
  const orgMap = buildOrgMap(orgDocs);
  const repairedDates = await repairExistingBrooklynDates(existingEvents);
  if (repairDatesOnly) {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(ARTIFACTS_DIR, 'scrape-brooklyn-summary.json'),
      JSON.stringify({ dryRun, repairDatesOnly, repairedDates }, null, 2) + '\n',
      'utf8'
    );
    return;
  }

  const candidates = rawEvents
    .filter(evt => evt && evt.id)
    .filter(isCampusEvent)
    .filter(isUpcoming)
    .filter(evt => !existingIds.has(`b_${evt.id}`))
    .sort((a, b) => normalize(a.start_date).localeCompare(normalize(b.start_date)))
    .slice(0, limit);

  console.log(`JSON returned ${rawEvents.length} events. Selected ${candidates.length} new upcoming campus events. Existing b_ events are ignored.`);

  const uploaded = [];
  const failed = [];
  for (const [index, evt] of candidates.entries()) {
    try {
      const event = await mergeEvent(evt, orgMap, clubTitleSet);
      if (dryRun) {
        console.log(`[${index + 1}/${candidates.length}] DRY RUN ${event.eventId}: ${event.title}${event.archived ? ' (archived: title matches club event)' : ''}`);
      } else {
        await uploadEvent(event);
        console.log(`[${index + 1}/${candidates.length}] Uploaded ${event.eventId}: ${event.title}${event.archived ? ' (archived: title matches club event)' : ''}`);
      }
      uploaded.push(event);
    } catch (err) {
      failed.push({ id: evt.id, title: eventTitle(evt), error: err.message });
      console.warn(`[${index + 1}/${candidates.length}] Failed ${evt.id}: ${err.message.split('\n')[0]}`);
    }
  }

  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(ARTIFACTS_DIR, 'scrape-brooklyn-summary.json'),
    JSON.stringify({
      dryRun,
      rawEvents: rawEvents.length,
      selected: candidates.length,
      uploaded: uploaded.length,
      failed,
      events: uploaded.map(event => ({
        eventId: event.eventId,
        title: event.title,
        date: event.date,
        room: event.room,
        org: event.org,
        archived: event.archived,
        flyerIcon: event.flyerIcon,
        links: event.links
      }))
    }, null, 2) + '\n',
    'utf8'
  );

  console.log(`Done. ${dryRun ? 'Parsed' : 'Uploaded'} ${uploaded.length}; failed ${failed.length}.`);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
