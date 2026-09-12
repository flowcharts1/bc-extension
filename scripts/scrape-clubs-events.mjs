import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { URL } from 'url';
import { chromium } from 'playwright';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBk3RyolpOBCEmGR9iqqvphkl8r-JNtDFY',
  authDomain: 'bcbrooklyn-data.firebaseapp.com',
  projectId: 'bcbrooklyn-data',
  storageBucket: 'bcbrooklyn-data.firebasestorage.app',
  messagingSenderId: '420950247250',
  appId: '1:420950247250:web:42259d89031803474f9c8b'
};

const DEFAULT_FEED_URL = 'https://www.clubs.brooklyn.cuny.edu/mobile_ws/v17/mobile_calendar.aspx';
const DEFAULT_EVENT_URL_TEMPLATE = 'https://www.clubs.brooklyn.cuny.edu/usg/rsvp_boot?id={id}';
const DEFAULT_LOGIN_URL = 'https://www.clubs.brooklyn.cuny.edu/webapp/auth/login?redirect=%2Fcalendar';
const AUTH_STATE_PATH = path.resolve('.auth', 'webcentral-storage-state.json');
const ARTIFACTS_DIR = path.resolve('artifacts');
const MAX_ACTION_EVENTS = 15;
const FULL_FLYER_MAX_PX = 1100;
const FULL_FLYER_QUALITY = 0.68;
const ICON_SIZE_PX = 84;
const PAGE_SIZE = 300;
const REQUEST_TIMEOUT_MS = Number(getArgValue('--timeout-ms')) || 45000;

const username = process.env.BC_WEBCENTRAL_USERNAME || '';
const password = process.env.BC_WEBCENTRAL_PASSWORD || '';
const authToken = process.env.FIREBASE_AUTH_TOKEN || '';
const feedUrl = process.env.BC_MOBILE_CALENDAR_URL || DEFAULT_FEED_URL;
const eventUrlTemplate = process.env.BC_EVENT_URL_TEMPLATE || DEFAULT_EVENT_URL_TEMPLATE;
const loginUrl = process.env.BC_LOGIN_URL || DEFAULT_LOGIN_URL;
const limitArg = Number(getArgValue('--limit')) || MAX_ACTION_EVENTS;
const limit = Math.min(Math.max(limitArg, 1), MAX_ACTION_EVENTS);
const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const headed = process.argv.includes('--headed');

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
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function absoluteUrl(rawUrl, baseUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl, baseUrl).href;
  } catch (_) {
    return rawUrl;
  }
}

function hasNativeFlyerUrl(value) {
  const url = normalize(value).toLowerCase();
  if (!url) return false;
  return !/listing-default|default(?:_|-)?event|default(?:_|-)?flyer|placeholder|no(?:_|-)?image|event(?:_|-)?default/.test(url);
}

function eventPageUrl(id) {
  return eventUrlTemplate.replace('{id}', encodeURIComponent(String(id)));
}

function getStarttimeFromTimeText(value) {
  const text = normalize(value)
    .replace(/[\u2012-\u2015]/g, '-')
    .toLowerCase();
  if (!text) return null;

  const timeTokenPattern = /\b(noon|midnight)\b|\b(\d{1,2})(?:\s*[:.]\s*(\d{1,2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?\b/gi;
  let match;

  while ((match = timeTokenPattern.exec(text)) !== null) {
    if (match[1]) return match[1].toLowerCase() === 'noon' ? '1200' : '0000';

    const rawHour = Number(match[2]);
    const minutes = match[3] === undefined ? 0 : Number(match[3]);
    if (!Number.isInteger(rawHour) || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) continue;

    const meridiem = (match[4] || '').replace(/[^ap]/gi, '').toLowerCase();
    let hour = rawHour;
    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      if (meridiem === 'p' && hour !== 12) hour += 12;
      if (meridiem === 'a' && hour === 12) hour = 0;
    } else if (hour <= 8) {
      hour += 12;
    } else if (hour > 23) {
      continue;
    }

    return String(hour).padStart(2, '0') + String(minutes).padStart(2, '0');
  }

  return null;
}

function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = Object.assign({}, options.headers || {});
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

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function requestJson(url, options = {}) {
  const { body } = await requestBuffer(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) }
  });
  return JSON.parse(body.toString('utf8'));
}

