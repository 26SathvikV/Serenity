require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const ejs = require('ejs');
const path = require('path');
const fs = require('fs');
const https = require('https');
const ics = require('ics');
const ical = require('node-ical');
const { URLSearchParams } = require('url');
const { verifyHomepageSSOToken } = require('./lib/sso');
const site_name = "Serenity"

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const sessionSecret = process.env.SESSION_SECRET || (isProduction ? '' : 'serenity-development-secret');

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be configured.');
if (!sessionSecret) throw new Error('SESSION_SECRET must be configured in production.');

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

const User = mongoose.model('User', new mongoose.Schema({
    name: String,
    email: String,
    password: String,
    plan: { type: String, enum: ['free', 'pro', 'studio'], default: 'free' },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null }
}));

const SubTaskSchema = new mongoose.Schema({
    name: String,
    duration: { type: Number, default: null },
    done: { type: Boolean, default: false }
});

const WorkSession = mongoose.model('WorkSession', new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    name: String,
    date: Date,
    duration: { type: Number, default: null }, // minutes; overrides task-duration sum when set
    description: { type: String, default: '' },
    location: { type: String, default: '' },
    groupId: mongoose.Schema.Types.ObjectId,
    tasks: [SubTaskSchema],
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    strictMode: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}));

const Group = mongoose.model('Group', new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    name: String,
    color: { type: String, default: '#FF80CC' }
}));

const UserPreference = mongoose.model('UserPreference', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    defaultWorkDuration: { type: Number, default: 25 },
    defaultBreakDuration: { type: Number, default: 5 },
    strictMode: { type: Boolean, default: false },
    musicService: { type: String, default: null },
    musicPlaylistId: { type: String, default: null },
    musicPlaylistName: { type: String, default: null },
    spotifyAccessToken: { type: String, default: null },
    spotifyRefreshToken: { type: String, default: null },
    spotifyTokenExpiry: { type: Date, default: null },
    spotifyExternalPlaylistId: { type: String, default: null },
    appleMusicUserToken: { type: String, default: null },
    whitelistedApps: [{ name: String, url: String, appType: { type: String, default: 'website' } }],
    blacklistedApps: [{ name: String, url: String, appType: { type: String, default: 'website' } }],
    startDay: { type: String, default: 'monday' },
    timezone: { type: String, default: null }
}));

const Website = mongoose.model('Website', new mongoose.Schema({
    site_name:         String,
    link:              String,
    icon:              String,
    color:             String,
    order:             { type: Number, default: 0 },
    visible:           { type: Boolean, default: true },
    self:              { type: Boolean, default: false },
    hide_monetization: { type: Boolean, default: false },
    beta_test:         { type: Boolean, default: false }
}), 'websites');

async function isMonetizationHidden() {
    const homepageDoc = await Website.findOne({ self: true }).select('hide_monetization').lean();
    return !!(homepageDoc && homepageDoc.hide_monetization);
}

// ── SSO / Auth config ─────────────────────────────────────────────────────────

const AUTH_HOST = (process.env.AUTH_HOST || '').replace(/\/$/, '');
const SERENITY_URL = (process.env.SERENITY_URL || '').replace(/\/$/, '');
const SSO_SECRET  = process.env.SSO_SECRET || '';

if (isProduction && AUTH_HOST && !SSO_SECRET) {
    throw new Error('SSO_SECRET must be configured when Homepage authentication is enabled.');
}

// ── Plan system ───────────────────────────────────────────────────────────────

const PLAN_LIMITS = {
    free:   { sessions: 15,  groups: 5,   templates: 5,        music: true, calViews: true, focusLinks: true },
    pro:    { sessions: 100, groups: 20,  templates: 30,       music: true, calViews: true, focusLinks: true },
    studio: { sessions: Infinity, groups: Infinity, templates: Infinity, music: true, calViews: true, focusLinks: true }
};

function planOf(user) {
    const p = user && user.plan;
    return (p === 'pro' || p === 'studio') ? p : 'free';
}

