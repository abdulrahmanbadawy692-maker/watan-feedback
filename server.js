const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET || 'wfd-feedback-secret-2026';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xyupooepebzbpaslmfkw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: WebSocket } });

// ── SQLite Setup ────────────────────────────────────────────
const db = new Database(':memory:');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS fb_users (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    department TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'employee',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS fb_reviews (
    id TEXT PRIMARY KEY,
    reviewer_id TEXT NOT NULL,
    reviewer_role TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    department TEXT NOT NULL,
    job_satisfaction INTEGER,
    salary_benefits INTEGER,
    growth_training INTEGER,
    sup_communication INTEGER,
    sup_support INTEGER,
    sup_fairness INTEGER,
    team_teamwork INTEGER,
    team_respect INTEGER,
    emp_performance INTEGER,
    emp_punctuality INTEGER,
    emp_attitude INTEGER,
    emp_initiative INTEGER,
    comment TEXT,
    sup_comment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Supabase Cloud Sync ─────────────────────────────────────
async function cloudInsert(table, row) {
  try {
    const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
    if (error) console.error(`[CLOUD] Insert ${table}:`, error.message);
    else console.log(`[CLOUD] ✅ Saved to ${table}`);
  } catch(e) { console.error(`[CLOUD] ${table} sync failed:`, e.message); }
}
async function cloudUpdate(table, id, updates) {
  try {
    const { error } = await supabase.from(table).update(updates).eq('id', id);
    if (error) console.error(`[CLOUD] Update ${table}:`, error.message);
  } catch(e) { console.error(`[CLOUD] ${table} update failed:`, e.message); }
}
async function loadFromSupabase() {
  try {
    console.log('[DB] Loading from Supabase...');
    const { data: users, error: ue } = await supabase.from('fb_users').select('*');
    if (ue) { console.log('[DB] fb_users not found — run SQL setup first!', ue.message); return false; }
    const { data: reviews } = await supabase.from('fb_reviews').select('*');
    let ru=0, rr=0;
    for (const u of (users||[])) {
      try {
        db.prepare('INSERT OR REPLACE INTO fb_users (id,full_name,email,password_hash,department,role,is_admin,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(u.id,u.full_name,u.email,u.password_hash,u.department,u.role||'employee',u.is_admin||0,u.created_at);
        ru++;
      } catch(e) {}
    }
    for (const r of (reviews||[])) {
      try {
        db.prepare('INSERT OR REPLACE INTO fb_reviews (id,reviewer_id,reviewer_role,target_type,target_id,department,job_satisfaction,salary_benefits,growth_training,sup_communication,sup_support,sup_fairness,team_teamwork,team_respect,emp_performance,emp_punctuality,emp_attitude,emp_initiative,comment,sup_comment,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(r.id,r.reviewer_id,r.reviewer_role,r.target_type,r.target_id||null,r.department,r.job_satisfaction||null,r.salary_benefits||null,r.growth_training||null,r.sup_communication||null,r.sup_support||null,r.sup_fairness||null,r.team_teamwork||null,r.team_respect||null,r.emp_performance||null,r.emp_punctuality||null,r.emp_attitude||null,r.emp_initiative||null,r.comment||null,r.sup_comment||null,r.created_at);
        rr++;
      } catch(e) {}
    }
    console.log(`[DB] ✅ Loaded ${ru} users, ${rr} reviews`);
    return true;
  } catch(e) { console.log('[DB] Load error:', e.message); return false; }
}

// ── Prepared Statements ─────────────────────────────────────
const getUserByEmail = db.prepare('SELECT * FROM fb_users WHERE LOWER(email)=LOWER(?)');
const getUserById = db.prepare('SELECT * FROM fb_users WHERE id=?');
const getAllUsers = db.prepare('SELECT * FROM fb_users WHERE is_admin=0');
const getByDept = db.prepare('SELECT * FROM fb_users WHERE department=? AND is_admin=0');

// ── Express Setup ───────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: true, saveUninitialized: false, cookie: { maxAge: null } }));
app.use(express.static(path.join(__dirname, 'public')));
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { success:false, message:'Too many attempts. Try again later.' } });

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({success:false,message:'Session expired. Please log in again.'});
    return res.redirect('/');
  }
  return next();
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({success:false,message:'Admin access required.'});
  res.redirect('/admin/login');
}
function escapeHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Shared HTML Helpers ─────────────────────────────────────
function langToggleScript() {
  return `<script>
  var wfdLang=localStorage.getItem('wfd_lang')||'en';
  function applyLang(l){wfdLang=l;localStorage.setItem('wfd_lang',l);
    document.documentElement.dir=l==='ar'?'rtl':'ltr';
    document.documentElement.lang=l;
    document.querySelectorAll('[data-en]').forEach(function(el){el.textContent=l==='ar'?(el.getAttribute('data-ar')||el.getAttribute('data-en')):el.getAttribute('data-en');});
    document.querySelectorAll('[data-en-html]').forEach(function(el){el.innerHTML=l==='ar'?(el.getAttribute('data-ar-html')||el.getAttribute('data-en-html')):el.getAttribute('data-en-html');});
  }
  function toggleLang(){applyLang(wfdLang==='en'?'ar':'en');}
  document.addEventListener('DOMContentLoaded',function(){applyLang(wfdLang);});
  </script>`;
}
function langToggleBtn() { return `<button onclick="toggleLang()" style="padding:8px 14px;border-radius:8px;border:1px solid rgba(77,166,255,0.3);background:rgba(77,166,255,0.08);color:#4da6ff;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;" data-en="عربي" data-ar="English">عربي</button>`; }

function darkModeScript() {
  return `<script>
  var dm=localStorage.getItem('wfd_dm')||'dark';
  function applyDM(m){dm=m;localStorage.setItem('wfd_dm',m);
    if(m==='light'){document.body.classList.add('light-mode');}
    else{document.body.classList.remove('light-mode');}
    document.addEventListener('DOMContentLoaded',function(){
      document.querySelectorAll('[style*="color:#fff"],h1,h2,h3,h4,p,span,label,a,td,th,li,button').forEach(function(el){
        var cs=getComputedStyle(el);if(cs.color==='rgb(255, 255, 255)'||cs.color==='rgb(240, 246, 255)'){el.classList.add('dc');}
      });
    });
  }
  function toggleDM(){applyDM(dm==='dark'?'light':'dark');}
  applyDM(dm);
  </script>`;
}
function darkToggleBtn() { return `<button onclick="toggleDM()" style="padding:8px 14px;border-radius:8px;border:1px solid rgba(77,166,255,0.3);background:rgba(77,166,255,0.08);color:#4da6ff;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;" data-en="☀️/🌙" data-ar="☀️/🌙">☀️/🌙</button>`; }

