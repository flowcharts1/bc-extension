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
const ICON_SIZE_PX = 120;
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

function isUpcomingEvent(evt) {
  const today = todayInNewYork();
  const endDate = normalize(evt.eventEndDateStr || evt.eventDateStr);
  const startDate = normalize(evt.eventDateStr);
  return Boolean((endDate && endDate >= today) || (!endDate && startDate && startDate >= today));
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
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
    const club = clean(document.querySelector('.rsvp__event-org .btn-link')?.textContent || '');
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
    flyer: absoluteUrl(pageEvent.flyerUrl || feedEvent.eventFlyer || '', sourceUrl),
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

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL returned from browser compression.');
  return {
    contentType: match[1],
    body: Buffer.from(match[2], 'base64')
  };
}

async function compressFlyerImages(page, flyerUrl) {
  return page.evaluate(async ({ url, fullMaxPx, fullQuality, iconSizePx }) => {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const sourceBlob = await response.blob();
    if (!/^image\/(jpeg|png|webp|gif)/i.test(sourceBlob.type || '')) {
      throw new Error(`Unexpected content type ${sourceBlob.type || 'unknown'}`);
    }

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
      sourceBytes: sourceBlob.size,
      full,
      icon
    };
  }, {
    url: flyerUrl,
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

  try {
    const compressed = await compressFlyerImages(page, event.flyer);
    const full = await uploadStorageData(`events/${event.eventId}/flyer.jpg`, compressed.full.dataUrl);
    const icon = await uploadStorageData(`events/${event.eventId}/flyerIcon.png`, compressed.icon.dataUrl);
    event.flyer = full.url;
    event.flyerPath = full.path;
    event.flyerIcon = icon.url;
    event.flyerIconPath = icon.path;
    console.log(`Compressed flyer for ${event.eventId}: ${compressed.sourceBytes} -> ${full.bytes} bytes, icon ${icon.bytes} bytes`);
  } catch (err) {
    console.warn(`Flyer upload skipped for ${event.eventId}: ${err.message.split('\n')[0]}`);
  }

  return event;
}

async function uploadEvent(event) {
  const docData = {
    ...event,
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

async function main() {
  console.log(`Fetching mobile calendar JSON from ${feedUrl}`);
  const feedEvents = await fetchMobileFeedEvents();
  console.log(`Feed returned ${feedEvents.length} upcoming displayable events. Past events are ignored and are never archived/deleted just because they disappear from the JSON feed.`);
  if (!feedEvents.length) throw new Error('No upcoming events found in the mobile calendar feed.');

  const selected = shuffle(feedEvents).slice(0, limit);
  console.log(`Randomly selected ${selected.length} events. Hard cap is ${MAX_ACTION_EVENTS}.`);

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
        const event = await uploadFlyerIfAvailable(page, mergeEvent(feedEvent, pageEvent));
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

  console.log('');
  console.log(`CONFIRMED: sampled ${selected.length} random events, ${dryRun ? 'parsed' : 'uploaded'} ${uploaded.length}, failed ${failed.length}. Exiting before scraping anything else.`);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