function planVars(user) {
    const plan = planOf(user);
    const limits = PLAN_LIMITS[plan];
    return {
        userPlan: plan,
        isFree: plan === 'free',
        isPro: plan === 'pro',
        isStudio: plan === 'studio',
        planLimits: limits,
        billingUrl: AUTH_HOST ? `${AUTH_HOST}/billing` : '/billing'
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function getValidSpotifyToken(pref) {
    if (!pref.spotifyRefreshToken) return null;
    const now = new Date();
    if (pref.spotifyTokenExpiry && pref.spotifyTokenExpiry > new Date(now.getTime() + 60000)) {
        return pref.spotifyAccessToken;
    }
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: pref.spotifyRefreshToken
    }).toString();
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const result = await httpsRequest({
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    if (result.body.access_token) {
        pref.spotifyAccessToken = result.body.access_token;
        pref.spotifyTokenExpiry = new Date(Date.now() + result.body.expires_in * 1000);
        await pref.save();
        return pref.spotifyAccessToken;
    }
    return null;
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProduction) app.set('trust proxy', 1);
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        collectionName: 'sessions',
        ttl: 7 * 24 * 60 * 60
    }),
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax'
    }
}));

function render404Page(res) {
    res.status(404).render('standard/page', {
        name: '404',
        body: '<div style="text-align:center;padding:80px 0"><h1>404</h1><p>Page not found.</p><a href="/">Go Home</a></div>'
    });
}

// ── Dynamic favicon (ionicon + brand color from websites collection) ──────────

let _faviconCache = null;

app.get('/favicon.svg', async (req, res) => {
    try {
        if (!_faviconCache) {
            const site = await Website.findOne({ site_name });
            const icon  = (site && site.icon)  ? site.icon  : 'timer-outline';
            const color = (site && site.color) ? site.color : '#FF80CC';

            const svg = await new Promise((resolve, reject) => {
                https.get(
                    `https://unpkg.com/ionicons@7.1.0/dist/ionicons/svg/${icon}.svg`,
                    (r) => {
                        if (r.statusCode !== 200) { r.resume(); reject(new Error('Not found')); return; }
                        let data = '';
                        r.on('data', c => data += c);
                        r.on('end', () => resolve(data));
                    }
                ).on('error', reject);
            });

            _faviconCache = svg.replace(/currentColor/g, color);
        }

        res.set('Content-Type', 'image/svg+xml');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(_faviconCache);
    } catch(e) {
        const color = '#FF80CC';
        res.set('Content-Type', 'image/svg+xml');
        res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="220" fill="${color}"/><text x="256" y="320" font-size="200" text-anchor="middle" fill="white" font-family="sans-serif">S</text></svg>`);
    }
});

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    if (AUTH_HOST) {
        const redirect = SERENITY_URL ? `${SERENITY_URL}/auth/sso` : `${req.protocol}://${req.get('host')}/auth/sso`;
        return res.redirect(`${AUTH_HOST}/login?redirect=${encodeURIComponent(redirect)}&app=serenity`);
    }
    res.render('signup/login', { error: null });
});