function accessibilityHTML() {
  return `<div class="a11y-fab"><div class="a11y-tools" id="a11yTools">
    <button class="a11y-tool" onclick="toggleHC()" title="High Contrast" style="background:#000;color:#ffff00;border:2px solid #ffff00;">HC</button>
    <button class="a11y-tool" onclick="changeFontSize(1)" title="Increase Text" style="background:#2563eb;color:#fff;">A+</button>
    <button class="a11y-tool" onclick="changeFontSize(-1)" title="Decrease Text" style="background:#2563eb;color:#fff;">A-</button>
    </div><button class="a11y-main" onclick="document.getElementById('a11yTools').classList.toggle('open')">♿</button></div>`;
}
function accessibilityJS() {
  return `<script>
  function toggleHC(){document.body.classList.toggle('high-contrast');}
  var baseFontSize=100;
  function changeFontSize(d){baseFontSize=Math.max(80,Math.min(140,baseFontSize+d*10));document.body.style.fontSize=baseFontSize+'%';}
  </script>`;
}

function lightModeCSS() {
  return `
    body.light-mode{background:#f5f5f0 !important;color:#1a1a2e !important;}
    body.light-mode .dc{color:#1a1a2e !important;}
    body.light-mode .header,body.light-mode .hdr{background:#ffffff !important;border-bottom-color:#d0d0c8 !important;}
    body.light-mode .header a.brand h1,body.light-mode .hdr h1{color:#1a1a2e !important;}
    body.light-mode input,body.light-mode select,body.light-mode textarea{background:#fff !important;color:#1a1a2e !important;border-color:#c0c8d0 !important;}
    body.light-mode .card,body.light-mode .form-card{background:#ffffff !important;border-color:#d0d0c8 !important;}
  `;
}
function accessibilityCSS() {
  return `
    .a11y-fab{position:fixed;bottom:20px;left:20px;z-index:997;}
    .a11y-main{width:44px;height:44px;border-radius:50%;background:#2563eb;color:#fff;border:none;cursor:pointer;font-size:20px;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:transform .2s;}
    .a11y-main:hover{transform:scale(1.1);}
    .a11y-tools{display:none;flex-direction:column;gap:8px;margin-bottom:10px;}
    .a11y-tools.open{display:flex;}
    .a11y-tool{width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;font-size:14px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,0.2);transition:transform .2s;font-family:inherit;}
    .a11y-tool:hover{transform:scale(1.1);}
    body.high-contrast,body.high-contrast.light-mode{background:#000 !important;color:#ffff00 !important;}
    body.high-contrast *{color:#ffff00 !important;border-color:#fff !important;}
    body.high-contrast a{color:#00ffff !important;}
    body.high-contrast input,body.high-contrast select,body.high-contrast textarea{background:#111 !important;color:#ffff00 !important;border:2px solid #fff !important;}
  `;
}

function pageHead(title) {
  return `<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title} — Watan First Digital</title><link rel="icon" href="/logo.png" type="image/png">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <script>try{localStorage.removeItem('wfd_a11y_hc');}catch(e){}
  function wfdAlert(msg,type,cb){var ic=type==='success'?'✅':type==='error'?'❌':'ℹ️';var cl=type==='success'?'#28a745':type==='error'?'#dc3545':'#4da6ff';
  var t=document.createElement('div');t.style.cssText='position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#132a45;border:1px solid '+cl+';border-radius:12px;padding:14px 24px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.4);max-width:500px;width:90%;animation:wfdSlideDown .3s;';
  t.innerHTML='<span style="font-size:24px;flex-shrink:0;">'+ic+'</span><p style="font-size:14px;color:#fff;line-height:1.4;flex:1;">'+msg+'</p><button style="padding:6px 16px;background:'+cl+';color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;">OK</button>';
  t.querySelector('button').onclick=function(){t.style.animation='wfdSlideUp .2s forwards';setTimeout(function(){t.remove();if(cb)cb();},200);};document.body.appendChild(t);if(!cb)setTimeout(function(){if(t.parentNode){t.style.animation='wfdSlideUp .2s forwards';setTimeout(function(){t.remove();},200);}},4000);}
  </script>
  ${langToggleScript()}
  ${darkModeScript()}
  <style>
    @keyframes wfdSlideDown{from{opacity:0;top:-40px;}to{opacity:1;top:20px;}}
    @keyframes wfdSlideUp{from{opacity:1;top:20px;}to{opacity:0;top:-40px;}}
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Inter',sans-serif;background:#0a1628;color:#fff;min-height:100vh;}
    body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse at 20% 50%,rgba(77,166,255,0.06) 0%,transparent 50%);pointer-events:none;z-index:0;}
    .header{display:flex;align-items:center;justify-content:space-between;padding:16px 30px;background:rgba(10,22,40,0.95);backdrop-filter:blur(10px);border-bottom:1px solid rgba(77,166,255,0.2);position:sticky;top:0;z-index:100;flex-wrap:wrap;gap:10px;}
    .header a.brand{text-decoration:none;display:flex;align-items:center;gap:12px;}
    .header a.brand h1{font-size:18px;font-weight:700;color:#fff;}.header a.brand h1 span{color:#4da6ff;font-weight:400;}
    .header img{height:45px;}
    .header-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
    .header-nav a,.header-nav button{padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;font-family:inherit;border:1px solid rgba(77,166,255,0.3);background:rgba(77,166,255,0.08);color:#4da6ff;transition:all .2s;}
    .header-nav a:hover{background:rgba(77,166,255,0.15);}
    .container{max-width:900px;margin:30px auto;padding:0 20px;position:relative;z-index:1;}
    .card{background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:16px;padding:30px;margin-bottom:20px;}
    .page-title{font-size:28px;font-weight:700;margin-bottom:24px;text-align:center;}
    .page-title span{color:#4da6ff;font-weight:400;}
    .form-group{margin-bottom:16px;}
    .form-group label{display:block;font-size:13px;font-weight:600;color:#a0b4cc;margin-bottom:6px;}
    .form-group input,.form-group select,.form-group textarea{width:100%;padding:12px;font-size:14px;color:#fff;background:#0f2035;border:1.5px solid rgba(77,166,255,0.2);border-radius:8px;outline:none;font-family:inherit;}
    .form-group textarea{resize:vertical;min-height:80px;}
    .btn{display:inline-block;padding:12px 30px;background:linear-gradient(135deg,#4da6ff,#2b8fef);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-size:15px;font-family:inherit;transition:all .2s;}
    .btn:hover{transform:translateY(-1px);box-shadow:0 4px 15px rgba(77,166,255,0.3);}
    .btn-full{display:block;width:100%;}
    .auth-error{display:none;background:rgba(220,53,69,0.15);color:#ff6b7a;padding:12px;border-radius:8px;font-size:13px;margin-bottom:14px;text-align:center;}
    .auth-error.show{display:block;}
    .stars{display:flex;gap:4px;direction:ltr;}
    .stars .star{font-size:32px;cursor:pointer;color:#3a4a5e;transition:color .15s;}
    .stars .star.active{color:#ffc107;}
    .stars .star:hover{color:#ffd43b;}
    .section-title{font-size:20px;font-weight:700;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid rgba(77,166,255,0.2);}
    .rating-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(77,166,255,0.08);flex-wrap:wrap;gap:8px;}
    .rating-label{font-size:14px;color:#a0b4cc;flex:1;min-width:200px;}
    .trust-banner{background:rgba(40,167,69,0.1);border:1px solid rgba(40,167,69,0.3);border-radius:10px;padding:16px;text-align:center;margin-bottom:24px;}
    .trust-banner p{font-size:14px;color:#4ade80;font-weight:600;}
    .trust-banner span{font-size:12px;color:#a0b4cc;display:block;margin-top:4px;}
    .emp-card{background:rgba(77,166,255,0.05);border:1px solid rgba(77,166,255,0.15);border-radius:12px;padding:20px;margin-bottom:12px;}
    .badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700;}
    .badge-emp{background:rgba(77,166,255,0.15);color:#4da6ff;}
    .badge-sup{background:rgba(111,66,193,0.15);color:#b08aef;}
    ${lightModeCSS()}
    ${accessibilityCSS()}
    @media(max-width:600px){.header{padding:12px 16px;}.container{padding:0 12px;}.card{padding:20px;}.rating-row{flex-direction:column;align-items:flex-start;}}
  </style>`;
}