async function fetchMobileFeedEvents() {
  const data = await requestJson(feedUrl);
  const events = Array.isArray(data.events) ? data.events : [];
  return events.filter(evt => evt && evt.id && evt.isDisplay !== false && evt.isHideFromCalendar !== true && isUpcomingEvent(evt));
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

function addMonths(date, months) {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function maxPostingDate() {
  return addMonths(new Date(`${todayInNewYork()}T00:00:00.000Z`), 2).toISOString().slice(0, 10);
}

function isUpcomingEvent(evt) {
  const today = todayInNewYork();
  const maxDate = maxPostingDate();
  const endDate = normalize(evt.eventEndDateStr || evt.eventDateStr);
  const startDate = normalize(evt.eventDateStr);
  if (startDate && startDate > maxDate) return false;
  return Boolean((endDate && endDate >= today) || (!endDate && startDate && startDate >= today));
}

function feedEventSortKey(evt) {
  return [
    normalize(evt.eventDateStr || evt.eventDate || evt.startDate || evt.date),
    getStarttimeFromTimeText([evt.startTime, evt.eventTime, evt.time].filter(Boolean).join(' ')) || '9999',
    normalize(evt.title),
    normalize(evt.id)
  ].join('|');
}

async function isLoggedInEventPage(page) {
  return page.evaluate(() => Boolean(
    document.querySelector('.rsvp__event-name') ||
    document.querySelector('#event_main_card') ||
    document.querySelector('#event_details')
  )).catch(() => false);
}

async function visibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function fillAndSignal(locator, value) {
  const canFill = await locator.evaluate(el => {
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }).catch(() => false);
  if (!canFill) return false;
  await locator.fill(value);
  await locator.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
  return true;
}

async function clickOptionalLoginLink(page) {
  const locator = await visibleLocator(page, [
    'a[href*="/cas/brooklyn"]',
    'a:has-text("BC WebCentral Login")',
    'a[href*="/cas/login"]',
    'a[href*="login.brooklyn.cuny.edu"]',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'a:has-text("Login")',
    'a:has-text("Log in")',
    'input[type="submit"]'
  ]);
  if (!locator) return false;
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
    locator.click()
  ]);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  return true;
}

async function writeLoginDebug(page, reason) {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  const debug = await page.evaluate(message => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    return {
      reason: message,
      url: window.location.href,
      title: document.title,
      alerts: Array.from(document.querySelectorAll('.alert,.error,.errors,.message,#msg,[role="alert"]'))
        .map(el => clean(el.textContent).slice(0, 300))
        .filter(Boolean),
      visibleActions: Array.from(document.querySelectorAll('a,button,input[type="submit"],input[type="button"]'))
        .filter(el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          href: el.getAttribute('href') || '',
          id: el.id || '',
          name: el.getAttribute('name') || '',
          text: clean(el.textContent || el.getAttribute('value') || '').slice(0, 120)
        }))
        .slice(0, 40),
      forms: Array.from(document.forms).map((form, formIndex) => ({
        formIndex,
        action: form.getAttribute('action') || '',
        method: form.getAttribute('method') || '',
        inputs: Array.from(form.querySelectorAll('input, button, select')).map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          text: clean(el.textContent || el.getAttribute('value') || '').slice(0, 80),
          visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
        }))
      })),
      bodyText: clean(document.body?.innerText || '').slice(0, 1000)
    };
  }, reason);
  const outputPath = path.join(ARTIFACTS_DIR, 'login-debug.json');
  await fs.writeFile(outputPath, JSON.stringify(debug, null, 2) + '\n', 'utf8');
  console.log(`Wrote sanitized login debug to ${outputPath}`);
}