app.post('/login', async (req, res) => {
    if (AUTH_HOST) return res.redirect('/login');
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.render('signup/login', { error: 'No account found with that email.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render('signup/login', { error: 'Incorrect password.' });
    req.session.userId = user._id;
    res.redirect('/home');
});

app.get('/signup', (req, res) => {
    if (req.session.userId) return res.redirect('/home');
    if (AUTH_HOST) {
        const redirect = SERENITY_URL ? `${SERENITY_URL}/auth/sso` : `${req.protocol}://${req.get('host')}/auth/sso`;
        return res.redirect(`${AUTH_HOST}/login?redirect=${encodeURIComponent(redirect)}&app=serenity`);
    }
    res.render('signup/signup', { error: null });
});

app.post('/signup', async (req, res) => {
    if (AUTH_HOST) return res.redirect('/login');
    const { name, email, pass, passconf } = req.body;
    if (pass !== passconf) return res.render('signup/signup', { error: 'Passwords do not match.' });
    const existing = await User.findOne({ email });
    if (existing) return res.render('signup/signup', { error: 'An account with that email already exists.' });
    const hashed = await bcrypt.hash(pass, 10);
    const user = new User({ name, email, password: hashed });
    await user.save();
    req.session.userId = user._id;
    res.redirect('/home');
});

// Homepage sends ?token=<base64url payload>.<base64url HMAC signature>
// The signed payload contains the shared user's ID, name, and millisecond expiry.
app.get('/auth/sso', async (req, res, next) => {
    if (!AUTH_HOST || !SSO_SECRET) return res.redirect('/login');
    const data = verifyHomepageSSOToken(req.query.token, SSO_SECRET);
    if (!data) return res.redirect('/login?error=sso_invalid');

    try {
        const user = await User.findById(data.userId);
        if (!user) return res.redirect('/login?error=sso_user_not_found');

        req.session.regenerate(err => {
            if (err) return next(err);
            req.session.userId = user._id;
            req.session.save(saveError => {
                if (saveError) return next(saveError);
                res.redirect('/');
            });
        });
    } catch(e) {
        next(e);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        if (AUTH_HOST) return res.redirect(`${AUTH_HOST}/logout`);
        res.redirect('/login');
    });
});

// ── Main pages ────────────────────────────────────────────────────────────────

app.get('/home', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    const user = await User.findById(req.session.userId);
    if (!user) { req.session.destroy(); return res.redirect('/login'); }

    const [sessions, groups, completedSessions] = await Promise.all([
        WorkSession.find({ userId: req.session.userId, completed: { $ne: true } }),
        Group.find({ userId: req.session.userId }),
        WorkSession.find({ userId: req.session.userId, completed: true })
    ]);

    const now = new Date();
    const delayed = sessions
        .filter(s => new Date(s.date) < now)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    const upcoming = sessions
        .filter(s => new Date(s.date) >= now)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    const next = upcoming[0] || delayed[0] || null;

    const groupMap = {};
    groups.forEach(g => { groupMap[g._id.toString()] = g; });

    // Stats
    const weekStart = new Date(now);
    const dow = weekStart.getDay();
    weekStart.setDate(weekStart.getDate() - (dow === 0 ? 6 : dow - 1));
    weekStart.setHours(0, 0, 0, 0);

    const completedDate = s => s.completedAt || s.date;
    const weekCompleted = completedSessions.filter(s => completedDate(s) >= weekStart).length;
    const totalTasksDone = completedSessions.reduce((sum, s) => sum + s.tasks.filter(t => t.done).length, 0);

    const daySet = new Set();
    completedSessions.forEach(s => {
        const d = completedDate(s);
        if (d) { const dd = new Date(d); daySet.add(`${dd.getFullYear()}-${dd.getMonth()}-${dd.getDate()}`); }
    });
    let streak = 0;
    const sd = new Date(now); sd.setHours(0, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
        if (daySet.has(`${sd.getFullYear()}-${sd.getMonth()}-${sd.getDate()}`)) { streak++; sd.setDate(sd.getDate() - 1); }
        else break;
    }

    const stats = { total: completedSessions.length, weekCompleted, totalTasksDone, streak };

    const pv = planVars(user);
    const pageFile = path.join(__dirname, 'views/pages/home.ejs');
    fs.readFile(pageFile, 'utf8', async (err, pageTemplate) => {
        if (err) return render404Page(res);
        const content = await ejs.render(pageTemplate, { user, delayed, upcoming, next, groupMap, stats, ...pv }, { filename: pageFile });
        res.render('standard/page', { name: 'Home', body: content, ...pv });
    });
});

app.get('/add', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    const user = await User.findById(req.session.userId);
    if (!user) { req.session.destroy(); return res.redirect('/login'); }
    const groups = await Group.find({ userId: req.session.userId });
    const prefilledDate = req.query.date || null;
    const pv = planVars(user);
    const sessionCount = await WorkSession.countDocuments({ userId: req.session.userId, completed: { $ne: true } });
    const hideMonetization = await isMonetizationHidden();

    const pageFile = path.join(__dirname, 'views/pages/add.ejs');
    fs.readFile(pageFile, 'utf8', async (err, pageTemplate) => {
        if (err) return render404Page(res);
        const content = await ejs.render(pageTemplate, { groups, prefilledDate, sessionCount, ...pv, hideMonetization, error: req.query.error || null }, { filename: pageFile });
        res.render('standard/page', { name: 'Add', body: content, ...pv });
    });
});

app.post('/add/session', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    const user = await User.findById(req.session.userId);
    const limits = PLAN_LIMITS[planOf(user)];
    if (limits.sessions !== Infinity) {
        const count = await WorkSession.countDocuments({ userId: req.session.userId, completed: { $ne: true } });
        if (count >= limits.sessions) return res.redirect('/add?error=session_limit');
    }

    const { name, date, groupId, description, location, duration } = req.body;
    const rawNames = Array.isArray(req.body.tasks) ? req.body.tasks : req.body.tasks ? [req.body.tasks] : [];
    const rawDurs = Array.isArray(req.body.taskDurations) ? req.body.taskDurations : req.body.taskDurations ? [req.body.taskDurations] : [];
    const taskDocs = rawNames.filter(n => n.trim()).map((n, i) => ({
        name: n.trim(),
        duration: rawDurs[i] ? parseInt(rawDurs[i]) || null : null
    }));

    await WorkSession.create({
        userId: req.session.userId,
        name: name || 'Untitled Session',
        date: date ? new Date(date) : new Date(),
        duration: duration ? parseInt(duration) || null : null,
        description: (description || '').trim(),
        location: (location || '').trim(),
        groupId: groupId || null,
        tasks: taskDocs,
        strictMode: req.body.strictMode === 'on'
    });
    res.redirect('/home');
});