function headerHTML(user) {
  return `<header class="header">
    <a href="/dashboard" class="brand">
      <img src="/logo.png" alt="Logo">
      <h1>Watan First <span>Digital</span></h1>
    </a>
    <div class="header-nav">
      <a href="/dashboard" data-en="📊 Dashboard" data-ar="📊 لوحة التحكم">📊 Dashboard</a>
      ${langToggleBtn()} ${darkToggleBtn()}
      <a href="/logout" style="border-color:rgba(220,53,69,0.3);color:#ff6b7a;" data-en="Logout" data-ar="خروج">Logout</a>
    </div>
  </header>
  ${accessibilityHTML()}
  ${accessibilityJS()}`;
}

function footerHTML() {
  return `<div style="text-align:center;padding:30px;color:#4a6a8a;font-size:12px;">&copy; ${new Date().getFullYear()} Watan First Digital. <span data-en="All rights reserved." data-ar="جميع الحقوق محفوظة.">All rights reserved.</span></div>`;
}

function starsHTML(name, labelEn, labelAr) {
  return `<div class="rating-row">
    <span class="rating-label" data-en="${labelEn}" data-ar="${labelAr}">${labelEn}</span>
    <div class="stars" id="stars_${name}">
      ${[1,2,3,4,5].map(i => `<span class="star" data-val="${i}" onclick="setRating('${name}',${i})">★</span>`).join('')}
    </div>
    <input type="hidden" id="r_${name}" value="0">
  </div>`;
}

// ── ROUTES ──────────────────────────────────────────────────

// Landing / Login page
app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.send(`${pageHead('Employee Feedback System')}
  <body>
  <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;">
  <div style="max-width:440px;width:100%;position:relative;z-index:1;">
    <div style="text-align:center;margin-bottom:24px;">
      <img src="/logo.png" alt="Logo" style="height:70px;">
      <h1 style="margin-top:12px;font-size:22px;" data-en="🔒 Employee Feedback System" data-ar="🔒 نظام تقييم الموظفين">🔒 Employee Feedback System</h1>
      <p style="color:#a0b4cc;font-size:14px;margin-top:6px;" data-en="Anonymous feedback platform" data-ar="منصة التقييم المجهول">Anonymous feedback platform</p>
    </div>
    <div class="card">
      <div class="auth-error" id="err"></div>
      <div class="form-group"><label data-en="Email" data-ar="البريد">Email</label><input type="email" id="email"></div>
      <div class="form-group"><label data-en="Password" data-ar="كلمة المرور">Password</label>
        <div style="position:relative;"><input type="password" id="pass" style="padding-right:44px;">
        <button type="button" onclick="var i=document.getElementById('pass');i.type=i.type==='password'?'text':'password';" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:#4da6ff;cursor:pointer;font-size:18px;">👁</button></div>
      </div>
      <button class="btn btn-full" onclick="doLogin()" data-en="Login" data-ar="دخول">Login</button>
      <p style="text-align:center;margin-top:16px;font-size:13px;color:#a0b4cc;" data-en="Contact HR to get your login credentials" data-ar="تواصل مع الموارد البشرية للحصول على بيانات الدخول">Contact HR to get your login credentials</p>
    </div>
  </div></div>
  ${accessibilityHTML()}${accessibilityJS()}
  <script>
  document.getElementById('pass').addEventListener('keypress',function(e){if(e.key==='Enter')doLogin();});
  async function doLogin(){var e=document.getElementById('email').value.trim(),p=document.getElementById('pass').value,err=document.getElementById('err');
    err.classList.remove('show');
    try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})});var d=await r.json();
      if(d.success){window.location.href='/dashboard';}else{err.textContent=d.message;err.classList.add('show');}}
    catch(x){err.textContent='Network error.';err.classList.add('show');}}
  </script></body></html>`);
});

