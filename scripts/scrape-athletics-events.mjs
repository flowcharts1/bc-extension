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

const DEFAULT_FEED_URL = 'https://www.brooklyncollegeathletics.com/services/responsive-calendar.ashx?type=month&sport=0&location=all';
const ARTIFACTS_DIR = path.resolve('artifacts');
const MAX_UPLOAD_EVENTS = 15;
const PAGE_SIZE = 300;
const REQUEST_TIMEOUT_MS = Number(getArgValue('--timeout-ms')) || 45000;
const SPORT_ORDER = ['Basketball', 'Tennis', 'Softball', 'Swimming', 'Soccer', 'Volleyball', 'Cross Country', 'Cheerleading'];

const authToken = process.env.FIREBASE_AUTH_TOKEN || '';
const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
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

function stripHtml(value) {
  return normalize(String(value || '').replace(/<[^>]*>/g, ' '));
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

function feedDate() {
  const explicit = getArgValue('--date') || process.env.ATHLETICS_FEED_DATE || '';
  if (explicit) return explicit;
  const [year, month, day] = todayInNewYork().split('-');
  return `${Number(month)}/${Number(day)}/${year}`;
}

function feedUrl() {
  const explicit = getArgValue('--feed-url') || process.env.ATHLETICS_FEED_URL || '';
  const url = new URL(explicit || DEFAULT_FEED_URL);
  if (!url.searchParams.has('type')) url.searchParams.set('type', 'month');
  if (!url.searchParams.has('sport')) url.searchParams.set('sport', '0');
  if (!url.searchParams.has('location')) url.searchParams.set('location', 'all');
  if (!url.searchParams.has('date')) url.searchParams.set('date', feedDate());
  return url.toString();
}

function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = Object.assign({
      'User-Agent': 'bc-brooklyn-importer/1.0',
      Accept: 'application/json'
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
  return JSON.parse(await requestText(url, options));
}

async function fetchAthleticsEvents() {
  const days = await requestJson(feedUrl());
  if (!Array.isArray(days)) return [];
  return days.flatMap(day => Array.isArray(day.events) ? day.events : []);
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

function eventDateKey(evt) {
  return normalize(evt.date).slice(0, 10);
}

function starttime(evt) {
  const match = normalize(evt.date).match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}${match[2]}` : null;
}

function formatTime(evt) {
  return normalize(evt.time).replace(/\s+/g, ' ');
}

function cleanSportsLocation(value) {
  return normalize(normalize(value)
    .replace(/\s*\([^)]*\bNY\b[^)]*\)/gi, '')
    .replace(/\s*,\s*NY\b/gi, ''));
}

function detectSport(evt) {
  const text = normalize(`${evt.sport?.title || ''} ${evt.sport?.short_display || ''}`);
  return SPORT_ORDER.find(sport => new RegExp(`\\b${sport.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text)) || text;
}

function sportOrderIndex(evt) {
  const sport = detectSport(evt);
  const index = SPORT_ORDER.findIndex(item => item.toLowerCase() === sport.toLowerCase());
  return index === -1 ? SPORT_ORDER.length : index;
}

function sportImageUrl(evt) {
  const sport = detectSport(evt);
  return sport ? `https://bcbrooklyn.com/images/${sport.toLowerCase().replace(/\s+/g, '-')}.png` : '';
}

function sportImagePath(evt) {
  const sport = detectSport(evt);
  return sport ? `images/${sport.toLowerCase().replace(/\s+/g, '-')}.png` : '';
}

function opponentName(evt) {
  return normalize(evt.opponent?.title || evt.opponent?.name || evt.opponent?.mascot || 'Opponent');
}

function eventTitle(evt) {
  const sport = normalize(evt.sport?.title || evt.sport?.short_display || 'Athletics');
  return `${sport} vs ${opponentName(evt)}`;
}

function isHomeGame(evt) {
  return normalize(evt.location_indicator).toUpperCase() === 'H';
}

function isUpcoming(evt) {
  return eventDateKey(evt) >= todayInNewYork();
}

function isActiveGame(evt) {
  const status = normalize(evt.status).toUpperCase();
  return status !== 'C' && status !== 'P';
}

function buildExistingIdSet(eventDocs) {
  return new Set(eventDocs.map(doc => normalize(doc.data.eventId || doc.id)).filter(Boolean));
}

function mergeEvent(evt) {
  const imageUrl = sportImageUrl(evt);
  const imagePath = sportImagePath(evt);
  return {
    eventId: `a_${evt.id}`,
    athleticsId: String(evt.id || ''),
    title: eventTitle(evt),
    date: eventDateKey(evt),
    time: formatTime(evt),
    starttime: starttime(evt),
    room: cleanSportsLocation(evt.location),
    type: 'sports game',
    description: stripHtml(evt.noplay_text || evt.promotion || ''),
    club: 'Brooklyn College Athletics',
    clubId: 'athletics',
    org: 'Brooklyn College Athletics',
    orgId: 'athletics',
    'org-website': '',
    flyer: imageUrl,
    flyerPath: imagePath,
    flyerIcon: imageUrl,
    flyerIconPath: imagePath,
    links: [],
    link: '',
    source: 'brooklyncollegeathletics.com',
    sourceUrl: '',
    sport: detectSport(evt),
    opponent: opponentName(evt),
    homeAway: 'home',
    archived: false,
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

async function main() {
  const url = feedUrl();
  console.log(`Reading Brooklyn College Athletics games (${url})`);
  const [rawEvents, existingEvents] = await Promise.all([
    fetchAthleticsEvents(),
    fetchCollection('events')
  ]);
  const existingIds = buildExistingIdSet(existingEvents);
  const candidates = rawEvents
    .filter(evt => evt && evt.id)
    .filter(isHomeGame)
    .filter(isUpcoming)
    .filter(isActiveGame)
    .filter(evt => !existingIds.has(`a_${evt.id}`))
    .sort((a, b) => {
      const dateCompare = normalize(a.date).localeCompare(normalize(b.date));
      if (dateCompare) return dateCompare;
      return sportOrderIndex(a) - sportOrderIndex(b);
    })
    .slice(0, limit);

  console.log(`JSON returned ${rawEvents.length} games. Selected ${candidates.length} new upcoming home games. Away games and existing a_ events are ignored.`);

  const uploaded = [];
  const failed = [];
  for (const [index, evt] of candidates.entries()) {
    try {
      const event = mergeEvent(evt);
      if (dryRun) {
        console.log(`[${index + 1}/${candidates.length}] DRY RUN ${event.eventId}: ${event.title} (${event.room || 'no location'})`);
      } else {
        await uploadEvent(event);
        console.log(`[${index + 1}/${candidates.length}] Uploaded ${event.eventId}: ${event.title} (${event.room || 'no location'})`);
      }
      uploaded.push(event);
    } catch (err) {
      failed.push({ id: evt.id, title: eventTitle(evt), error: err.message });
      console.warn(`[${index + 1}/${candidates.length}] Failed ${evt.id}: ${err.message.split('\n')[0]}`);
    }
  }

  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(ARTIFACTS_DIR, 'scrape-athletics-summary.json'),
    JSON.stringify({
      dryRun,
      feedUrl: url,
      rawEvents: rawEvents.length,
      selected: candidates.length,
      uploaded: uploaded.length,
      failed,
      events: uploaded.map(event => ({
        eventId: event.eventId,
        title: event.title,
        date: event.date,
        room: event.room,
        sport: event.sport,
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