app.post('/add/group', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    const user = await User.findById(req.session.userId);
    const limits = PLAN_LIMITS[planOf(user)];
    if (limits.groups !== Infinity) {
        const count = await Group.countDocuments({ userId: req.session.userId });
        if (count >= limits.groups) return res.redirect('/add?error=group_limit');
    }

    const { name, color } = req.body;
    await Group.create({
        userId: req.session.userId,
        name: name || 'New Group',
        color: color || '#FF80CC'
    });
    res.redirect('/add');
});

app.post('/delete/session/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    await WorkSession.findOneAndDelete({ _id: req.params.id, userId: req.session.userId });
    res.redirect('/home');
});

// ── Work session routes ───────────────────────────────────────────────────────

app.patch('/work/:id/tasks', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const workSession = await WorkSession.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!workSession) return res.status(404).json({ error: 'Not found' });
    workSession.tasks = (req.body.tasks || []).map(t => ({
        ...(t._id ? { _id: t._id } : {}),
        name: t.name,
        duration: t.duration || null,
        done: t.done || false
    }));
    await workSession.save();
    res.json({ tasks: workSession.tasks });
});

app.get('/work/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    const user = await User.findById(req.session.userId);
    if (!user) { req.session.destroy(); return res.redirect('/login'); }

    const workSession = await WorkSession.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!workSession) return render404Page(res);

    const [group, userPref] = await Promise.all([
        workSession.groupId ? Group.findById(workSession.groupId) : Promise.resolve(null),
        UserPreference.findOne({ userId: req.session.userId })
    ]);

    const pv = planVars(user);
    const pageFile = path.join(__dirname, 'views/pages/work.ejs');
    fs.readFile(pageFile, 'utf8', async (err, pageTemplate) => {
        if (err) return render404Page(res);
        const content = await ejs.render(pageTemplate, {
            workSession,
            group,
            workSessionJson: JSON.stringify(workSession).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'),
            userPref: userPref || null,
            ...pv
        }, { filename: pageFile });
        res.render('standard/page', { name: 'Work', body: content, ...pv });
    });
});

app.post('/work/:id/complete', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    const workSession = await WorkSession.findOne({ _id: req.params.id, userId: req.session.userId });
    if (workSession) {
        workSession.completed = true;
        workSession.completedAt = new Date();
        const { completedTasks } = req.body;
        if (completedTasks) {
            const completed = Array.isArray(completedTasks) ? completedTasks : [completedTasks];
            workSession.tasks.forEach(t => {
                if (completed.includes(t._id.toString())) t.done = true;
            });
        }
        await workSession.save();
    }
    res.redirect('/home');
});

// ── History ───────────────────────────────────────────────────────────────────

app.get('/history', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const [sessions, groups] = await Promise.all([
        WorkSession.find({ userId: req.session.userId, completed: true }).sort({ completedAt: -1, date: -1 }),
        Group.find({ userId: req.session.userId })
    ]);
    const groupMap = {};
    groups.forEach(g => { groupMap[g._id.toString()] = g; });
    const user = await User.findById(req.session.userId);
    const pv = planVars(user);
    const pageFile = path.join(__dirname, 'views/pages/history.ejs');
    fs.readFile(pageFile, 'utf8', async (err, pageTemplate) => {
        if (err) return render404Page(res);
        const content = await ejs.render(pageTemplate, { sessions, groupMap, ...pv }, { filename: pageFile });
        res.render('standard/page', { name: 'History', body: content, ...pv });
    });
});

app.post('/history/delete/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    await WorkSession.findOneAndDelete({ _id: req.params.id, userId: req.session.userId });
    res.redirect('/history');
});

// ── Calendar: iCal import/export & Google Calendar links ──────────────────────

function sessionDurationMinutes(session) {
    if (session.duration) return session.duration;
    const total = (session.tasks || []).reduce((sum, t) => sum + (t.duration || 0), 0);
    return total > 0 ? total : 30;
}

function dateToUTCArray(d) {
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
}