async function loginIfNeeded(page, returnUrl = eventPageUrl('374921')) {
  if (await isLoggedInEventPage(page)) return;

  if (!username || !password) {
    throw new Error('Set BC_WEBCENTRAL_USERNAME and BC_WEBCENTRAL_PASSWORD before running.');
  }

  if (!/\/cas\/login|\/webapp\/auth\/login|login/i.test(page.url())) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const title = await page.title().catch(() => page.url());
    console.log(`Login attempt ${attempt}: ${title} (${page.url()})`);
    const passwordInput = await visibleLocator(page, [
      '#password',
      '[name="password"]',
      'input[type="password"]',
      'input[name*="pass" i]',
      'input[id*="pass" i]'
    ]);
    const usernameInput = await visibleLocator(page, [
      '#username',
      '[name="username"]',
      'input[type="email"]',
      'input[name="user"]',
      'input[name="j_username"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
      'input[name*="empl" i]',
      'input[id*="empl" i]',
      'input[type="text"]'
    ]);

    if (!usernameInput && !passwordInput) {
      if (await isLoggedInEventPage(page)) return;
      if (!(await clickOptionalLoginLink(page))) {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      }
      continue;
    }

    const filledUsername = usernameInput ? await fillAndSignal(usernameInput, username) : false;
    const filledPassword = passwordInput ? await fillAndSignal(passwordInput, password) : false;
    if (!filledUsername && !filledPassword) {
      if (!(await clickOptionalLoginLink(page))) {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      }
      continue;
    }

    const submit = await visibleLocator(page, [
      '#submit',
      'button[name="submit"]',
      'input[name="submit"]',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
      'input[value*="Log" i]',
      'input[value*="Sign" i]',
      'input[value*="Continue" i]'
    ]);

    if (submit) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        submit.click()
      ]);
    } else if (passwordInput) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        passwordInput.press('Enter')
      ]);
    } else if (usernameInput) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        usernameInput.press('Enter')
      ]);
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (/\/cas\/login/i.test(page.url())) {
      const errorText = await page.locator('.alert,.error,.errors,#msg,[role="alert"]').first().textContent({ timeout: 1000 }).catch(() => '');
      if (errorText) console.log(`CAS page message: ${String(errorText).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    if (/\/cas\/brooklyn|\/webapp\/auth\/login/i.test(page.url())) {
      await page.waitForURL(/clubs\.brooklyn\.cuny\.edu/i, { timeout: 15000 }).catch(() => {});
    }
    if (await isLoggedInEventPage(page)) return;

    await page.goto(returnUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    if (await isLoggedInEventPage(page)) return;
  }

  const title = await page.title().catch(() => '');
  await writeLoginDebug(page, `Login did not reach CampusGroups: ${title || page.url()}`);
  throw new Error(`Login did not reach the CampusGroups page. Current page: ${title || page.url()}`);
}

async function parseEventPage(page, sourceUrl) {
  return page.evaluate(url => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const getText = selector => clean(document.querySelector(selector)?.textContent || '');
    const title = getText('.rsvp__event-name');
    const orgRoot = document.querySelector('.rsvp__event-org');
    const club = clean(orgRoot?.querySelector('.btn-link')?.textContent || orgRoot?.textContent || '');
    const dateParts = document.querySelectorAll('.card-block .col-md-4_5 p');
    const rawDate = clean(dateParts[0]?.textContent || '');
    const time = clean((dateParts[1]?.textContent || '').replace(/EDT.*$/i, '').replace(/EST.*$/i, ''));
    const locationParts = document.querySelectorAll('.card-block .col-md-5 p');
    const room = clean(locationParts[0]?.textContent || '');
    const descriptionBlock = document.querySelector('#event_details .card-block');
    let description = '';
    if (descriptionBlock) {
      const clone = descriptionBlock.cloneNode(true);
      clone.querySelectorAll('.card-block__title,.card-border,.text-center,button,[style*="margin"]').forEach(node => node.remove());
      description = clean(clone.textContent || '');
    }
    let flyerEl = document.querySelector('#event_details img[src*="upload"]');
    if (!flyerEl) flyerEl = document.querySelector('#event_main_card img[src*="upload"]');
    const flyerUrl = flyerEl ? new URL(flyerEl.getAttribute('src') || flyerEl.src, url).href : '';

    return { title, club, rawDate, time, room, description, flyerUrl, sourceUrl: url };
  }, sourceUrl);
}

function dateFromRaw(rawDate) {
  const text = decodeEntities(rawDate);
  const match = text.match(/(?:\w+,\s*)?(\w+)\s*(\d{1,2}),\s*(\d{4})/);
  if (!match) return '';
  const months = {
    Jan: '01', January: '01', Feb: '02', February: '02', Mar: '03', March: '03',
    Apr: '04', April: '04', May: '05', Jun: '06', June: '06', Jul: '07', July: '07',
    Aug: '08', August: '08', Sep: '09', September: '09', Oct: '10', October: '10',
    Nov: '11', November: '11', Dec: '12', December: '12'
  };
  const month = months[match[1]];
  return month ? `${match[3]}-${month}-${match[2].padStart(2, '0')}` : '';
}

function roomFromFeed(evt) {
  return decodeEntities([
    evt.event_location,
    evt.event_address,
    evt.event_city,
    evt.event_state,
    evt.event_zipcode
  ].filter(Boolean).join(', '));
}

function mergeEvent(feedEvent, pageEvent) {
  const cgId = String(feedEvent.id);
  const sourceUrl = eventPageUrl(cgId);
  const date = feedEvent.eventDateStr || dateFromRaw(pageEvent.rawDate || feedEvent.eventDate);
  const time = decodeEntities(pageEvent.time || [feedEvent.startTime, feedEvent.endTime].filter(Boolean).join(' - '));
  const flyerUrl = absoluteUrl(pageEvent.flyerUrl || feedEvent.eventFlyer || '', sourceUrl);
  const event = {
    eventId: `c_${cgId}`,
    cgId,
    title: decodeEntities(pageEvent.title || feedEvent.title),
    date,
    time,
    starttime: getStarttimeFromTimeText(time),
    room: decodeEntities(pageEvent.room || roomFromFeed(feedEvent)),
    type: 'club event',
    description: decodeEntities(pageEvent.description || feedEvent.eventDescription || ''),
    club: decodeEntities(pageEvent.club || feedEvent.groupName || ''),
    clubId: '',
    flyer: hasNativeFlyerUrl(flyerUrl) ? flyerUrl : '',
    flyerPath: '',
    flyerIcon: '',
    flyerIconPath: '',
    links: [{ label: 'Register/Info', url: sourceUrl }],
    confirmed: 1
  };
  return event;
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

function firestoreDocumentUrl(docId) {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/events/${encodeURIComponent(docId)}`);
  url.searchParams.set('key', FIREBASE_CONFIG.apiKey);
  return url.toString();
}

