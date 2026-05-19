const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ── Storage ──

const STORE_EVENTS = 'pc_events';
const STORE_CATEGORIES = 'pc_categories';

function loadEvents() { try { return JSON.parse(localStorage.getItem(STORE_EVENTS)) || []; } catch { return []; } }
function saveEvents(list) { localStorage.setItem(STORE_EVENTS, JSON.stringify(list)); pushToCloud(); }
function loadCategories() { try { return JSON.parse(localStorage.getItem(STORE_CATEGORIES)) || []; } catch { return []; } }
function saveCategories(list) { localStorage.setItem(STORE_CATEGORIES, JSON.stringify(list)); pushToCloud(); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ═══════════════════════════════════════════
// FIREBASE AUTH & SYNC
// ═══════════════════════════════════════════

let currentUser = null;
let unsubFirestore = null;
let lastSyncJSON = '';

const firebaseReady = typeof FIREBASE_CONFIG !== 'undefined' && FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';

if (firebaseReady) {
    firebase.initializeApp(FIREBASE_CONFIG);
    const auth = firebase.auth();
    const db = firebase.firestore();

    auth.onAuthStateChanged(user => {
        currentUser = user;
        updateAuthUI();
        if (user) startSync(); else stopSync();
    });

    function handleSignIn() {
        const provider = new firebase.auth.GoogleAuthProvider();
        const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        if (mobile) {
            auth.signInWithRedirect(provider);
        } else {
            auth.signInWithPopup(provider).catch(err => {
                if (err.code === 'auth/popup-blocked') auth.signInWithRedirect(provider);
            });
        }
    }

    function handleSignOut() {
        if (confirm('Sign out? Your events stay on this device.')) auth.signOut();
    }

    function startSync() {
        if (!currentUser) return;
        const docRef = db.collection('users').doc(currentUser.uid);

        docRef.get().then(snap => {
            if (!snap.exists) {
                pushToCloud();
            } else {
                mergeFromCloud(snap.data());
            }
        }).catch(() => {});

        unsubFirestore = docRef.onSnapshot(snap => {
            if (!snap.exists || !snap.metadata.hasPendingWrites === false) return;
            const data = snap.data();
            const json = JSON.stringify([data.events, data.categories]);
            if (json === lastSyncJSON) return;
            lastSyncJSON = json;
            if (data.events) localStorage.setItem(STORE_EVENTS, JSON.stringify(data.events));
            if (data.categories) localStorage.setItem(STORE_CATEGORIES, JSON.stringify(data.categories));
            refreshCurrentScreen();
        }, () => {});
    }

    function stopSync() {
        if (unsubFirestore) { unsubFirestore(); unsubFirestore = null; }
        lastSyncJSON = '';
    }

    function mergeFromCloud(cloudData) {
        const localEvts = loadEvents();
        const localCats = loadCategories();
        const cloudEvts = cloudData.events || [];
        const cloudCats = cloudData.categories || [];

        const evtKeys = new Set();
        const merged = [];
        for (const ev of [...cloudEvts, ...localEvts]) {
            const key = `${ev.name}|${ev.startDate}|${ev.endDate}`;
            if (!evtKeys.has(key)) { evtKeys.add(key); merged.push(ev); }
        }

        const catNames = new Set();
        const mergedCats = [];
        for (const cat of [...cloudCats, ...localCats]) {
            if (!catNames.has(cat.name)) { catNames.add(cat.name); mergedCats.push(cat); }
        }

        localStorage.setItem(STORE_EVENTS, JSON.stringify(merged));
        localStorage.setItem(STORE_CATEGORIES, JSON.stringify(mergedCats));
        pushToCloud();
        refreshCurrentScreen();
    }
}

function pushToCloud() {
    if (!firebaseReady || !currentUser) return;
    const data = { events: loadEvents(), categories: loadCategories() };
    lastSyncJSON = JSON.stringify([data.events, data.categories]);
    firebase.firestore().collection('users').doc(currentUser.uid).set({
        ...data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
}

function updateAuthUI() {
    const btn = $('#header-auth');
    const icon = $('#auth-icon-guest');
    const avatar = $('#auth-avatar');
    const banner = $('#sync-banner');
    const bannerText = $('#sync-text');

    if (!firebaseReady) {
        btn.classList.add('hidden');
        banner.classList.add('hidden');
        return;
    }

    if (currentUser) {
        icon.classList.add('hidden');
        if (currentUser.photoURL) {
            avatar.src = currentUser.photoURL;
            avatar.classList.remove('hidden');
        }
        btn.classList.add('signed-in');
        banner.classList.add('signed-in');
        bannerText.textContent = `Synced as ${currentUser.displayName || currentUser.email}`;
        banner.onclick = null;
    } else {
        icon.classList.remove('hidden');
        avatar.classList.add('hidden');
        btn.classList.remove('signed-in');
        banner.classList.remove('signed-in');
        bannerText.textContent = 'Sign in to sync across devices';
        banner.onclick = () => handleSignIn();
    }
}

function refreshCurrentScreen() {
    if (currentScreen === 'calendar') renderCalendar();
    if (currentScreen === 'categories') renderCategories();
}

// ── Helpers ──

function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDate(iso) {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function daysDiff(a, b) { return (new Date(b) - new Date(a)) / 86400000; }
function sanitizeName(n) { return n.replace(/[<>:"/\\|?*]/g, '_').trim().replace(/^\.+|\.+$/g, '').slice(0, 200); }

// ── ICS Parser ──

function parseICS(text) {
    const result = [];
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    let inEvent = false, ev = {};

    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') { inEvent = true; ev = {}; continue; }
        if (line === 'END:VEVENT') {
            inEvent = false;
            if (ev.start) {
                if (!ev.end) ev.end = ev.start;
                result.push({ name: ev.summary || 'Untitled Event', start: ev.start, end: ev.end, isAllDay: ev.isAllDay });
            }
            continue;
        }
        if (!inEvent) continue;

        if (line.startsWith('SUMMARY:') || line.startsWith('SUMMARY;')) {
            ev.summary = line.substring(line.indexOf(':') + 1).trim();
        } else if (line.startsWith('DTSTART')) {
            const parsed = parseICSDate(line);
            if (parsed) { ev.start = parsed.date; ev.isAllDay = parsed.isAllDay; }
        } else if (line.startsWith('DTEND')) {
            const parsed = parseICSDate(line);
            if (parsed) ev.end = parsed.date;
        }
    }

    for (const e of result) {
        if (e.isAllDay && e.end > e.start) {
            const d = new Date(e.end + 'T00:00:00');
            d.setDate(d.getDate() - 1);
            e.end = isoDate(d);
        }
    }
    return result;
}

function parseICSDate(line) {
    const m = line.match(/(\d{8})(?:T(\d{6}))?/);
    if (!m) return null;
    const ds = m[1];
    const isAllDay = !m[2] || line.includes('VALUE=DATE');
    return { date: `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`, isAllDay };
}

function importICSFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const parsed = parseICS(e.target.result);
            if (!parsed.length) { alert('No events found in this file.'); return; }

            const existing = loadEvents();
            const existingKeys = new Set(existing.map(ev => `${ev.name}|${ev.startDate}|${ev.endDate}`));
            let added = 0;

            for (const ev of parsed) {
                const key = `${ev.name}|${ev.start}|${ev.end}`;
                if (!existingKeys.has(key)) {
                    existing.push({ id: genId(), name: ev.name, startDate: ev.start, endDate: ev.end, categoryId: '' });
                    existingKeys.add(key);
                    added++;
                }
            }

            saveEvents(existing);
            alert(`Imported ${added} new event${added !== 1 ? 's' : ''}${parsed.length - added > 0 ? ` (${parsed.length - added} duplicates skipped)` : ''}.`);
            renderCalendar();
        } catch (err) {
            alert('Error parsing ICS file: ' + err.message);
        }
    };
    reader.readAsText(file);
}

// ── Screen Navigation ──

let currentScreen = 'home';
const screenStack = [];

function showScreen(id) {
    screenStack.push(currentScreen);
    currentScreen = id;
    $$('.screen').forEach(s => s.classList.add('hidden'));
    $(`#screen-${id}`).classList.remove('hidden');
    updateHeader();
    if (id === 'calendar') renderCalendar();
    if (id === 'categories') renderCategories();
}

function goBack() {
    if (!screenStack.length) return;
    currentScreen = screenStack.pop();
    $$('.screen').forEach(s => s.classList.add('hidden'));
    $(`#screen-${currentScreen}`).classList.remove('hidden');
    updateHeader();
    if (currentScreen === 'calendar') renderCalendar();
    if (currentScreen === 'event-form') refreshCategorySelect();
}

function updateHeader() {
    const back = $('#header-back');
    const title = $('#header-title');
    const action = $('#header-action');

    back.classList.toggle('hidden', currentScreen === 'home');
    action.classList.add('hidden');
    action.onclick = null;

    switch (currentScreen) {
        case 'home':
            title.textContent = 'Photo Calendar';
            break;
        case 'calendar':
            title.textContent = 'My Calendar';
            action.textContent = '+';
            action.classList.remove('hidden');
            action.onclick = () => openEventForm();
            break;
        case 'event-form':
            title.textContent = editingEventId ? 'Edit Event' : 'Add Event';
            break;
        case 'categories':
            title.textContent = 'Categories';
            break;
        case 'classify':
            title.textContent = 'Classify Photos';
            break;
    }
}

// ═══════════════════════════════════════════
// CALENDAR MODULE
// ═══════════════════════════════════════════

let calView = 'list';
let gridYear, gridMonth;

function initGridMonth() {
    const now = new Date();
    gridYear = now.getFullYear();
    gridMonth = now.getMonth();
}

function renderCalendar() {
    if (calView === 'list') {
        $('#cal-list-view').classList.remove('hidden');
        $('#cal-grid-view').classList.add('hidden');
        renderEventListView();
    } else {
        $('#cal-list-view').classList.add('hidden');
        $('#cal-grid-view').classList.remove('hidden');
        renderCalendarGrid();
    }
}

// ── List View ──

function renderEventListView() {
    const evts = loadEvents();
    const cats = loadCategories();
    const catMap = Object.fromEntries(cats.map(c => [c.id, c]));
    const list = $('#cal-event-list');
    const empty = $('#cal-empty');

    if (!evts.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    evts.sort((a, b) => a.startDate.localeCompare(b.startDate));

    const grouped = {};
    for (const ev of evts) {
        const key = ev.startDate.slice(0, 7);
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(ev);
    }

    list.innerHTML = '';
    for (const [month, items] of Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b))) {
        const label = new Date(month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const sec = document.createElement('div');
        sec.className = 'month-section';
        sec.innerHTML = `<div class="month-header">${label}</div>`;

        for (const ev of items) {
            const cat = catMap[ev.categoryId];
            const row = document.createElement('div');
            row.className = 'event-row';
            row.innerHTML = `
                ${cat ? `<span class="cat-dot" style="background:${cat.color}"></span>` : ''}
                <div class="event-info">
                    <span class="event-name">${ev.name}</span>
                    <span class="event-dates">${fmtDate(ev.startDate)} — ${fmtDate(ev.endDate)}</span>
                </div>
                ${cat ? `<span class="cat-label">${cat.name}</span>` : ''}`;
            row.addEventListener('click', () => openEventForm(ev.id));
            sec.appendChild(row);
        }
        list.appendChild(sec);
    }
}

// ── Grid View ──

function renderCalendarGrid() {
    const label = new Date(gridYear, gridMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    $('#month-label').textContent = label;

    const container = $('#cal-days');
    container.innerHTML = '';
    $('#day-events').classList.add('hidden');

    const firstDow = (new Date(gridYear, gridMonth, 1).getDay() + 6) % 7;
    const lastDate = new Date(gridYear, gridMonth + 1, 0).getDate();

    const evts = loadEvents();
    const cats = loadCategories();
    const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

    const monthStr = `${gridYear}-${String(gridMonth + 1).padStart(2, '0')}`;
    const dateEvts = {};
    for (const ev of evts) {
        const s = new Date(ev.startDate + 'T00:00:00');
        const e = new Date(ev.endDate + 'T00:00:00');
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
            const key = isoDate(d);
            if (key.startsWith(monthStr)) {
                if (!dateEvts[key]) dateEvts[key] = [];
                dateEvts[key].push(ev);
            }
        }
    }

    for (let i = 0; i < firstDow; i++) {
        const c = document.createElement('div');
        c.className = 'day-cell empty';
        container.appendChild(c);
    }

    const today = isoDate(new Date());

    for (let d = 1; d <= lastDate; d++) {
        const ds = `${monthStr}-${String(d).padStart(2, '0')}`;
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        if (ds === today) cell.classList.add('today');
        cell.innerHTML = `<span class="day-num">${d}</span>`;

        const dayList = dateEvts[ds];
        if (dayList && dayList.length) {
            cell.classList.add('has-events');
            const dots = document.createElement('div');
            dots.className = 'event-dots';
            const unique = [...new Set(dayList.map(e => e.categoryId || ''))];
            unique.slice(0, 3).forEach(cid => {
                const dot = document.createElement('span');
                dot.className = 'dot';
                const cat = catMap[cid];
                dot.style.background = cat ? cat.color : '#9CA3AF';
                dots.appendChild(dot);
            });
            cell.appendChild(dots);
        }

        cell.addEventListener('click', () => showDayEvents(ds));
        container.appendChild(cell);
    }
}

function showDayEvents(dateStr) {
    const panel = $('#day-events');
    const evts = loadEvents().filter(e => dateStr >= e.startDate && dateStr <= e.endDate);
    const cats = loadCategories();
    const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

    if (!evts.length) { panel.classList.add('hidden'); return; }

    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="day-events-header">${fmtDate(dateStr)}</div>`;
    for (const ev of evts) {
        const cat = catMap[ev.categoryId];
        const row = document.createElement('div');
        row.className = 'event-row compact';
        row.innerHTML = `${cat ? `<span class="cat-dot" style="background:${cat.color}"></span>` : ''}<span class="event-name">${ev.name}</span>`;
        row.addEventListener('click', () => openEventForm(ev.id));
        panel.appendChild(row);
    }
}

function changeMonth(delta) {
    gridMonth += delta;
    if (gridMonth > 11) { gridMonth = 0; gridYear++; }
    if (gridMonth < 0) { gridMonth = 11; gridYear--; }
    renderCalendarGrid();
}

// ═══════════════════════════════════════════
// EVENT FORM
// ═══════════════════════════════════════════

let editingEventId = null;

function openEventForm(eventId) {
    editingEventId = eventId || null;
    refreshCategorySelect();

    if (editingEventId) {
        const ev = loadEvents().find(e => e.id === editingEventId);
        if (ev) {
            $('#ev-name').value = ev.name;
            $('#ev-start').value = ev.startDate;
            $('#ev-end').value = ev.endDate;
            $('#ev-category').value = ev.categoryId || '';
            $('#ev-delete').classList.remove('hidden');
        }
    } else {
        $('#ev-name').value = '';
        $('#ev-start').value = '';
        $('#ev-end').value = '';
        $('#ev-category').value = '';
        $('#ev-delete').classList.add('hidden');
    }
    showScreen('event-form');
}

function refreshCategorySelect() {
    const select = $('#ev-category');
    const current = select.value;
    select.innerHTML = '<option value="">No category</option>';
    loadCategories().forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
    });
    select.value = current;
}

function saveEvent() {
    const name = $('#ev-name').value.trim();
    const start = $('#ev-start').value;
    const end = $('#ev-end').value;
    const catId = $('#ev-category').value;

    if (!name) { alert('Enter an event name.'); return; }
    if (!start) { alert('Select a start date.'); return; }
    if (!end) { alert('Select an end date.'); return; }
    if (end < start) { alert('End date must be after start date.'); return; }

    const evts = loadEvents();
    if (editingEventId) {
        const idx = evts.findIndex(e => e.id === editingEventId);
        if (idx >= 0) evts[idx] = { ...evts[idx], name, startDate: start, endDate: end, categoryId: catId };
    } else {
        evts.push({ id: genId(), name, startDate: start, endDate: end, categoryId: catId });
    }
    saveEvents(evts);
    goBack();
}

function deleteEvent() {
    if (!editingEventId || !confirm('Delete this event?')) return;
    saveEvents(loadEvents().filter(e => e.id !== editingEventId));
    editingEventId = null;
    goBack();
}

// ═══════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════

const PRESET_COLORS = ['#6366F1', '#8B5CF6', '#EC4899', '#F43F5E', '#F59E0B', '#10B981', '#06B6D4', '#64748B'];
let selectedColor = PRESET_COLORS[0];

function renderCategories() {
    const cats = loadCategories();
    const list = $('#cat-list');
    list.innerHTML = '';

    if (!cats.length) {
        list.innerHTML = '<div class="empty-state">No categories yet.</div>';
    } else {
        cats.forEach(cat => {
            const row = document.createElement('div');
            row.className = 'cat-row';
            row.innerHTML = `<span class="cat-dot" style="background:${cat.color}"></span><span class="cat-name">${cat.name}</span><button class="btn-icon" data-id="${cat.id}">&times;</button>`;
            row.querySelector('.btn-icon').addEventListener('click', () => deleteCategory(cat.id));
            list.appendChild(row);
        });
    }
    renderColorPicker();
}

function renderColorPicker() {
    const grid = $('#color-picker');
    grid.innerHTML = '';
    PRESET_COLORS.forEach(color => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'color-btn';
        if (color === selectedColor) btn.classList.add('selected');
        btn.style.background = color;
        btn.addEventListener('click', () => {
            selectedColor = color;
            $$('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
        grid.appendChild(btn);
    });
}

function addCategory() {
    const input = $('#new-cat-name');
    const name = input.value.trim();
    if (!name) return;
    const cats = loadCategories();
    cats.push({ id: genId(), name, color: selectedColor });
    saveCategories(cats);
    input.value = '';
    renderCategories();
}

function deleteCategory(id) {
    if (!confirm('Delete this category?')) return;
    saveCategories(loadCategories().filter(c => c.id !== id));
    const evts = loadEvents();
    let changed = false;
    evts.forEach(e => { if (e.categoryId === id) { e.categoryId = ''; changed = true; } });
    if (changed) saveEvents(evts);
    renderCategories();
}

// ═══════════════════════════════════════════
// CLASSIFICATION
// ═══════════════════════════════════════════

let photos = [];
let classifyEvents = [];
let classification = [];

// ── EXIF Reader ──

function readExifDate(file) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const view = new DataView(e.target.result);
                if (view.getUint16(0) !== 0xFFD8) { resolve(null); return; }
                let offset = 2;
                while (offset < view.byteLength - 2) {
                    const marker = view.getUint16(offset);
                    if (marker === 0xFFE1) {
                        const d = parseExifApp1(view, offset + 4);
                        if (d) { resolve(d); return; }
                        break;
                    }
                    if ((marker & 0xFF00) !== 0xFF00) break;
                    offset += 2 + view.getUint16(offset + 2);
                }
                resolve(null);
            } catch { resolve(null); }
        };
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(file.slice(0, 131072));
    });
}

function parseExifApp1(view, start) {
    if (getString(view, start, 4) !== 'Exif') return null;
    const tiffStart = start + 6;
    const big = view.getUint16(tiffStart) === 0x4D4D;
    const g16 = o => big ? view.getUint16(o) : view.getUint16(o, true);
    const g32 = o => big ? view.getUint32(o) : view.getUint32(o, true);
    const exifPtr = findTag(view, tiffStart + g32(tiffStart + 4), tiffStart, 0x8769, g16, g32);
    if (!exifPtr) return null;
    const datePtr = findTag(view, tiffStart + exifPtr, tiffStart, 0x9003, g16, g32)
        || findTag(view, tiffStart + exifPtr, tiffStart, 0x9004, g16, g32);
    if (!datePtr) return null;
    const s = getString(view, tiffStart + datePtr, 19);
    const m = s.match(/^(\d{4}):(\d{2}):(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function findTag(view, ifdStart, tiffStart, tag, g16, g32) {
    try {
        const n = g16(ifdStart);
        for (let i = 0; i < n; i++) {
            const off = ifdStart + 2 + i * 12;
            if (g16(off) === tag) return g32(off + 8);
        }
    } catch {}
    return null;
}

function getString(view, off, len) {
    let s = '';
    for (let i = 0; i < len && off + i < view.byteLength; i++)
        s += String.fromCharCode(view.getUint8(off + i));
    return s;
}

// ── Filename Date ──

const FNAME_RE = [/(\d{4})(\d{2})(\d{2})/, /(\d{4})-(\d{2})-(\d{2})/, /(\d{4})_(\d{2})_(\d{2})/];

function dateFromFilename(name) {
    for (const re of FNAME_RE) {
        const m = name.match(re);
        if (m) {
            const y = +m[1], mo = +m[2], d = +m[3];
            if (y >= 1990 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
                return `${m[1]}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        }
    }
    return null;
}

// ── Classify Logic ──

function classifyPhotos(evts, pics) {
    const groups = {};
    for (const photo of pics) {
        let folder;
        if (!photo.date) {
            folder = 'Unknown Date';
        } else {
            const matched = evts.filter(e => photo.date >= e.start && photo.date <= e.end);
            if (matched.length) {
                const best = matched.reduce((a, b) =>
                    (daysDiff(a.start, a.end) <= daysDiff(b.start, b.end)) ? a : b);
                folder = best.name;
            } else {
                folder = photo.date;
            }
        }
        if (!groups[folder]) {
            const type = (folder === photo.date || folder === 'Unknown Date') ? 'date' : 'event';
            groups[folder] = { name: folder, type, photos: [] };
        }
        groups[folder].photos.push(photo);
    }
    return Object.values(groups).sort((a, b) => {
        if (a.type !== b.type) return a.type === 'event' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

// ── Step Navigation ──

function showStep(n) {
    const names = ['photos', 'events', 'results'];
    $$('.step-section').forEach(s => s.classList.add('hidden'));
    $(`#step-${names[n-1]}`).classList.remove('hidden');
    $$('.steps-bar .step').forEach(s => {
        const sn = +s.dataset.step;
        s.classList.toggle('active', sn === n);
        s.classList.toggle('done', sn < n);
    });
}

// ── Photo Selection ──

function setupPhotos() {
    const zone = $('#photo-zone');
    const input = $('#photo-file-input');
    zone.addEventListener('click', (e) => {
        if (e.target.closest('label')) return;
        input.click();
    });
    input.addEventListener('change', () => { if (input.files.length) processPhotos(input.files); });
}

async function processPhotos(fileList) {
    const imgExts = new Set(['.jpg','.jpeg','.png','.tiff','.tif','.bmp','.gif','.webp','.heic','.heif']);
    const files = Array.from(fileList).filter(f => {
        const ext = '.' + f.name.split('.').pop().toLowerCase();
        return imgExts.has(ext);
    });
    if (!files.length) { alert('No image files found.'); return; }

    $('#photo-loading').classList.remove('hidden');
    $('#photo-summary').classList.add('hidden');
    const progress = $('#photo-progress');

    const batch = [];
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        progress.style.width = `${((i+1)/files.length*100).toFixed(0)}%`;
        let d = await readExifDate(f);
        if (!d) d = dateFromFilename(f.name);
        if (!d && f.lastModified) d = isoDate(new Date(f.lastModified));
        batch.push({ file: f, filename: f.name, date: d, thumbURL: URL.createObjectURL(f) });
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    photos = photos.concat(batch);
    $('#photo-loading').classList.add('hidden');
    $('#photo-summary').classList.remove('hidden');
    $('#photo-count').textContent = `${photos.length} photo${photos.length !== 1 ? 's' : ''} loaded`;

    const grid = $('#photo-preview-grid');
    grid.innerHTML = '';
    photos.slice(0, 24).forEach(p => {
        const img = document.createElement('img');
        img.src = p.thumbURL; img.alt = p.filename;
        grid.appendChild(img);
    });
    if (photos.length > 24) {
        const more = document.createElement('span');
        more.style.cssText = 'display:flex;align-items:center;justify-content:center;width:48px;height:48px;background:var(--border);font-size:11px;font-weight:600;border-radius:var(--radius-xs);';
        more.textContent = `+${photos.length - 24}`;
        grid.appendChild(more);
    }
    $('#btn-next-events').disabled = false;
}

// ── Event Matching (from app storage) ──

function fetchLocalEvents() {
    const dates = photos.filter(p => p.date).map(p => p.date).sort();

    if (!dates.length) {
        classifyEvents = [];
        renderClassifyEvents([], 'No dates detected in photos.');
        return;
    }

    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];

    const padStart = new Date(minDate + 'T00:00:00');
    const padEnd = new Date(maxDate + 'T00:00:00');
    padStart.setDate(padStart.getDate() - 7);
    padEnd.setDate(padEnd.getDate() + 7);
    const ps = isoDate(padStart);
    const pe = isoDate(padEnd);

    $('#events-date-range').textContent = `Photo dates: ${fmtDate(minDate)} — ${fmtDate(maxDate)}`;

    const allEvents = loadEvents();
    classifyEvents = allEvents
        .filter(e => e.endDate >= ps && e.startDate <= pe)
        .map(e => ({ name: e.name, start: e.startDate, end: e.endDate }));

    const seen = new Set();
    classifyEvents = classifyEvents.filter(e => {
        const key = `${e.name}|${e.start}|${e.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    classifyEvents.sort((a, b) => a.start.localeCompare(b.start));

    renderClassifyEvents(classifyEvents);
}

function renderClassifyEvents(evts, message) {
    $('#events-summary').classList.remove('hidden');
    const toggle = $('#events-toggle');

    if (message) {
        $('#events-status').textContent = message;
        $('#events-list').innerHTML = '';
        if (toggle) toggle.classList.add('hidden');
    } else if (evts.length === 0) {
        $('#events-status').textContent = 'No events found for these dates. Photos will be grouped by date.';
        $('#events-list').innerHTML = '';
        if (toggle) toggle.classList.add('hidden');
    } else {
        $('#events-status').textContent = `${evts.length} event${evts.length !== 1 ? 's' : ''} found — uncheck to ignore`;
        if (toggle) toggle.classList.remove('hidden');
        const list = $('#events-list');
        list.innerHTML = '';
        evts.forEach((ev, i) => {
            const div = document.createElement('div');
            div.className = 'event-item';
            div.innerHTML = `<label class="event-check"><input type="checkbox" checked data-event-idx="${i}"><span class="event-name-label">${ev.name}</span></label><span class="event-dates">${fmtDate(ev.start)} — ${fmtDate(ev.end)}</span>`;
            list.appendChild(div);
        });
        updateSelectedCount();
    }
    $('#btn-classify').disabled = false;
}

function updateSelectedCount() {
    const total = $$('#events-list input[type="checkbox"]').length;
    const checked = $$('#events-list input[type="checkbox"]:checked').length;
    const btn = $('#btn-classify');
    btn.textContent = checked === total ? 'Classify' : `Classify (${checked}/${total} events)`;
}

function toggleAllEvents(selectAll) {
    $$('#events-list input[type="checkbox"]').forEach(cb => { cb.checked = selectAll; });
    updateSelectedCount();
}

function getSelectedEvents() {
    const selected = [];
    $$('#events-list input[type="checkbox"]:checked').forEach(cb => {
        selected.push(classifyEvents[+cb.dataset.eventIdx]);
    });
    return selected;
}

// ── Classify & Results ──

function handleClassify() {
    if (!photos.length) return;
    $('#btn-classify').disabled = true;
    $('#btn-classify').textContent = 'Classifying...';
    setTimeout(() => {
        const selectedEvents = getSelectedEvents();
        classification = classifyPhotos(selectedEvents, photos);
        renderResults(classification);
        showStep(3);
        $('#btn-classify').disabled = false;
        $('#btn-classify').textContent = 'Classify';
    }, 50);
}

function renderResults(groups) {
    const evG = groups.filter(g => g.type === 'event');
    const dtG = groups.filter(g => g.type === 'date');
    const total = groups.reduce((s, g) => s + g.photos.length, 0);

    $('#results-stats').textContent =
        `${total} photo${total !== 1 ? 's' : ''} -> ` +
        `${evG.length} event${evG.length !== 1 ? 's' : ''}` +
        (dtG.length ? `, ${dtG.length} date group${dtG.length !== 1 ? 's' : ''}` : '');

    if (navigator.canShare) {
        $('#btn-share-zip').classList.remove('hidden');
    }

    const grid = $('#results-grid');
    grid.innerHTML = '';
    groups.forEach(group => {
        const card = document.createElement('div');
        card.className = `group-card ${group.type === 'event' ? 'event-group' : 'date-group'}`;
        card.innerHTML = `<div class="group-header"><span class="group-name">${group.name}</span><span class="group-badge">${group.photos.length}</span></div>`;
        const pd = document.createElement('div');
        pd.className = 'group-photos';
        group.photos.forEach(p => {
            const t = document.createElement('div');
            t.className = 'photo-thumb';
            t.innerHTML = `<img src="${p.thumbURL}" alt="${p.filename}" loading="lazy"><div class="photo-label">${p.filename}</div>`;
            pd.appendChild(t);
        });
        card.appendChild(pd);
        grid.appendChild(card);
    });
}

// ── ZIP Download ──

async function generateZipBlob() {
    const progress = $('#zip-progress');
    const zip = new JSZip();
    let done = 0;
    const total = classification.reduce((s, g) => s + g.photos.length, 0);

    for (const group of classification) {
        const folder = sanitizeName(group.name);
        for (const photo of group.photos) {
            const buf = await photo.file.arrayBuffer();
            zip.file(`${folder}/${photo.filename}`, buf);
            done++;
            progress.style.width = `${(done/total*100).toFixed(0)}%`;
            if (done % 5 === 0) await new Promise(r => setTimeout(r, 0));
        }
    }
    return zip.generateAsync({ type: 'blob' }, m => { progress.style.width = `${m.percent.toFixed(0)}%`; });
}

async function handleDownloadZip() {
    if (!classification.length) return;
    const btn = $('#btn-download-zip');
    btn.disabled = true;
    $('#zip-loading').classList.remove('hidden');

    try {
        const blob = await generateZipBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'photo-calendar.zip';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('ZIP error: ' + err.message);
    } finally {
        btn.disabled = false;
        $('#zip-loading').classList.add('hidden');
    }
}

async function handleShareZip() {
    if (!classification.length) return;
    const btn = $('#btn-share-zip');
    btn.disabled = true;
    $('#zip-loading').classList.remove('hidden');

    try {
        const blob = await generateZipBlob();
        const file = new File([blob], 'photo-calendar.zip', { type: 'application/zip' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'Photo Calendar' });
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'photo-calendar.zip';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
        }
    } catch (err) {
        if (err.name !== 'AbortError') alert('Share error: ' + err.message);
    } finally {
        btn.disabled = false;
        $('#zip-loading').classList.add('hidden');
    }
}

// ── Reset Classify ──

function handleStartOver() {
    if (!confirm('Clear photos and start over?')) return;
    photos.forEach(p => URL.revokeObjectURL(p.thumbURL));
    photos = []; classifyEvents = []; classification = [];

    $('#photo-summary').classList.add('hidden');
    $('#photo-preview-grid').innerHTML = '';
    $('#photo-loading').classList.add('hidden');
    $('#btn-next-events').disabled = true;
    $('#photo-file-input').value = '';
    $('#events-summary').classList.add('hidden');
    $('#events-date-range').textContent = '';
    $('#events-list').innerHTML = '';
    $('#btn-classify').disabled = true;
    $('#results-grid').innerHTML = '';
    $('#results-stats').textContent = '';
    $('#btn-share-zip').classList.add('hidden');
    showStep(1);
}

// ═══════════════════════════════════════════
// SERVICE WORKER
// ═══════════════════════════════════════════

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    initGridMonth();
    setupPhotos();

    // Header
    $('#header-back').addEventListener('click', goBack);
    $('#header-auth').addEventListener('click', () => {
        if (currentUser) handleSignOut(); else if (firebaseReady) handleSignIn();
    });
    updateAuthUI();

    // Home
    $('#go-calendar').addEventListener('click', () => showScreen('calendar'));
    $('#go-classify').addEventListener('click', () => {
        showScreen('classify');
        showStep(1);
    });

    // Calendar view toggle
    $$('.toggle-btn').forEach(btn => btn.addEventListener('click', () => {
        $$('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        calView = btn.dataset.view;
        renderCalendar();
    }));
    $('#month-prev').addEventListener('click', () => changeMonth(-1));
    $('#month-next').addEventListener('click', () => changeMonth(1));
    $('#ics-file-input').addEventListener('change', (e) => {
        if (e.target.files[0]) { importICSFile(e.target.files[0]); e.target.value = ''; }
    });

    // Event form
    $('#ev-save').addEventListener('click', saveEvent);
    $('#ev-delete').addEventListener('click', deleteEvent);
    $('#go-categories').addEventListener('click', () => showScreen('categories'));

    // Categories
    $('#btn-add-cat').addEventListener('click', addCategory);

    // Classification flow
    $('#btn-next-events').addEventListener('click', () => {
        showStep(2);
        fetchLocalEvents();
    });
    $('#btn-back-photos').addEventListener('click', () => showStep(1));
    $('#btn-back-events').addEventListener('click', () => showStep(2));
    $('#btn-classify').addEventListener('click', handleClassify);
    $('#btn-download-zip').addEventListener('click', handleDownloadZip);
    $('#btn-share-zip').addEventListener('click', handleShareZip);
    $('#btn-start-over').addEventListener('click', handleStartOver);
    $('#btn-select-all').addEventListener('click', () => toggleAllEvents(true));
    $('#btn-select-none').addEventListener('click', () => toggleAllEvents(false));
    $('#events-list').addEventListener('change', updateSelectedCount);
});