function sessionToIcsEvent(session, groupMap) {
    const group = session.groupId && groupMap[session.groupId.toString()];
    const detailLines = [];
    if (session.description) detailLines.push(session.description);
    if (group) detailLines.push('Group: ' + group.name);
    if ((session.tasks || []).length) detailLines.push('Tasks: ' + session.tasks.map(t => t.name).join(', '));
    if (session.completed) detailLines.push('(Completed)');

    return {
        uid: `serenity-session-${session._id}@serenity`,
        title: session.name || 'Untitled Session',
        start: dateToUTCArray(new Date(session.date)),
        startInputType: 'utc',
        startOutputType: 'utc',
        duration: { minutes: sessionDurationMinutes(session) },
        description: detailLines.join('\n'),
        location: session.location || undefined,
        categories: group ? [group.name] : undefined,
        status: 'CONFIRMED',
        productId: 'serenity'
    };
}

function sendIcsResponse(res, filename, events) {
    const { error, value } = ics.createEvents(events);
    if (error) {
        console.error('ICS generation error:', error);
        return res.status(500).send('Failed to generate calendar file');
    }
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(value);
}

app.get('/calendar/export.ics', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const [sessions, groups] = await Promise.all([
        WorkSession.find({ userId: req.session.userId }).sort({ date: 1 }),
        Group.find({ userId: req.session.userId })
    ]);
    const groupMap = {};
    groups.forEach(g => { groupMap[g._id.toString()] = g; });
    const events = sessions.map(s => sessionToIcsEvent(s, groupMap));
    sendIcsResponse(res, 'serenity-calendar.ics', events);
});

app.get('/work/:id/export.ics', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const workSession = await WorkSession.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!workSession) return render404Page(res);
    const groupMap = {};
    if (workSession.groupId) {
        const group = await Group.findById(workSession.groupId);
        if (group) groupMap[group._id.toString()] = group;
    }
    sendIcsResponse(res, `${(workSession.name || 'session').replace(/[^a-z0-9-_]+/gi, '-')}.ics`, [sessionToIcsEvent(workSession, groupMap)]);
});

// Accepts the raw .ics file contents as the request body (text/calendar).
app.post('/calendar/import', express.text({ type: '*/*', limit: '5mb' }), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    let parsed;
    try {
        parsed = ical.sync.parseICS(req.body || '');
    } catch (e) {
        return res.status(400).json({ error: 'Could not parse .ics file' });
    }

    const limits = PLAN_LIMITS[planOf(user)];
    let remaining = Infinity;
    if (limits.sessions !== Infinity) {
        const count = await WorkSession.countDocuments({ userId: req.session.userId, completed: { $ne: true } });
        remaining = Math.max(0, limits.sessions - count);
    }

    const MAX_OCCURRENCES_PER_EVENT = 50;
    const RECURRENCE_HORIZON = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365); // expand recurring events up to 1 year out

    const docs = [];
    let skippedForLimit = false;

    for (const key in parsed) {
        const comp = parsed[key];
        if (!comp || comp.type !== 'VEVENT' || !comp.start) continue;

        let occurrences = [comp.start];
        if (comp.rrule) {
            try {
                const from = comp.start < new Date() ? new Date() : comp.start;
                const expanded = comp.rrule.between(from, RECURRENCE_HORIZON, true).slice(0, MAX_OCCURRENCES_PER_EVENT);
                if (expanded.length) occurrences = expanded;
            } catch (e) { /* fall back to single occurrence */ }
        }

        for (const occDate of occurrences) {
            if (remaining !== Infinity && docs.length >= remaining) { skippedForLimit = true; break; }
            docs.push({
                userId: req.session.userId,
                name: (comp.summary ? comp.summary.toString() : 'Imported Event').slice(0, 200),
                date: new Date(occDate),
                description: comp.description ? comp.description.toString().slice(0, 2000) : '',
                location: comp.location ? comp.location.toString().slice(0, 300) : '',
                groupId: null,
                tasks: []
            });
        }
    }

    if (docs.length > 0) await WorkSession.insertMany(docs);
    res.json({ imported: docs.length, skippedForLimit });
});

// ── Calendar ──────────────────────────────────────────────────────────────────

app.get('/calendar', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const [sessions, groups] = await Promise.all([
        WorkSession.find({ userId: req.session.userId }).sort({ date: 1 }),
        Group.find({ userId: req.session.userId })
    ]);
    const pref = await UserPreference.findOne({ userId: req.session.userId });
    const escape = s => JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    const user = await User.findById(req.session.userId);
    const pv = planVars(user);
    const pageFile = path.join(__dirname, 'views/pages/calendar.ejs');
    fs.readFile(pageFile, 'utf8', async (err, pageTemplate) => {
        if (err) return render404Page(res);
        const content = await ejs.render(pageTemplate, {
            sessionsJson: escape(sessions),
            groupsJson: escape(groups),
            startDay: (pref && pref.startDay) || 'monday',
            timezone: (pref && pref.timezone) || null,
            ...pv
        }, { filename: pageFile });
        res.render('standard/page', { name: 'Calendar', body: content, ...pv });
    });
});