// Login API
app.post('/api/login', authLimiter, (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({success:false,message:'Email and password required.'});
    const user = getUserByEmail.get(email.trim().toLowerCase());
    if (!user) return res.status(401).json({success:false,message:'Invalid email or password.'});
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({success:false,message:'Invalid email or password.'});
    if (user.is_admin) return res.status(403).json({success:false,message:'Admin account — use the HR login page.'});
    req.session.user = {id:user.id, name:user.full_name, email:user.email, department:user.department, role:user.role};
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ── EMPLOYEE/SUPERVISOR DASHBOARD ───────────────────────────
app.get('/dashboard', requireAuth, (req, res) => {
  const user = req.session.user;
  const dbUser = getUserById.get(user.id);
  const isSuper = dbUser.role === 'supervisor';

  // Check if already submitted this month
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const existing = db.prepare('SELECT id FROM fb_reviews WHERE reviewer_id=? AND created_at>=?').get(user.id, monthStart);

  // Get ratings about this user (from supervisors if employee, from employees if supervisor)
  let myRatings = [];
  if (isSuper) {
    myRatings = db.prepare('SELECT * FROM fb_reviews WHERE target_type=\'supervisor\' AND department=? ORDER BY created_at DESC').all(dbUser.department);
  } else {
    myRatings = db.prepare('SELECT * FROM fb_reviews WHERE target_type=\'employee\' AND target_id=? ORDER BY created_at DESC').all(user.id);
  }

  // Get team members for supervisor
  let teamMembers = [];
  if (isSuper) {
    teamMembers = db.prepare('SELECT * FROM fb_users WHERE department=? AND role=\'employee\' AND is_admin=0').all(dbUser.department);
  }

  res.send(`${pageHead('Dashboard')}
  <body>
  ${headerHTML(user)}
  <div class="container">
    <h1 class="page-title" data-en="📊 <span>Dashboard</span>" data-ar="📊 <span>لوحة التحكم</span>">📊 <span>Dashboard</span></h1>

    <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;">
      <div style="flex:1;min-width:150px;background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:16px;text-align:center;">
        <p style="font-size:12px;color:#a0b4cc;" data-en="Your Role" data-ar="دورك">Your Role</p>
        <p style="font-size:18px;font-weight:700;color:${isSuper?'#b08aef':'#4da6ff'};">${isSuper?'Supervisor':'Employee'}</p>
      </div>
      <div style="flex:1;min-width:150px;background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:16px;text-align:center;">
        <p style="font-size:12px;color:#a0b4cc;" data-en="Department" data-ar="القسم">Department</p>
        <p style="font-size:18px;font-weight:700;color:#fff;">${escapeHtml(dbUser.department)}</p>
      </div>
      <div style="flex:1;min-width:150px;background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:16px;text-align:center;">
        <p style="font-size:12px;color:#a0b4cc;" data-en="This Month" data-ar="هذا الشهر">This Month</p>
        <p style="font-size:18px;font-weight:700;color:${existing?'#4ade80':'#ffc107'};">${existing?'Submitted ✅':'Not yet'}</p>
      </div>
    </div>

    <!-- SECTION 1: Give Feedback -->
    <div class="card">
      <h2 class="section-title" data-en="${isSuper?'📝 Rate Your Team Members':'📝 Submit Anonymous Feedback'}" data-ar="${isSuper?'📝 قيّم أعضاء فريقك':'📝 أرسل تقييمك المجهول'}">${isSuper?'📝 Rate Your Team Members':'📝 Submit Anonymous Feedback'}</h2>

      ${existing ? `<div style="text-align:center;padding:20px;"><p style="color:#4ade80;font-size:16px;font-weight:600;" data-en="✅ You already submitted feedback this month" data-ar="✅ لقد أرسلت تقييمك هذا الشهر">✅ You already submitted feedback this month</p><p style="color:#a0b4cc;font-size:13px;margin-top:8px;" data-en="You can submit again next month" data-ar="يمكنك الإرسال مرة أخرى الشهر القادم">You can submit again next month</p></div>` : `

      ${!isSuper ? `
      <div class="trust-banner">
        <p data-en="🔒 Your feedback is 100% anonymous. Be honest — your name will never be shown." data-ar="🔒 تقييمك مجهول تماماً. كن صادقاً — لن يظهر اسمك أبداً.">🔒 Your feedback is 100% anonymous. Be honest — your name will never be shown.</p>
        <span data-en="Your honest opinion helps make the company better for everyone." data-ar="رأيك الصادق يساعد في تحسين الشركة للجميع.">Your honest opinion helps make the company better for everyone.</span>
      </div>

      <h3 style="font-size:16px;color:#4da6ff;margin-bottom:12px;" data-en="Section 1: Your Job" data-ar="القسم ١: وظيفتك">Section 1: Your Job</h3>
      ${starsHTML('job_satisfaction','How happy are you with your daily tasks?','ما مدى رضاك عن مهامك اليومية؟')}
      ${starsHTML('salary_benefits','How fair is your compensation?','ما مدى عدالة تعويضاتك؟')}
      ${starsHTML('growth_training','Do you have opportunities to develop your skills?','هل لديك فرص لتطوير مهاراتك؟')}

      <h3 style="font-size:16px;color:#4da6ff;margin:20px 0 12px;" data-en="Section 2: Your Supervisor" data-ar="القسم ٢: مشرفك">Section 2: Your Supervisor</h3>
      ${starsHTML('sup_communication','Does your supervisor communicate clearly?','هل يتواصل مشرفك بوضوح؟')}
      ${starsHTML('sup_support','Does your supervisor help when you face problems?','هل يساعدك مشرفك عند مواجهة المشاكل؟')}
      ${starsHTML('sup_fairness','Does your supervisor treat everyone equally?','هل يعامل مشرفك الجميع بعدالة؟')}

      <h3 style="font-size:16px;color:#4da6ff;margin:20px 0 12px;" data-en="Section 3: Your Team" data-ar="القسم ٣: فريقك">Section 3: Your Team</h3>
      ${starsHTML('team_teamwork','Does your team cooperate and work well together?','هل يتعاون فريقك ويعمل بشكل جيد معاً؟')}
      ${starsHTML('team_respect','Do your colleagues treat each other with respect?','هل يتعامل زملاؤك مع بعضهم باحترام؟')}

      <div class="form-group" style="margin-top:20px;">
        <label data-en="💬 What would you change to make the company better? (optional)" data-ar="💬 ما الذي تغيره لتحسين الشركة؟ (اختياري)">💬 What would you change to make the company better? (optional)</label>
        <textarea id="comment" placeholder="Your suggestions..."></textarea>
      </div>
      <button class="btn btn-full" onclick="submitFeedback()" data-en="Submit Anonymous Feedback" data-ar="إرسال التقييم المجهول">Submit Anonymous Feedback</button>
      ` : `
      <!-- Supervisor rates each team member -->
      ${teamMembers.length === 0 ? '<p style="color:#a0b4cc;text-align:center;">No team members in your department.</p>' :
        teamMembers.map((tm, idx) => `
        <div class="emp-card" id="emp_${tm.id}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div><h3 style="font-size:16px;">${escapeHtml(tm.full_name)}</h3><span class="badge badge-emp">${escapeHtml(tm.department)}</span></div>
          </div>
          ${starsHTML('emp_performance_'+idx,'Performance — How well does this employee do their job?','الأداء — ما مدى جودة أداء هذا الموظف؟')}
          ${starsHTML('emp_punctuality_'+idx,'Punctuality — Does this employee arrive on time and meet deadlines?','الالتزام — هل يصل هذا الموظف في الوقت ويلتزم بالمواعيد؟')}
          ${starsHTML('emp_attitude_'+idx,'Attitude — Is this employee positive and professional?','السلوك — هل هذا الموظف إيجابي ومهني؟')}
          ${starsHTML('emp_initiative_'+idx,'Initiative — Does this employee take action without being asked?','المبادرة — هل يتخذ هذا الموظف إجراءات دون أن يُطلب منه؟')}
          <div class="form-group" style="margin-top:12px;">
            <label data-en="Written feedback for ${escapeHtml(tm.full_name)} (visible to them)" data-ar="تقييم مكتوب لـ ${escapeHtml(tm.full_name)} (مرئي لهم)">Written feedback for ${escapeHtml(tm.full_name)} (visible to them)</label>
            <textarea id="sup_comment_${idx}" placeholder="Your feedback..."></textarea>
          </div>
        </div>`).join('')}
      <button class="btn btn-full" onclick="submitSupReview()" data-en="Submit Team Ratings" data-ar="إرسال تقييمات الفريق">Submit Team Ratings</button>
      `}
      `}
    </div>

    <!-- SECTION 2: Your Ratings -->
    <div class="card">
      <h2 class="section-title" data-en="${isSuper?'📈 Feedback About You (Anonymous)':'📈 Your Ratings from Supervisor'}" data-ar="${isSuper?'📈 التقييمات عنك (مجهولة)':'📈 تقييماتك من المشرف'}">${isSuper?'📈 Feedback About You (Anonymous)':'📈 Your Ratings from Supervisor'}</h2>
      ${myRatings.length === 0 ? `<p style="text-align:center;color:#a0b4cc;padding:20px;" data-en="No ratings yet." data-ar="لا توجد تقييمات بعد.">No ratings yet.</p>` :
        isSuper ?
        `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
          <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:16px;text-align:center;"><p style="font-size:12px;color:#a0b4cc;">Communication</p><p style="font-size:24px;font-weight:700;color:#4da6ff;">${(myRatings.reduce((s,r)=>s+(r.sup_communication||0),0)/myRatings.filter(r=>r.sup_communication).length||0).toFixed(1)} ★</p></div>
          <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:16px;text-align:center;"><p style="font-size:12px;color:#a0b4cc;">Support</p><p style="font-size:24px;font-weight:700;color:#4da6ff;">${(myRatings.reduce((s,r)=>s+(r.sup_support||0),0)/myRatings.filter(r=>r.sup_support).length||0).toFixed(1)} ★</p></div>
          <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:16px;text-align:center;"><p style="font-size:12px;color:#a0b4cc;">Fairness</p><p style="font-size:24px;font-weight:700;color:#4da6ff;">${(myRatings.reduce((s,r)=>s+(r.sup_fairness||0),0)/myRatings.filter(r=>r.sup_fairness).length||0).toFixed(1)} ★</p></div>
        </div>
        <p style="text-align:center;margin-top:12px;color:#a0b4cc;font-size:12px;">${myRatings.length} anonymous review(s)</p>` :
        myRatings.map(r => `<div class="emp-card">
          <p style="font-size:12px;color:#a0b4cc;margin-bottom:8px;">${new Date(r.created_at+'Z').toLocaleDateString('en-US',{year:'numeric',month:'short'})}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div><span style="font-size:12px;color:#a0b4cc;">Performance</span><br><span style="color:#ffc107;">${'★'.repeat(r.emp_performance||0)}${'☆'.repeat(5-(r.emp_performance||0))}</span></div>
            <div><span style="font-size:12px;color:#a0b4cc;">Punctuality</span><br><span style="color:#ffc107;">${'★'.repeat(r.emp_punctuality||0)}${'☆'.repeat(5-(r.emp_punctuality||0))}</span></div>
            <div><span style="font-size:12px;color:#a0b4cc;">Attitude</span><br><span style="color:#ffc107;">${'★'.repeat(r.emp_attitude||0)}${'☆'.repeat(5-(r.emp_attitude||0))}</span></div>
            <div><span style="font-size:12px;color:#a0b4cc;">Initiative</span><br><span style="color:#ffc107;">${'★'.repeat(r.emp_initiative||0)}${'☆'.repeat(5-(r.emp_initiative||0))}</span></div>
          </div>
          ${r.sup_comment?`<p style="margin-top:10px;padding:10px;background:rgba(77,166,255,0.08);border-radius:8px;font-size:13px;color:#a0b4cc;">💬 ${escapeHtml(r.sup_comment)}</p>`:''}
        </div>`).join('')
      }
    </div>
  </div>
  ${footerHTML()}
  <script>
  function setRating(name,val){
    document.getElementById('r_'+name).value=val;
    var stars=document.getElementById('stars_'+name).querySelectorAll('.star');
    stars.forEach(function(s,i){s.classList.toggle('active',i<val);});
  }
  async function submitFeedback(){
    var data={
      job_satisfaction:parseInt(document.getElementById('r_job_satisfaction').value),
      salary_benefits:parseInt(document.getElementById('r_salary_benefits').value),
      growth_training:parseInt(document.getElementById('r_growth_training').value),
      sup_communication:parseInt(document.getElementById('r_sup_communication').value),
      sup_support:parseInt(document.getElementById('r_sup_support').value),
      sup_fairness:parseInt(document.getElementById('r_sup_fairness').value),
      team_teamwork:parseInt(document.getElementById('r_team_teamwork').value),
      team_respect:parseInt(document.getElementById('r_team_respect').value),
      comment:document.getElementById('comment').value.trim()
    };
    if(Object.values(data).some(function(v){return typeof v==='number'&&v===0;})){wfdAlert('Please rate all categories (1-5 stars).','error');return;}
    try{var r=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});var d=await r.json();
      if(d.success){wfdAlert('Thank you for your honest feedback!','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  async function submitSupReview(){
    var reviews=[];
    ${isSuper ? teamMembers.map((tm, idx) => `
    reviews.push({target_id:'${tm.id}',emp_performance:parseInt(document.getElementById('r_emp_performance_${idx}').value),emp_punctuality:parseInt(document.getElementById('r_emp_punctuality_${idx}').value),emp_attitude:parseInt(document.getElementById('r_emp_attitude_${idx}').value),emp_initiative:parseInt(document.getElementById('r_emp_initiative_${idx}').value),sup_comment:document.getElementById('sup_comment_${idx}').value.trim()});
    `).join('') : ''}
    for(var i=0;i<reviews.length;i++){if(reviews[i].emp_performance===0||reviews[i].emp_punctuality===0||reviews[i].emp_attitude===0||reviews[i].emp_initiative===0){wfdAlert('Please rate all categories for every team member.','error');return;}}
    try{var r=await fetch('/api/supervisor-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reviews:reviews})});var d=await r.json();
      if(d.success){wfdAlert('Team ratings submitted!','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  </script></body></html>`);
});

// ── FEEDBACK API (anonymous) ────────────────────────────────
app.post('/api/feedback', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const dbUser = getUserById.get(user.id);
    // Check monthly limit
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const existing = db.prepare('SELECT id FROM fb_reviews WHERE reviewer_id=? AND created_at>=?').get(user.id, monthStart);
    if (existing) return res.status(400).json({success:false,message:'You already submitted feedback this month.'});

    const { job_satisfaction, salary_benefits, growth_training, sup_communication, sup_support, sup_fairness, team_teamwork, team_respect, comment } = req.body;
    const id = uuidv4();
    db.prepare('INSERT INTO fb_reviews (id,reviewer_id,reviewer_role,target_type,target_id,department,job_satisfaction,salary_benefits,growth_training,sup_communication,sup_support,sup_fairness,team_teamwork,team_respect,comment,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, 'employee', 'supervisor', null, dbUser.department, job_satisfaction, salary_benefits, growth_training, sup_communication, sup_support, sup_fairness, team_teamwork, team_respect, comment||null, new Date().toISOString());
    cloudInsert('fb_reviews', {id, reviewer_id:user.id, reviewer_role:'employee', target_type:'supervisor', department:dbUser.department, job_satisfaction, salary_benefits, growth_training, sup_communication, sup_support, sup_fairness, team_teamwork, team_respect, comment:comment||null, created_at:new Date().toISOString()});
    res.json({success:true});
  } catch(e) { console.error('[ERROR] Feedback:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── SUPERVISOR REVIEW API ───────────────────────────────────
app.post('/api/supervisor-review', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const dbUser = getUserById.get(user.id);
    if (dbUser.role !== 'supervisor') return res.status(403).json({success:false,message:'Not a supervisor.'});
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const existing = db.prepare('SELECT id FROM fb_reviews WHERE reviewer_id=? AND created_at>=?').get(user.id, monthStart);
    if (existing) return res.status(400).json({success:false,message:'You already submitted ratings this month.'});

    const { reviews } = req.body;
    if (!reviews || !reviews.length) return res.status(400).json({success:false,message:'No reviews.'});
    for (const r of reviews) {
      const id = uuidv4();
      db.prepare('INSERT INTO fb_reviews (id,reviewer_id,reviewer_role,target_type,target_id,department,emp_performance,emp_punctuality,emp_attitude,emp_initiative,sup_comment,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, user.id, 'supervisor', 'employee', r.target_id, dbUser.department, r.emp_performance, r.emp_punctuality, r.emp_attitude, r.emp_initiative, r.sup_comment||null, new Date().toISOString());
      cloudInsert('fb_reviews', {id, reviewer_id:user.id, reviewer_role:'supervisor', target_type:'employee', target_id:r.target_id, department:dbUser.department, emp_performance:r.emp_performance, emp_punctuality:r.emp_punctuality, emp_attitude:r.emp_attitude, emp_initiative:r.emp_initiative, sup_comment:r.sup_comment||null, created_at:new Date().toISOString()});
    }
    res.json({success:true});
  } catch(e) { console.error('[ERROR] Sup review:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── HR ADMIN ────────────────────────────────────────────────
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin/dashboard');
  res.send(`${pageHead('HR Admin Login')}
  <body>
  <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;">
  <div style="max-width:400px;width:100%;position:relative;z-index:1;">
    <div style="text-align:center;margin-bottom:24px;"><img src="/logo.png" alt="Logo" style="height:70px;"><h2 style="margin-top:12px;" data-en="🔒 HR Admin Login" data-ar="🔒 دخول المشرف">🔒 HR Admin Login</h2></div>
    <div class="card">
      <div class="auth-error" id="aErr"></div>
      <div class="form-group"><label>Email</label><input type="email" id="aEmail" value="admin@watanfirst.com"></div>
      <div class="form-group"><label>Password</label><input type="password" id="aPass"></div>
      <button class="btn btn-full" onclick="adminLogin()" data-en="Login" data-ar="دخول">Login</button>
    </div>
  </div></div>
  ${accessibilityHTML()}${accessibilityJS()}
  <script>
  document.getElementById('aPass').addEventListener('keypress',function(e){if(e.key==='Enter')adminLogin();});
  async function adminLogin(){var e=document.getElementById('aEmail').value,p=document.getElementById('aPass').value,err=document.getElementById('aErr');
    err.classList.remove('show');
    try{var r=await fetch('/api/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})});var d=await r.json();
      if(d.success){window.location.href='/admin/dashboard';}else{err.textContent=d.message;err.classList.add('show');}}
    catch(x){err.textContent='Error.';err.classList.add('show');}}
  </script></body></html>`);
});

app.post('/api/admin-login', authLimiter, (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({success:false,message:'Email and password required.'});
    const user = getUserByEmail.get(email.trim().toLowerCase());
    if (!user) return res.status(401).json({success:false,message:'Invalid email or password.'});
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({success:false,message:'Invalid email or password.'});
    if (!user.is_admin) return res.status(403).json({success:false,message:'Not an admin account.'});
    req.session.admin = {id:user.id, name:user.full_name, email:user.email};
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

app.get('/admin/logout', (req, res) => { if(req.session) req.session.admin=null; res.redirect('/admin/login'); });

// ── HR DASHBOARD ────────────────────────────────────────────
app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const allReviews = db.prepare('SELECT * FROM fb_reviews ORDER BY created_at DESC').all();
  const empReviews = allReviews.filter(r => r.reviewer_role === 'employee');
  const supReviews = allReviews.filter(r => r.reviewer_role === 'supervisor');
  const allEmps = db.prepare('SELECT * FROM fb_users WHERE is_admin=0').all();
  const departments = [...new Set(allEmps.map(u => u.department))];

  // Calculate averages for employee feedback
  function avg(arr, field) {
    const valid = arr.filter(r => r[field]);
    return valid.length ? (valid.reduce((s,r) => s+r[field], 0) / valid.length).toFixed(1) : '—';
  }
  const overallAvg = empReviews.length ? (
    ['job_satisfaction','salary_benefits','growth_training','sup_communication','sup_support','sup_fairness','team_teamwork','team_respect']
    .reduce((s, f) => { const v = empReviews.filter(r=>r[f]); return s + (v.length ? v.reduce((a,r)=>a+r[f],0)/v.length : 0); }, 0) / 8
  ).toFixed(1) : '—';

  res.send(`${pageHead('HR Dashboard')}
  <body>
  <header class="header">
    <a href="/admin/dashboard" class="brand"><img src="/logo.png" alt="Logo"><h1>Watan First <span>Digital</span></h1></a>
    <div class="header-nav">
      <a href="/admin/dashboard" data-en="📊 Dashboard" data-ar="📊 لوحة التحكم">📊 Dashboard</a>
      <a href="/admin/manage" data-en="👥 Manage Users" data-ar="👥 إدارة المستخدمين">👥 Manage Users</a>
      ${langToggleBtn()} ${darkToggleBtn()}
      <a href="/admin/logout" style="border-color:rgba(220,53,69,0.3);color:#ff6b7a;" data-en="Logout" data-ar="خروج">Logout</a>
    </div>
  </header>
  ${accessibilityHTML()}${accessibilityJS()}
  <div class="container" style="max-width:1100px;">
    <h1 class="page-title" data-en="📊 HR <span>Analytics</span>" data-ar="📊 <span>التحليلات</span>">📊 HR <span>Analytics</span></h1>

    <!-- Stats Cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-bottom:24px;">
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #4da6ff;">
        <p style="font-size:28px;font-weight:700;color:#4da6ff;">${empReviews.length}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="Employee Reviews" data-ar="تقييمات الموظفين">Employee Reviews</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #6f42c1;">
        <p style="font-size:28px;font-weight:700;color:#b08aef;">${supReviews.length}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="Supervisor Ratings" data-ar="تقييمات المشرفين">Supervisor Ratings</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #ffc107;">
        <p style="font-size:28px;font-weight:700;color:#ffc107;">${overallAvg}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="Overall Average" data-ar="المعدل العام">Overall Average</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #28a745;">
        <p style="font-size:28px;font-weight:700;color:#4ade80;">${allEmps.length}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="Total Employees" data-ar="إجمالي الموظفين">Total Employees</p>
      </div>
    </div>

    <!-- Section 1: Employee Feedback (Anonymous) -->
    <div class="card">
      <h2 class="section-title" data-en="📝 Employee → Supervisor Feedback (Anonymous)" data-ar="📝 تقييم الموظف → المشرف (مجهول)">📝 Employee → Supervisor Feedback (Anonymous)</h2>
      ${empReviews.length === 0 ? '<p style="text-align:center;color:#a0b4cc;padding:20px;">No feedback submitted yet.</p>' : `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px;">
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="Job Satisfaction" data-ar="الرضا الوظيفي">Job Satisfaction</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(empReviews,'job_satisfaction')} ★</p></div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="Salary & Benefits" data-ar="الراتب والمزايا">Salary & Benefits</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(empReviews,'salary_benefits')} ★</p></div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="Growth & Training" data-ar="النمو والتدريب">Growth & Training</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(empReviews,'growth_training')} ★</p></div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="Sup. Communication" data-ar="تواصل المشرف">Sup. Communication</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(empReviews,'sup_communication')} ★</p></div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="Sup. Support" data-ar="دعم المشرف">Sup. Support</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(empReviews,'sup_support')} ★</p></div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="Sup. Fairness" data-ar="عدالة المشرف">Sup. Fairness</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(empReviews,'sup_fairness')} ★</p></div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="Teamwork" data-ar="العمل الجماعي">Teamwork</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(empReviews,'team_teamwork')} ★</p></div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="Respect" data-ar="الاحترام">Respect</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(empReviews,'team_respect')} ★</p></div>
      </div>
      <h3 style="font-size:14px;color:#a0b4cc;margin-bottom:12px;" data-en="Anonymous Comments:" data-ar="التعليقات المجهولة:">Anonymous Comments:</h3>
      ${empReviews.filter(r=>r.comment).map(r => `<div style="background:rgba(77,166,255,0.05);border-radius:8px;padding:12px;margin-bottom:8px;"><p style="font-size:13px;color:#e0eaff;">💬 ${escapeHtml(r.comment)}</p><span style="font-size:11px;color:#4a6a8a;">${r.department} · ${new Date(r.created_at+'Z').toLocaleDateString('en-US',{year:'numeric',month:'short'})}</span></div>`).join('')||'<p style="color:#4a6a8a;font-size:13px;">No comments.</p>'}
      `}
    </div>

    <!-- Section 2: Supervisor → Employee Ratings -->
    <div class="card">
      <h2 class="section-title" data-en="👔 Supervisor → Employee Ratings" data-ar="👔 تقييم المشرف → الموظف">👔 Supervisor → Employee Ratings</h2>
      ${supReviews.length === 0 ? '<p style="text-align:center;color:#a0b4cc;padding:20px;">No supervisor ratings yet.</p>' :
        supReviews.map(r => {
          const emp = getUserById.get(r.target_id);
          return `<div class="emp-card">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div><h3 style="font-size:15px;">${emp?escapeHtml(emp.full_name):'Unknown'}</h3><span class="badge badge-emp">${escapeHtml(r.department)}</span></div>
              <span style="font-size:12px;color:#4a6a8a;">${new Date(r.created_at+'Z').toLocaleDateString('en-US',{year:'numeric',month:'short'})}</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;">
              <div><span style="font-size:11px;color:#a0b4cc;">Performance</span> <span style="color:#ffc107;">${'★'.repeat(r.emp_performance||0)}</span></div>
              <div><span style="font-size:11px;color:#a0b4cc;">Punctuality</span> <span style="color:#ffc107;">${'★'.repeat(r.emp_punctuality||0)}</span></div>
              <div><span style="font-size:11px;color:#a0b4cc;">Attitude</span> <span style="color:#ffc107;">${'★'.repeat(r.emp_attitude||0)}</span></div>
              <div><span style="font-size:11px;color:#a0b4cc;">Initiative</span> <span style="color:#ffc107;">${'★'.repeat(r.emp_initiative||0)}</span></div>
            </div>
            ${r.sup_comment?`<p style="margin-top:8px;font-size:13px;color:#a0b4cc;">💬 ${escapeHtml(r.sup_comment)}</p>`:''}
          </div>`;
        }).join('')}
    </div>
  </div>
  ${footerHTML()}
  </body></html>`);
});