function firestoreCollectionUrl(collectionName, pageToken = '') {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${collectionName}`);
  url.searchParams.set('key', FIREBASE_CONFIG.apiKey);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

function storageUploadUrl(storagePath) {
  const url = new URL(`https://firebasestorage.googleapis.com/v0/b/${FIREBASE_CONFIG.storageBucket}/o`);
  url.searchParams.set('uploadType', 'media');
  url.searchParams.set('name', storagePath);
  return url.toString();
}

function storagePublicUrl(storagePath, token) {
  const url = new URL(`https://firebasestorage.googleapis.com/v0/b/${FIREBASE_CONFIG.storageBucket}/o/${encodeURIComponent(storagePath)}`);
  url.searchParams.set('alt', 'media');
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function storageObjectUrl(storagePath) {
  const url = new URL(`https://firebasestorage.googleapis.com/v0/b/${FIREBASE_CONFIG.storageBucket}/o/${encodeURIComponent(storagePath)}`);
  url.searchParams.set('key', FIREBASE_CONFIG.apiKey);
  return url.toString();
}

function storageListUrl(prefix) {
  const url = new URL(`https://firebasestorage.googleapis.com/v0/b/${FIREBASE_CONFIG.storageBucket}/o`);
  url.searchParams.set('key', FIREBASE_CONFIG.apiKey);
  url.searchParams.set('prefix', prefix);
  return url.toString();
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL returned from browser compression.');
  return {
    contentType: match[1],
    body: Buffer.from(match[2], 'base64')
  };
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

function normalizeLookupKey(value) {
  return decodeEntities(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(the|club|student|association|organization|society|inc)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function lookupAliases(value) {
  const text = decodeEntities(value);
  const aliases = new Set([normalizeLookupKey(text)]);
  const noParen = normalizeLookupKey(text.replace(/\([^)]*\)/g, ' '));
  if (noParen) aliases.add(noParen);
  for (const match of text.matchAll(/\(([^)]+)\)/g)) {
    const alias = normalizeLookupKey(match[1]);
    if (alias) aliases.add(alias);
  }
  const acronym = normalizeLookupKey(text).split(/\s+/).filter(Boolean).map(word => word[0]).join('');
  if (acronym.length >= 2) aliases.add(acronym);
  return [...aliases].filter(Boolean);
}

function normalizeTitleForMatch(value) {
  return decodeEntities(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildOrgLookup(...docGroups) {
  const lookup = new Map();
  for (const docs of docGroups) {
    for (const doc of docs) {
      const data = { ...(doc.data || {}), _docId: doc.id };
      const names = [
        doc.id,
        data.name,
        data.title,
        data.club,
        data.org,
        data.groupName,
        data.displayName,
        data.clubId,
        data.campusGroupsClubId,
        data.sourceId
      ];
      for (const name of names) {
        for (const key of lookupAliases(name)) {
          const prior = lookup.get(key);
          if (!prior || (!hasLogoRef(prior) && hasLogoRef(data))) lookup.set(key, data);
        }
      }
    }
  }
  return lookup;
}

function findLogoUrl(data) {
  return data.icon || data.logo || data.featuredImage || data.image || data.photo || '';
}

function hasLogoRef(data) {
  return Boolean(findLogoUrl(data) || storagePathCandidates(data).length);
}

function storagePathCandidates(data) {
  return [
    data.iconPath,
    data.logoPath,
    data.featuredImagePath,
    data.imagePath,
    data.photoPath
  ].map(normalize).filter(Boolean);
}

function storagePathFromMaybeUrl(value) {
  const text = normalize(value);
  if (!text) return '';
  if (/^gs:\/\//i.test(text)) return text.replace(/^gs:\/\/[^/]+\//i, '');
  const match = text.match(/\/o\/([^?]+)/);
  return match ? decodeURIComponent(match[1]) : (/^https?:\/\//i.test(text) ? '' : text);
}

async function publicUrlForStoragePath(storagePath) {
  const meta = await requestJson(storageObjectUrl(storagePath));
  return {
    url: storagePublicUrl(meta.name || storagePath, meta.downloadTokens),
    path: meta.name || storagePath
  };
}

function storageIdCandidates(data) {
  const raw = [data._docId, data.clubId, data.name].map(normalize).filter(Boolean);
  const aliases = [data._docId, data.clubId, data.name].flatMap(lookupAliases);
  return [...new Set([...raw, ...aliases])];
}

async function findFirstClubStorageLogo(data) {
  const ids = storageIdCandidates(data);
  const prefixes = [...new Set(ids.map(id => `clubs/${id}/`))];
  for (const prefix of prefixes) {
    try {
      const listing = await requestJson(storageListUrl(prefix));
      const item = (listing.items || [])
        .filter(entry => /^image\//i.test(entry.contentType || '') || /\.(png|jpe?g|webp)$/i.test(entry.name || ''))
        .sort((a, b) => Number(Boolean(/icon/i.test(b.name || ''))) - Number(Boolean(/icon/i.test(a.name || ''))))[0];
      if (item?.name) return publicUrlForStoragePath(item.name);
    } catch (err) {
      console.warn(`Could not list Storage prefix ${prefix}: ${err.message.split('\n')[0]}`);
    }
  }
  return null;
}

async function resolveClubLogo(data) {
  const url = findLogoUrl(data);
  if (/^https?:\/\//i.test(url)) return { url, path: storagePathCandidates(data)[0] || storagePathFromMaybeUrl(url) };
  const urlStoragePath = storagePathFromMaybeUrl(url);
  if (urlStoragePath) {
    try {
      return await publicUrlForStoragePath(urlStoragePath);
    } catch (err) {
      console.warn(`Could not read logo metadata at ${urlStoragePath}: ${err.message.split('\n')[0]}`);
    }
  }

  for (const storagePath of storagePathCandidates(data)) {
    try {
      return await publicUrlForStoragePath(storagePath);
    } catch (err) {
      console.warn(`Could not read logo metadata at ${storagePath}: ${err.message.split('\n')[0]}`);
    }
  }

  return findFirstClubStorageLogo(data);
}

async function findOrgLogo(clubName, orgLookup) {
  const direct = lookupAliases(clubName).map(key => orgLookup.get(key)).find(Boolean);
  if (!direct) return null;
  const logo = await resolveClubLogo(direct);
  return logo ? { ...logo, org: direct } : null;
}

async function fetchFlyerSource(page, flyerUrl) {
  const response = await page.request.get(flyerUrl, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  });
  if (!response.ok()) throw new Error(`flyer download HTTP ${response.status()}`);

  const contentType = (response.headers()['content-type'] || 'image/jpeg').split(';')[0].trim();
  if (!/^image\/(jpeg|jpg|png|webp|gif)/i.test(contentType)) {
    throw new Error(`Unexpected flyer content type ${contentType || 'unknown'}`);
  }

  const body = await response.body();
  return {
    dataUrl: `data:${contentType};base64,${body.toString('base64')}`,
    bytes: body.length,
    contentType
  };
}

async function compressFlyerImages(page, flyerSource) {
  return page.evaluate(async ({ dataUrl, sourceBytes, sourceContentType, fullMaxPx, fullQuality, iconSizePx }) => {
    const sourceBlob = await fetch(dataUrl).then(response => response.blob());
    const bitmap = await createImageBitmap(sourceBlob);
    const render = async (maxPx, quality) => {
      const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      return {
        width,
        height,
        dataUrl: canvas.toDataURL('image/jpeg', quality)
      };
    };

    const renderIcon = () => {
      const canvas = document.createElement('canvas');
      canvas.width = iconSizePx;
      canvas.height = iconSizePx;
      const scale = iconSizePx / Math.min(bitmap.width, bitmap.height);
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, -(width - iconSizePx) / 2, -(height - iconSizePx) / 2, width, height);
      return {
        width: iconSizePx,
        height: iconSizePx,
        dataUrl: canvas.toDataURL('image/png')
      };
    };

    const full = await render(fullMaxPx, fullQuality);
    const icon = renderIcon();
    bitmap.close?.();
    return {
      sourceBytes,
      sourceContentType,
      full,
      icon
    };
  }, {
    dataUrl: flyerSource.dataUrl,
    sourceBytes: flyerSource.bytes,
    sourceContentType: flyerSource.contentType,
    fullMaxPx: FULL_FLYER_MAX_PX,
    fullQuality: FULL_FLYER_QUALITY,
    iconSizePx: ICON_SIZE_PX
  });
}

async function uploadStorageData(storagePath, dataUrl) {
  const { body, contentType } = dataUrlToBuffer(dataUrl);
  const upload = await requestJson(storageUploadUrl(storagePath), {
    method: 'POST',
    body,
    headers: { 'Content-Type': contentType }
  });
  return {
    url: storagePublicUrl(upload.name || storagePath, upload.downloadTokens),
    path: upload.name || storagePath,
    bytes: body.length
  };
}

async function uploadFlyerIfAvailable(page, event) {
  if (!event.flyer || dryRun) return event;
  if (event._fallbackLogo) return event;

  try {
    const sourceUrl = event.flyer;
    const flyerSource = await fetchFlyerSource(page, sourceUrl);
    const compressed = await compressFlyerImages(page, flyerSource);
    const full = await uploadStorageData(`events/${event.eventId}/flyer.jpg`, compressed.full.dataUrl);
    event.flyer = full.url;
    event.flyerPath = full.path;
    console.log(`Uploaded compressed flyer for ${event.eventId}: ${compressed.sourceBytes} ${compressed.sourceContentType} -> ${full.bytes} bytes at ${full.path}`);

    try {
      const icon = await uploadStorageData(`events/${event.eventId}/flyerIcon.png`, compressed.icon.dataUrl);
      event.flyerIcon = icon.url;
      event.flyerIconPath = icon.path;
      console.log(`Uploaded flyer icon for ${event.eventId}: ${icon.bytes} bytes at ${icon.path}`);
    } catch (iconErr) {
      console.warn(`Flyer icon upload failed for ${event.eventId}: ${iconErr.message.split('\n')[0]}`);
    }
  } catch (err) {
    console.warn(`Flyer download/compression/upload failed for ${event.eventId}: ${err.message.split('\n')[0]}`);
  }

  return event;
}

async function uploadEvent(event) {
  const { _fallbackLogo, ...cleanEvent } = event;
  const docData = {
    ...cleanEvent,
    createdAt: { __serverTimestamp: true }
  };
  const fields = firestoreFields(docData);
  fields.createdAt = { timestampValue: new Date().toISOString() };
  await requestJson(firestoreDocumentUrl(event.eventId), {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
    headers: { 'Content-Type': 'application/json' }
  });
}

async function archiveBrooklynEventsMatchingClubTitles(eventDocs, clubEvents) {
  const uploadedTitleSet = new Set(clubEvents.map(event => normalizeTitleForMatch(event.title)).filter(Boolean));
  if (!uploadedTitleSet.size) return [];

  const matches = eventDocs
    .filter(doc => {
      const eventId = normalize(doc.data.eventId || doc.id);
      const type = normalize(doc.data.type).toLowerCase();
      return eventId.startsWith('b_') || type === 'brooklyn event';
    })
    .filter(doc => uploadedTitleSet.has(normalizeTitleForMatch(doc.data.title)))
    .filter(doc => doc.data.archived !== true);

  for (const match of matches) {
    if (dryRun) {
      console.log(`DRY RUN archive ${match.id}: Brooklyn event title matches uploaded club event "${match.data.title || ''}"`);
      continue;
    }
    await requestJson(firestoreDocumentUrl(match.id), {
      method: 'PATCH',
      body: JSON.stringify({
        fields: {
          archived: { booleanValue: true },
          updatedAt: { timestampValue: new Date().toISOString() }
        }
      }),
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`Archived ${match.id}: Brooklyn event title matches uploaded club event "${match.data.title || ''}"`);
  }

  return matches;
}

async function main() {
  console.log(`Fetching mobile calendar JSON from ${feedUrl}`);
  const [feedEvents, existingEvents, clubDocs, orgDocs] = await Promise.all([
    fetchMobileFeedEvents(),
    fetchCollection('events'),
    fetchCollection('clubs'),
    fetchCollection('orgs')
  ]);
  const orgLookup = buildOrgLookup(clubDocs, orgDocs);
  console.log(`Feed returned ${feedEvents.length} upcoming displayable events. Past events are ignored and are never archived/deleted just because they disappear from the JSON feed.`);
  if (!feedEvents.length) throw new Error('No upcoming events found in the mobile calendar feed.');

  const selected = [...feedEvents].sort((a, b) => feedEventSortKey(a).localeCompare(feedEventSortKey(b))).slice(0, limit);
  console.log(`Selected next ${selected.length} events. Hard cap is ${MAX_ACTION_EVENTS}.`);

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  const uploaded = [];
  const failed = [];

  try {
    const firstUrl = eventPageUrl(selected[0].id);
    console.log(`Opening ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, firstUrl);
    await fs.mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(`Saved browser session state to ${AUTH_STATE_PATH}`);

    for (const [index, feedEvent] of selected.entries()) {
      const sourceUrl = eventPageUrl(feedEvent.id);
      try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await loginIfNeeded(page, sourceUrl);
        const pageEvent = await parseEventPage(page, sourceUrl);
        const event = mergeEvent(feedEvent, pageEvent);
        if (!hasNativeFlyerUrl(event.flyer)) {
          event.flyer = '';
          event.flyerPath = '';
          const logo = await findOrgLogo(event.club, orgLookup);
          if (logo) {
            event.flyer = logo.url;
            event.flyerPath = logo.path;
            event.flyerIcon = logo.url;
            event.flyerIconPath = logo.path;
            event.clubId = normalize(logo.org?.clubId || logo.org?._docId || event.clubId);
            event._fallbackLogo = true;
            console.log(`Using club logo as fallback flyer for ${event.eventId}: ${event.club}`);
          } else {
            console.warn(`No fallback logo found for ${event.eventId}: ${event.club || 'unknown club'}`);
          }
        }
        await uploadFlyerIfAvailable(page, event);
        if (dryRun) {
          console.log(`[${index + 1}/${selected.length}] DRY RUN ${event.eventId}: ${event.title} (${event.room || 'no location'})`);
        } else {
          await uploadEvent(event);
          console.log(`[${index + 1}/${selected.length}] Uploaded ${event.eventId}: ${event.title} (${event.room || 'no location'})`);
        }
        uploaded.push(event);
      } catch (err) {
        failed.push({ id: feedEvent.id, title: feedEvent.title, error: err.message });
        console.warn(`[${index + 1}/${selected.length}] Failed ${feedEvent.id}: ${err.message.split('\n')[0]}`);
      }
    }

    await context.storageState({ path: AUTH_STATE_PATH });
  } finally {
    await browser.close();
  }

  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(ARTIFACTS_DIR, 'scrape-summary.json'),
    JSON.stringify({ dryRun, selected: selected.length, uploaded: uploaded.length, failed }, null, 2) + '\n',
    'utf8'
  );

  if (!uploaded.length) throw new Error('No sampled events were successfully parsed/uploaded.');

  const archivedBrooklynMatches = await archiveBrooklynEventsMatchingClubTitles(existingEvents, uploaded);

  console.log('');
  console.log(`CONFIRMED: selected ${selected.length} next events, ${dryRun ? 'parsed' : 'uploaded'} ${uploaded.length}, failed ${failed.length}. Exiting before scraping anything else.`);
  if (archivedBrooklynMatches.length) {
    console.log(`${dryRun ? 'Would archive' : 'Archived'} ${archivedBrooklynMatches.length} Brooklyn.edu events with matching club-event titles.`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