// ── Settings ──────────────────────────────────────────────────────────────────

app.get('/settings', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    const [prefRaw, user] = await Promise.all([
        UserPreference.findOne({ userId: req.session.userId }),
        User.findById(req.session.userId)
    ]);
    if (!user) { req.session.destroy(); return res.redirect('/login'); }
    let pref = prefRaw || new UserPreference({ userId: req.session.userId });

    const spotifyConnected = !!(pref.spotifyAccessToken && pref.spotifyRefreshToken);
    let spotifyPlaylists = [];

    if (spotifyConnected && req.query.pickPlaylist === '1') {
        try {
            const token = await getValidSpotifyToken(pref);
            const result = await httpsRequest({
                hostname: 'api.spotify.com',
                path: '/v1/me/playlists?limit=50',
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            spotifyPlaylists = (result.body && result.body.items) ? result.body.items : [];
        } catch(e) {
            console.error('Failed to fetch Spotify playlists:', e);
        }
    }

    const pageFile = path.join(__dirname, 'views/pages/settings.ejs');
    fs.readFile(pageFile, 'utf8', async (err, pageTemplate) => {
        if (err) return render404Page(res);
        const pv = planVars(user);
        const hideMonetization = await isMonetizationHidden();
        const content = await ejs.render(pageTemplate, {
            user,
            pref,
            spotifyConnected,
            spotifyExternalConnected: !!pref.spotifyExternalPlaylistId,
            spotifyPlaylists,
            spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
            appleMusicKeyId: process.env.APPLE_MUSIC_KEY_ID || null,
            appleMusicConnected: !!(pref.appleMusicUserToken),
            deezerAppId: process.env.DEEZER_APP_ID || null,
            deezerActive: !!(pref.musicService === 'deezer'),
            flash: req.query.connected || null,
            error: req.query.error || null,
            accountFlash: req.query.accountFlash || null,
            accountError: req.query.accountError || null,
            strictMode: pref.strictMode || false,
            whitelistedApps: pref.whitelistedApps || [],
            blacklistedApps: pref.blacklistedApps || [],
            startDay: pref.startDay || 'monday',
            timezone: pref.timezone || null,
            hideMonetization,
            ...pv
        }, { filename: pageFile });
        res.render('standard/page', { name: 'Settings', body: content, ...pv });
    });
});

app.post('/settings', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    let pref = await UserPreference.findOne({ userId: req.session.userId });
    if (!pref) pref = new UserPreference({ userId: req.session.userId });

    if (req.body._musicAction === 'saveSpotifyExternal') {
        if (req.body.removeSpotifyExternal === 'true') {
            pref.spotifyExternalPlaylistId = null;
            if (pref.musicService === 'spotifyExternal') pref.musicService = null;
        } else {
            const value = (req.body.spotifyExternalPlaylist || '').trim();
            const uriMatch = value.match(/^spotify:playlist:([A-Za-z0-9]+)$/i);
            let playlistId = uriMatch ? uriMatch[1] : null;

            if (!playlistId) {
                try {
                    const url = new URL(value);
                    const urlMatch = url.hostname === 'open.spotify.com'
                        ? url.pathname.match(/^\/playlist\/([A-Za-z0-9]+)\/?$/)
                        : null;
                    playlistId = urlMatch ? urlMatch[1] : null;
                } catch (e) {}
            }

            if (!playlistId) return res.redirect('/settings?error=spotify_external_invalid');
            pref.spotifyExternalPlaylistId = playlistId;
            pref.musicService = 'spotifyExternal';
        }

        await pref.save();
        return res.redirect('/settings');
    }

    const { defaultWorkDuration, defaultBreakDuration, musicPlaylistId, musicPlaylistName, musicService, _strictModePresent } = req.body;
    if (defaultWorkDuration) pref.defaultWorkDuration = parseInt(defaultWorkDuration) || 25;
    if (defaultBreakDuration) pref.defaultBreakDuration = parseInt(defaultBreakDuration) || 5;
    if (musicPlaylistId !== undefined) {
        pref.musicPlaylistId = musicPlaylistId || null;
        pref.musicPlaylistName = musicPlaylistName || null;
    }
    if (musicService !== undefined) pref.musicService = musicService || pref.musicService;
    if (_strictModePresent !== undefined) pref.strictMode = req.body.strictMode === 'on';
    if (req.body.startDay) pref.startDay = req.body.startDay;
    if (req.body.timezone) pref.timezone = req.body.timezone;

    await pref.save();
    res.redirect('/settings');
});