// ── MANAGE USERS ────────────────────────────────────────────
app.get('/admin/manage', requireAdmin, (req, res) => {
  const allUsers = db.prepare('SELECT * FROM fb_users WHERE is_admin=0 ORDER BY department,role,full_name').all();
  res.send(`${pageHead('Manage Users')}
  <body>
  <header class="header">
    <a href="/admin/dashboard" class="brand"><img src="/logo.png" alt="Logo"><h1>Watan First <span>Digital</span></h1></a>
    <div class="header-nav">
      <a href="/admin/dashboard" data-en="📊 Dashboard" data-ar="📊 لوحة التحكم">📊 Dashboard</a>
      <a href="/admin/manage" data-en="👥 Manage Users" data-ar="👥 إدارة المستخدمين">👥 Manage Users</a>
      ${langToggleBtn()} ${darkToggleBtn()}
      <a href="/admin/logout" style="border-color:rgba(220,53,69,0.3);color:#ff6b7a;" data-en="Logout" data-ar="خروج">Logout</a>
    </div>
  </header>
  ${accessibilityHTML()}${accessibilityJS()}
  <div class="container" style="max-width:900px;">
    <h1 class="page-title" data-en="👥 Manage <span>Users</span>" data-ar="👥 إدارة <span>المستخدمين</span>">👥 Manage <span>Users</span></h1>

    <!-- Add User Form -->
    <div class="card">
      <h2 class="section-title" data-en="➕ Add New Employee / Supervisor" data-ar="➕ إضافة موظف / مشرف جديد">➕ Add New Employee / Supervisor</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group"><label data-en="Full Name" data-ar="الاسم الكامل">Full Name</label><input type="text" id="aName"></div>
        <div class="form-group"><label data-en="Email" data-ar="البريد">Email</label><input type="email" id="aEmailAdd"></div>
        <div class="form-group"><label data-en="Password" data-ar="كلمة المرور">Password</label><input type="text" id="aPassAdd" placeholder="e.g. Employee123$"></div>
        <div class="form-group"><label data-en="Department" data-ar="القسم">Department</label>
          <select id="aDept">
            <option value="Human Resources">Human Resources</option>
            <option value="Engineering">Engineering</option>
            <option value="Operations">Operations</option>
            <option value="Sales">Sales</option>
            <option value="Marketing">Marketing</option>
            <option value="Finance">Finance</option>
            <option value="Medical">Medical</option>
            <option value="Hospitality">Hospitality</option>
          </select>
        </div>
        <div class="form-group"><label data-en="Role" data-ar="الدور">Role</label>
          <select id="aRole"><option value="employee">Employee</option><option value="supervisor">Supervisor</option></select>
        </div>
      </div>
      <button class="btn" onclick="addUser()" data-en="Add User" data-ar="إضافة مستخدم">Add User</button>
      <div id="addMsg" style="display:none;margin-top:10px;padding:10px;border-radius:8px;font-size:13px;"></div>
    </div>

    <!-- User List -->
    <div class="card">
      <h2 class="section-title" data-en="👥 All Users (${allUsers.length})" data-ar="👥 جميع المستخدمين (${allUsers.length})">👥 All Users (${allUsers.length})</h2>
      ${allUsers.length===0?'<p style="text-align:center;color:#a0b4cc;">No users yet. Add employees above.</p>':
        allUsers.map(u => `<div class="emp-card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <h3 style="font-size:15px;">${escapeHtml(u.full_name)}</h3>
            <span style="font-size:12px;color:#a0b4cc;">${escapeHtml(u.email)}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="badge ${u.role==='supervisor'?'badge-sup':'badge-emp'}">${u.role}</span>
            <span class="badge" style="background:rgba(255,255,255,0.05);color:#a0b4cc;">${escapeHtml(u.department)}</span>
            <button onclick="deleteUser('${u.id}','${escapeHtml(u.full_name)}')" style="padding:4px 10px;background:rgba(220,53,69,0.15);color:#ff6b7a;border:1px solid rgba(220,53,69,0.3);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;">🗑️</button>
          </div>
        </div>`).join('')}
    </div>
  </div>
  ${footerHTML()}
  <script>
  function wfdAlert(msg,type,cb){var ic=type==='success'?'✅':type==='error'?'❌':'ℹ️';var cl=type==='success'?'#28a745':type==='error'?'#dc3545':'#4da6ff';var t=document.createElement('div');t.style.cssText='position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#132a45;border:1px solid '+cl+';border-radius:12px;padding:14px 24px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.4);max-width:500px;width:90%;';t.innerHTML='<span style="font-size:24px;flex-shrink:0;">'+ic+'</span><p style="font-size:14px;color:#fff;line-height:1.4;flex:1;">'+msg+'</p><button style="padding:6px 16px;background:'+cl+';color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;">OK</button>';t.querySelector('button').onclick=function(){t.remove();if(cb)cb();};document.body.appendChild(t);if(!cb)setTimeout(function(){if(t.parentNode)t.remove();},4000);}
  async function addUser(){var n=document.getElementById('aName').value.trim(),e=document.getElementById('aEmailAdd').value.trim(),p=document.getElementById('aPassAdd').value,d=document.getElementById('aDept').value,r=document.getElementById('aRole').value;
    if(!n||!e||!p){wfdAlert('All fields required.','error');return;}
    try{var res=await fetch('/api/admin/add-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,email:e,password:p,department:d,role:r})});var data=await res.json();
      if(data.success){wfdAlert('User added!','success',function(){location.reload();});}
      else{wfdAlert(data.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}
  }
  async function deleteUser(id,name){if(!confirm('Delete user "'+name+'"? This cannot be undone.'))return;
    try{var r=await fetch('/api/admin/delete-user/'+id,{method:'DELETE'});var d=await r.json();
      if(d.success){wfdAlert('User deleted.','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}
  }
  </script></body></html>`);
});

