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

const DEFAULT_PAGE_URL = 'https://www.brooklyn.edu/biology/seminars/';
const SERIES_TITLE = 'Shirlanna Alexis Biology Seminar Series';
const DESCRIPTION_INTRO = 'The Biology Seminar Series at Brooklyn College brings together leading scientists, faculty, and students to explore cutting-edge research across the biological sciences.';
const FLYER_URL = 'https://bcbrooklyn.com/images/bioseminar.png';
const FLYER_PATH = 'images/bioseminar.png';
const ARTIFACTS_DIR = path.resolve('artifacts');
const PAGE_SIZE = 300;
const REQUEST_TIMEOUT_MS = Number(getArgValue('--timeout-ms')) || 45000;
const DEFAULT_LIMIT = 20;
const MONTHS = new Map([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12]
]);

const authToken = process.env.FIREBASE_AUTH_TOKEN || '';
const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const limit = Math.max(Number(getArgValue('--limit')) || DEFAULT_LIMIT, 1);

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
    .replace(/&#8220;|&ldquo;|&OpenCurlyDoubleQuote;/gi, '"')
    .replace(/&#8221;|&rdquo;|&CloseCurlyDoubleQuote;/gi, '"')
    .replace(/&#8211;|&ndash;/gi, '-')
    .replace(/&#8212;|&mdash;/gi, '-')
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value) {
  return decodeEntities(String(value || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '));
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

function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = Object.assign({
      'User-Agent': 'bc-brooklyn-importer/1.0'
    }, options.headers || {});
    if (authToken && !options.skipAuth) headers.Authorization = `Bearer ${authToken}`;

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

function pageUrl() {
  return getArgValue('--page-url') || process.env.BIOLOGY_SEMINARS_URL || DEFAULT_PAGE_URL;
}

async function fetchSeminarsHtml() {
  const inputHtml = getArgValue('--input-html');
  if (inputHtml) return fs.readFile(path.resolve(inputHtml), 'utf8');
  return requestText(pageUrl(), { headers: { Accept: 'text/html' }, skipAuth: true });
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

function updateDocument(docId, data) {
  const fields = firestoreFields(data);
  fields.updatedAt = { timestampValue: new Date().toISOString() };
  return requestJson(firestoreDocumentUrl('events', docId), {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
    headers: { 'Content-Type': 'application/json' }
  });
}

function extractUpcomingHtml(html) {
  const start = html.search(/<h2[^>]*>\s*Upcoming Seminars\s*<\/h2>/i);
  if (start === -1) throw new Error('Could not find Upcoming Seminars section.');
  const afterStart = html.slice(start);
  const endMatch = afterStart.search(/<h2[^>]*>\s*(About this Series|Archives)\s*<\/h2>/i);
  return endMatch === -1 ? afterStart : afterStart.slice(0, endMatch);
}

function absoluteUrl(rawUrl, baseUrl) {
  if (!rawUrl || /^javascript:/i.test(rawUrl)) return '';
  try {
    return new URL(rawUrl, baseUrl).href;
  } catch (_) {
    return rawUrl;
  }
}

function firstSpeakerLink(html, baseUrl) {
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const attrs = match[1] || '';
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const href = hrefMatch ? hrefMatch[1] : '';
    const label = stripHtml(match[2] || '');
    if (!href || !label || /^javascript:/i.test(href) || /\bHost:/i.test(label)) continue;
    return { label, url: absoluteUrl(href, baseUrl) };
  }
  return null;
}

function dateFromHeading(heading, currentYear) {
  const text = stripHtml(heading).replace(/\./g, '');
  const match = text.match(/\b([A-Za-z]+)\s+(\d{1,2})\b/);
  if (!match || !currentYear) return '';
  const month = MONTHS.get(match[1].toLowerCase());
  const day = Number(match[2]);
  if (!month || !day) return '';
  return `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cleanSeminarTitle(value) {
  return decodeEntities(value)
    .replace(/^["']+|["']+$/g, '')
    .replace(/^TBA$/i, 'TBA');
}

function seminarTitleFromHtml(html) {
  const withoutHosts = String(html || '').replace(/Host:\s*[\s\S]*$/i, '');
  const speaker = firstSpeakerLink(withoutHosts, DEFAULT_PAGE_URL)?.label || '';
  const text = withoutHosts
    .replace(/<\/p>\s*<p\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]*>/g, ' ');
  const lines = text.split(/\n+/).map(stripHtml).map(normalize).filter(Boolean);
  const candidates = lines
    .map(line => speaker ? line.replace(speaker, '').trim() : line)
    .map(line => line.replace(/^Host:.*/i, '').trim())
    .map(cleanSeminarTitle)
    .filter(Boolean)
    .filter(line => !/^Host:/i.test(line));
  return candidates.find(line => line && !/\([^)]+\)$/.test(line)) || '';
}

function parseSeminars(html, baseUrl) {
  const section = extractUpcomingHtml(html);
  const seminars = [];
  const allDates = new Set();
  let currentYear = '';
  let currentDate = '';
  let currentDateLabel = '';
  let paragraphs = [];

  const flush = () => {
    if (!currentDate) return;
    const bodyHtml = paragraphs.join('\n');
    allDates.add(currentDate);
    if (/\bNo seminar\b/i.test(stripHtml(bodyHtml))) return;
    const speakerLink = firstSpeakerLink(bodyHtml, baseUrl);
    const seminarTitle = seminarTitleFromHtml(bodyHtml);
    if (!speakerLink || !seminarTitle) return;
    seminars.push({
      eventId: `bio_${currentDate}`,
      date: currentDate,
      dateLabel: currentDateLabel,
      speaker: speakerLink.label,
      speakerUrl: speakerLink.url,
      seminarTitle
    });
  };

  const tagPattern = /<(h3|h4|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagPattern.exec(section)) !== null) {
    const tag = match[1].toLowerCase();
    const inner = match[2] || '';
    if (tag === 'h3') {
      flush();
      currentDate = '';
      paragraphs = [];
      const yearMatch = stripHtml(inner).match(/\b(20\d{2})\b/);
      if (yearMatch) currentYear = yearMatch[1];
      continue;
    }
    if (tag === 'h4') {
      flush();
      currentDateLabel = stripHtml(inner);
      currentDate = dateFromHeading(inner, currentYear);
      paragraphs = [];
      continue;
    }
    if (tag === 'p' && currentDate) paragraphs.push(inner);
  }
  flush();

  return { seminars, allDates };
}

function canonical(value) {
  return decodeEntities(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(the|club|student|students|association|department|of)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findBiologyOrg(clubDocs, orgDocs) {
  const docs = [...clubDocs, ...orgDocs];
  return docs.find(doc => canonical(doc.id) === 'biology') ||
    docs.find(doc => canonical(doc.data.name || doc.data.clubId || doc.data.org || doc.data.title) === 'biology') ||
    docs.find(doc => /\bbiology\b/i.test(normalize(`${doc.id} ${doc.data.name || ''} ${doc.data.clubId || ''} ${doc.data.org || ''}`))) ||
    { id: 'Biology', data: { name: 'Biology' } };
}

function buildEvent(seminar, biologyOrg) {
  const orgData = biologyOrg.data || {};
  const orgName = normalize(orgData.name || orgData.clubId || orgData.org || 'Biology');
  const orgId = biologyOrg.id || normalize(orgData.orgId || orgData.clubId || 'Biology');
  return {
    eventId: seminar.eventId,
    biologySeminarId: seminar.eventId,
    title: SERIES_TITLE,
    date: seminar.date,
    time: '12:30 PM',
    starttime: '1230',
    room: '113 Ingersoll Hall Extension',
    type: 'brooklyn event',
    description: `${DESCRIPTION_INTRO}\nThis lecture's title is: "${seminar.seminarTitle}"\n${seminar.speaker}`,
    club: orgName,
    clubId: orgId,
    org: orgName,
    orgId,
    'org-website': orgData.website || orgData['org-website'] || DEFAULT_PAGE_URL,
    flyer: FLYER_URL,
    flyerPath: FLYER_PATH,
    flyerIcon: orgData.icon || '',
    flyerIconPath: orgData.iconPath || '',
    links: [
      { label: seminar.speaker, url: seminar.speakerUrl },
      { label: 'Full Schedule', url: DEFAULT_PAGE_URL }
    ].filter(link => link.url),
    link: seminar.speakerUrl,
    source: 'brooklyn.edu biology seminars',
    sourceUrl: DEFAULT_PAGE_URL,
    archived: false,
    confirmed: 1
  };
}

function isUpcomingBioDoc(doc) {
  const id = normalize(doc.data.eventId || doc.id);
  const date = normalize(doc.data.date);
  return id.startsWith('bio_') && date >= todayInNewYork();
}

async function archiveMissingUpcomingSeminars(existingEvents, activeDateSet, knownDateSet) {
  const archived = [];
  for (const doc of existingEvents.filter(isUpcomingBioDoc)) {
    const date = normalize(doc.data.date);
    if (!knownDateSet.has(date) && activeDateSet.has(date)) continue;
    if (activeDateSet.has(date)) continue;
    if (doc.data.archived === true) continue;
    const update = { ...(doc.data || {}), eventId: normalize(doc.data.eventId || doc.id), archived: true };
    archived.push({ eventId: doc.id, date, title: doc.data.title || '' });
    if (dryRun) {
      console.log(`DRY RUN archive ${doc.id}: ${date} is no longer an upcoming seminar`);
    } else {
      await updateDocument(doc.id, update);
      console.log(`Archived ${doc.id}: ${date} is no longer an upcoming seminar`);
    }
  }
  return archived;
}

async function main() {
  const url = pageUrl();
  console.log(`Reading Biology seminars from ${url}`);
  const [html, existingEvents, clubDocs, orgDocs] = await Promise.all([
    fetchSeminarsHtml(),
    fetchCollection('events'),
    fetchCollection('clubs'),
    fetchCollection('orgs')
  ]);
  const { seminars, allDates } = parseSeminars(html, url);
  const activeDateSet = new Set(seminars.filter(seminar => seminar.date >= todayInNewYork()).map(seminar => seminar.date));
  const biologyOrg = findBiologyOrg(clubDocs, orgDocs);
  const candidates = seminars
    .filter(seminar => seminar.date >= todayInNewYork())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);

  console.log(`Parsed ${seminars.length} actual seminars. Selected ${candidates.length} upcoming seminars. Biology org: ${biologyOrg.id}.`);

  const uploaded = [];
  const failed = [];
  for (const [index, seminar] of candidates.entries()) {
    try {
      const event = buildEvent(seminar, biologyOrg);
      if (dryRun) {
        console.log(`[${index + 1}/${candidates.length}] DRY RUN ${event.eventId}: ${seminar.speaker} - ${seminar.seminarTitle}`);
      } else {
        await updateDocument(event.eventId, event);
        console.log(`[${index + 1}/${candidates.length}] Uploaded ${event.eventId}: ${seminar.speaker} - ${seminar.seminarTitle}`);
      }
      uploaded.push(event);
    } catch (err) {
      failed.push({ eventId: seminar.eventId, speaker: seminar.speaker, error: err.message });
      console.warn(`[${index + 1}/${candidates.length}] Failed ${seminar.eventId}: ${err.message.split('\n')[0]}`);
    }
  }

  const archived = await archiveMissingUpcomingSeminars(existingEvents, activeDateSet, allDates);

  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(ARTIFACTS_DIR, 'scrape-biology-seminars-summary.json'),
    JSON.stringify({
      dryRun,
      pageUrl: url,
      parsed: seminars.length,
      selected: candidates.length,
      uploaded: uploaded.length,
      archived: archived.length,
      failed,
      biologyOrg: {
        id: biologyOrg.id,
        name: biologyOrg.data?.name || biologyOrg.data?.clubId || biologyOrg.data?.org || 'Biology',
        icon: biologyOrg.data?.icon || ''
      },
      events: uploaded.map(event => ({
        eventId: event.eventId,
        title: event.title,
        date: event.date,
        description: event.description,
        org: event.org,
        flyer: event.flyer,
        flyerIcon: event.flyerIcon,
        links: event.links
      })),
      archivedEvents: archived
    }, null, 2) + '\n',
    'utf8'
  );

  console.log(`Done. ${dryRun ? 'Parsed' : 'Uploaded'} ${uploaded.length}; archived ${archived.length}; failed ${failed.length}.`);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