// ── Account management ────────────────────────────────────────────────────────

app.post('/profile/update', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { name, email } = req.body;
    if (!name || !email) return res.redirect('/settings?accountError=missing_fields');
    await User.findByIdAndUpdate(req.session.userId, { name: name.trim(), email: email.trim().toLowerCase() });
    res.redirect('/settings?accountFlash=updated');
});

app.post('/profile/password', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) return res.redirect('/settings?accountError=password_mismatch');
    if (!newPassword || newPassword.length < 6) return res.redirect('/settings?accountError=password_short');
    const user = await User.findById(req.session.userId);
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.redirect('/settings?accountError=wrong_password');
    const hash = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(req.session.userId, { password: hash });
    res.redirect('/settings?accountFlash=password_changed');
});

app.post('/profile/delete', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { confirmPassword } = req.body;
    const user = await User.findById(req.session.userId);
    if (!user) { req.session.destroy(); return res.redirect('/login'); }
    const match = await bcrypt.compare(confirmPassword, user.password);
    if (!match) return res.redirect('/settings?accountError=wrong_password');
    const userId = req.session.userId;
    await Promise.all([
        User.findByIdAndDelete(userId),
        WorkSession.deleteMany({ userId }),
        Group.deleteMany({ userId }),
        UserPreference.deleteOne({ userId })
    ]);
    req.session.destroy(() => res.redirect('/login'));
});

// ── Spotify OAuth ─────────────────────────────────────────────────────────────

app.get('/auth/spotify', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) return res.redirect('/settings?error=no_client_id');
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}/auth/spotify/callback`;
    const scopes = 'streaming user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private user-read-email user-read-private';
    const url = `https://accounts.spotify.com/authorize?response_type=code&client_id=${clientId}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.redirect(url);
});