// Add user API
app.post('/api/admin/add-user', requireAdmin, (req, res) => {
  try {
    const { name, email, password, department, role } = req.body;
    if (!name||!email||!password||!department) return res.status(400).json({success:false,message:'All fields required.'});
    if (getUserByEmail.get(email.toLowerCase())) return res.status(400).json({success:false,message:'Email already exists.'});
    const id = uuidv4(), hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO fb_users (id,full_name,email,password_hash,department,role,is_admin) VALUES (?,?,?,?,?,?,0)')
      .run(id, name.trim(), email.toLowerCase(), hash, department, role||'employee');
    cloudInsert('fb_users', {id, full_name:name.trim(), email:email.toLowerCase(), password_hash:hash, department, role:role||'employee', is_admin:0, created_at:new Date().toISOString()});
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

// Delete user API
app.delete('/api/admin/delete-user/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM fb_users WHERE id=? AND is_admin=0').run(id);
    db.prepare('DELETE FROM fb_reviews WHERE reviewer_id=? OR target_id=?').run(id, id);
    try { await supabase.from('fb_users').delete().eq('id', id); } catch(e) {}
    try { await supabase.from('fb_reviews').delete().or(`reviewer_id.eq.${id},target_id.eq.${id}`); } catch(e) {}
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n=============================================`);
  console.log(`  Watan First Digital — Feedback System v1`);
  console.log(`  Running at:  http://localhost:${PORT}`);
  console.log(`  Admin:       admin@watanfirst.com / Admin123$`);
  console.log(`=============================================`);
  await loadFromSupabase();
  // Seed admin
  const adminUser = db.prepare('SELECT * FROM fb_users WHERE LOWER(email)=\'admin@watanfirst.com\'').get();
  if (!adminUser) {
    const id = uuidv4(), hash = bcrypt.hashSync('Admin123$', 10);
    db.prepare('INSERT INTO fb_users (id,full_name,email,password_hash,department,role,is_admin) VALUES (?,?,?,?,?,?,1)')
      .run(id, 'Admin', 'admin@watanfirst.com', hash, 'Human Resources', 'admin');
    cloudInsert('fb_users', {id, full_name:'Admin', email:'admin@watanfirst.com', password_hash:hash, department:'Human Resources', role:'admin', is_admin:1, created_at:new Date().toISOString()});
    console.log('[OK] Admin created');
  } else {
    if (!adminUser.is_admin) {
      db.prepare('UPDATE fb_users SET is_admin=1 WHERE id=?').run(adminUser.id);
    }
    console.log('[OK] Admin loaded');
  }
  console.log(`=============================================\n`);
});