app.get('/auth/spotify/callback', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { code, error } = req.query;
    if (error || !code) return res.redirect('/settings?error=spotify_denied');

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}/auth/spotify/callback`;

    try {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
        }).toString();
        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const result = await httpsRequest({
            hostname: 'accounts.spotify.com',
            path: '/api/token',
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        }, body);

        if (!result.body.access_token) return res.redirect('/settings?error=spotify_failed');

        let pref = await UserPreference.findOne({ userId: req.session.userId });
        if (!pref) pref = new UserPreference({ userId: req.session.userId });

        pref.musicService = 'spotify';
        pref.spotifyAccessToken = result.body.access_token;
        pref.spotifyRefreshToken = result.body.refresh_token;
        pref.spotifyTokenExpiry = new Date(Date.now() + result.body.expires_in * 1000);
        await pref.save();

        res.redirect('/settings?connected=spotify&pickPlaylist=1');
    } catch(e) {
        console.error('Spotify callback error:', e);
        res.redirect('/settings?error=spotify_failed');
    }
});

app.post('/auth/spotify/disconnect', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const pref = await UserPreference.findOne({ userId: req.session.userId });
    if (pref) {
        pref.musicService = null;
        pref.musicPlaylistId = null;
        pref.musicPlaylistName = null;
        pref.spotifyAccessToken = null;
        pref.spotifyRefreshToken = null;
        pref.spotifyTokenExpiry = null;
        await pref.save();
    }
    res.redirect('/settings');
});

// ── Apple Music ───────────────────────────────────────────────────────────────

app.get('/api/applemusic/developer-token', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const keyId = process.env.APPLE_MUSIC_KEY_ID;
    const teamId = process.env.APPLE_MUSIC_TEAM_ID;
    const privateKeyStr = process.env.APPLE_MUSIC_PRIVATE_KEY;
    if (!keyId || !teamId || !privateKeyStr) return res.status(400).json({ error: 'Apple Music not configured' });
    try {
        const privateKey = privateKeyStr.replace(/\\n/g, '\n');
        const token = jwt.sign({}, privateKey, {
            algorithm: 'ES256',
            expiresIn: '180d',
            issuer: teamId,
            header: { alg: 'ES256', kid: keyId }
        });
        res.json({ token });
    } catch(e) {
        console.error('Apple Music token error:', e);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

app.post('/api/applemusic/usertoken', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { userToken } = req.body;
    if (!userToken) return res.status(400).json({ error: 'No token provided' });
    try {
        let pref = await UserPreference.findOne({ userId: req.session.userId });
        if (!pref) pref = new UserPreference({ userId: req.session.userId });
        pref.appleMusicUserToken = userToken;
        await pref.save();
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: 'Failed to save token' });
    }
});

app.post('/auth/applemusic/disconnect', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const pref = await UserPreference.findOne({ userId: req.session.userId });
    if (pref) {
        pref.appleMusicUserToken = null;
        if (pref.musicService === 'applemusic') {
            pref.musicService = null;
            pref.musicPlaylistId = null;
            pref.musicPlaylistName = null;
        }
        await pref.save();
    }
    res.redirect('/settings');
});

// ── Deezer ────────────────────────────────────────────────────────────────────

app.get('/deezer/channel', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send('<!DOCTYPE html><html><head></head><body></body></html>');
});

app.post('/auth/deezer/disconnect', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const pref = await UserPreference.findOne({ userId: req.session.userId });
    if (pref && pref.musicService === 'deezer') {
        pref.musicService = null;
        pref.musicPlaylistId = null;
        pref.musicPlaylistName = null;
        await pref.save();
    }
    res.redirect('/settings');
});

// ── Spotify API proxies (serve fresh token & playlists) ───────────────────────

app.get('/api/spotify/token', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const pref = await UserPreference.findOne({ userId: req.session.userId });
    if (!pref || !pref.spotifyRefreshToken) return res.status(400).json({ error: 'Not connected' });
    try {
        const token = await getValidSpotifyToken(pref);
        res.json({ token });
    } catch(e) {
        res.status(500).json({ error: 'Failed to get token' });
    }
});

app.get('/api/spotify/playlists', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const pref = await UserPreference.findOne({ userId: req.session.userId });
    if (!pref || !pref.spotifyRefreshToken) return res.status(400).json({ error: 'Not connected' });
    try {
        const token = await getValidSpotifyToken(pref);
        const result = await httpsRequest({
            hostname: 'api.spotify.com',
            path: '/v1/me/playlists?limit=50',
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        res.json({ playlists: (result.body && result.body.items) ? result.body.items : [] });
    } catch(e) {
        res.status(500).json({ error: 'Failed to fetch playlists' });
    }
});

// ── App whitelist / blacklist ─────────────────────────────────────────────────

app.post('/settings/whitelist', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { action, name, url, index } = req.body;
    let pref = await UserPreference.findOne({ userId: req.session.userId });
    if (!pref) pref = new UserPreference({ userId: req.session.userId });
    if (action === 'add' && name && url) {
        pref.whitelistedApps.push({ name: name.trim(), url: url.trim(), appType: req.body.appType || 'website' });
    } else if (action === 'remove' && index !== undefined) {
        pref.whitelistedApps.splice(parseInt(index), 1);
    }
    await pref.save();
    if (req.headers.accept && req.headers.accept.includes('application/json')) return res.json({ ok: true });
    res.redirect('/settings');
});

app.post('/settings/blacklist', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { action, name, url, index } = req.body;
    let pref = await UserPreference.findOne({ userId: req.session.userId });
    if (!pref) pref = new UserPreference({ userId: req.session.userId });
    if (action === 'add' && name && url) {
        pref.blacklistedApps.push({ name: name.trim(), url: url.trim(), appType: req.body.appType || 'website' });
    } else if (action === 'remove' && index !== undefined) {
        pref.blacklistedApps.splice(parseInt(index), 1);
    }
    await pref.save();
    res.redirect('/settings');
});

app.get('/api/self', async (req, res) => {
    const site = await Website.findOne({ site_name });
    if (!site) return res.json({ icon: 'timer-outline', color: '#FF80CC', site_name });
    res.json({ icon: site.icon || 'timer-outline', color: site.color || '#FF80CC', site_name: site.site_name });
});

app.get('/api/websites', async (req, res) => {
    if (!req.session.userId) return res.status(401).json([]);
    try {
        const sites = await Website.find({ visible: { $ne: false } }).sort({ order: 1 });
        res.json(sites);
    } catch(e) {
        res.json([]);
    }
});

// ── Error handler (prevent stack trace leakage in production) ─────────────────

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('standard/page', {
        name: 'Error',
        body: '<div style="text-align:center;padding:80px 0"><h1>500</h1><p>Something went wrong. Please try again.</p></div>'
    });
});

app.listen(PORT, () => console.log(`Serenity running on http://localhost:${PORT}`));
