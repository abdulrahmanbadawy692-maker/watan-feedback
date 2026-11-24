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
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const SMTP_FROM_ADDR = 'abdulrahmanbadawy692@gmail.com';

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

// Add plain_password column for HR to view (safe try — ignores if already exists)
try { db.exec(`ALTER TABLE fb_users ADD COLUMN plain_password TEXT`); } catch(e) {}

// Departments table (custom — HR can add/remove)
db.exec(`CREATE TABLE IF NOT EXISTS fb_departments (name TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

// Suggestions table (anonymous suggestion box)
db.exec(`CREATE TABLE IF NOT EXISTS fb_suggestions (
  id TEXT PRIMARY KEY,
  department TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  hr_comment TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Helper: auto-confirm drafts older than 1 hour
function autoConfirmDrafts() {
  const oneHourAgo = new Date(Date.now() - 60*60*1000).toISOString();
  const drafts = db.prepare("SELECT id FROM fb_suggestions WHERE status='draft' AND created_at<=?").all(oneHourAgo);
  for (const d of drafts) {
    db.prepare("UPDATE fb_suggestions SET status='pending' WHERE id=?").run(d.id);
    cloudUpdate('fb_suggestions', d.id, {status:'pending'});
  }
  if (drafts.length) console.log(`[SUGGESTIONS] Auto-confirmed ${drafts.length} draft(s)`);
}

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
        db.prepare('INSERT OR REPLACE INTO fb_users (id,full_name,email,password_hash,department,role,is_admin,created_at,plain_password) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(u.id,u.full_name,u.email,u.password_hash,u.department,u.role||'employee',u.is_admin||0,u.created_at,u.plain_password||null);
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
    // Load departments
    let rd = 0;
    try {
      const { data: depts } = await supabase.from('fb_departments').select('*');
      for (const d of (depts||[])) {
        try { db.prepare('INSERT OR REPLACE INTO fb_departments (name,created_at) VALUES (?,?)').run(d.name,d.created_at); rd++; } catch(e) {}
      }
    } catch(e) { console.log('[DB] fb_departments not in Supabase yet — using local only'); }
    // Load suggestions
    let rs = 0;
    try {
      const { data: suggestions } = await supabase.from('fb_suggestions').select('*');
      for (const s of (suggestions||[])) {
        try { db.prepare('INSERT OR REPLACE INTO fb_suggestions (id,department,suggestion,status,hr_comment,responded_at,created_at) VALUES (?,?,?,?,?,?,?)').run(s.id,s.department,s.suggestion,s.status||'pending',s.hr_comment||null,s.responded_at||null,s.created_at); rs++; } catch(e) {}
      }
    } catch(e) { console.log('[DB] fb_suggestions not in Supabase yet'); }
    console.log(`[DB] ✅ Loaded ${ru} users, ${rr} reviews, ${rd} departments, ${rs} suggestions`);
    return true;
  } catch(e) { console.log('[DB] Load error:', e.message); return false; }
}

// ── Brevo Email ────────────────────────────────────────────
async function sendBrevoEmail(to, subject, html) {
  if (!BREVO_API_KEY) { console.log('[EMAIL] Skipped (no API key) →', to); return; }
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({ sender: { name: 'Watan First Digital', email: SMTP_FROM_ADDR }, to: [{ email: to }], subject, htmlContent: html })
    });
    console.log('[EMAIL] Sent to', to);
  } catch(e) { console.error('[EMAIL] Failed:', e.message); }
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
function eyeBtn(inputId) {
  return `<button type="button" onclick="toggleEye('${inputId}',this)" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:#4da6ff;cursor:pointer;display:flex;align-items:center;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></button>`;
}
function fmtDate(d) { try { const dt = new Date(d && (d.includes('Z')||d.includes('+')) ? d : (d||'')+'Z'); return isNaN(dt.getTime()) ? (d||'').slice(0,10)||'—' : dt.toLocaleDateString('en-US',{year:'numeric',month:'short'}); } catch(e) { return '—'; } }

// Employee of the Month calculator
function getEmployeeOfTheMonth() {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const monthName = now.toLocaleString('en-US', {month:'long', year:'numeric'});
  // Get all supervisor→employee ratings this month
  const supRatings = db.prepare("SELECT * FROM fb_reviews WHERE reviewer_role='supervisor' AND target_type='employee' AND target_id IS NOT NULL AND created_at>=?").all(monthStart);
  if (supRatings.length === 0) return null;
  // Calculate average per employee
  const empScores = {};
  for (const r of supRatings) {
    if (!empScores[r.target_id]) empScores[r.target_id] = {scores:[], total:0, count:0};
    const avg = ((r.emp_performance||0)+(r.emp_punctuality||0)+(r.emp_attitude||0)+(r.emp_initiative||0))/4;
    empScores[r.target_id].scores.push(avg);
    empScores[r.target_id].total += avg;
    empScores[r.target_id].count++;
  }
  // Find the top scorer
  let topId = null, topAvg = 0;
  for (const [id, data] of Object.entries(empScores)) {
    const avg = data.total / data.count;
    if (avg > topAvg) { topAvg = avg; topId = id; }
  }
  if (!topId) return null;
  const emp = getUserById.get(topId);
  if (!emp) return null;
  const topData = empScores[topId];
  return { id: topId, name: emp.full_name, department: emp.department, avg: topAvg.toFixed(1), ratings: topData.count, month: monthName };
}

// ── Shared HTML Helpers ─────────────────────────────────────
function langToggleScript() {
  return `<script>
  var wfdLang=localStorage.getItem('wfd_lang')||'en';
  function applyLang(l){wfdLang=l;localStorage.setItem('wfd_lang',l);
    document.documentElement.dir=l==='ar'?'rtl':'ltr';
    document.documentElement.lang=l;
    document.querySelectorAll('[data-en]').forEach(function(el){el.textContent=l==='ar'?(el.getAttribute('data-ar')||el.getAttribute('data-en')):el.getAttribute('data-en');});
    document.querySelectorAll('[data-en-html]').forEach(function(el){el.innerHTML=l==='ar'?(el.getAttribute('data-ar-html')||el.getAttribute('data-en-html')):el.getAttribute('data-en-html');});
    // Update star rating labels to match language
    if(typeof ratingLabels!=='undefined'){document.querySelectorAll('.star-label').forEach(function(lb){var id=lb.id.replace('label_','');var val=parseInt(document.getElementById('r_'+id)?.value||0);if(val&&ratingLabels[val]){lb.textContent=l==='ar'?ratingLabels[val][1]:ratingLabels[val][0];}});}
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
    if(document.body){
      if(m==='light'){document.body.classList.add('light-mode');}
      else{document.body.classList.remove('light-mode');}
    }
    if(document.documentElement){
      document.documentElement.setAttribute('data-theme',m);
    }
  }
  function toggleDM(){applyDM(dm==='dark'?'light':'dark');}
  // Apply immediately to <html> so CSS kicks in before body renders
  if(document.documentElement)document.documentElement.setAttribute('data-theme',dm);
  // Apply again when body is ready
  document.addEventListener('DOMContentLoaded',function(){applyDM(dm);});
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
  function changeFontSize(d){baseFontSize=Math.max(80,Math.min(150,baseFontSize+d*10));document.body.style.zoom=(baseFontSize/100);}
  </script>`;
}

function lightModeCSS() {
  return `
    html[data-theme="light"] body,body.light-mode{background:#f5f5f0 !important;color:#1a1a2e !important;}
    body.light-mode::before{background:none !important;}
    body.light-mode .dc{color:#1a1a2e !important;}
    body.light-mode .header,body.light-mode .hdr{background:#ffffff !important;border-bottom-color:#d0d0c8 !important;}
    body.light-mode .header a.brand h1,body.light-mode .hdr h1{color:#1a1a2e !important;}
    body.light-mode input,body.light-mode select,body.light-mode textarea{background:#fff !important;color:#1a1a2e !important;border-color:#c0c8d0 !important;}
    body.light-mode .card,body.light-mode .form-card{background:#ffffff !important;border-color:#d0d0c8 !important;}
    body.light-mode .emp-card{background:#f0f4f8 !important;border-color:#d0d0c8 !important;}
    body.light-mode .trust-banner{background:rgba(40,167,69,0.08) !important;border-color:rgba(40,167,69,0.2) !important;}
    body.light-mode .section-title{color:#1a1a2e !important;border-bottom-color:#d0d0c8 !important;}
    body.light-mode .page-title{color:#1a1a2e !important;}
    body.light-mode h1,body.light-mode h2,body.light-mode h3{color:#1a1a2e !important;}
    body.light-mode p,body.light-mode span,body.light-mode label,body.light-mode div{color:inherit;}
    body.light-mode [style*="color:#fff"]{color:#1a1a2e !important;}
    body.light-mode [style*="color:#e0eaff"]{color:#2a2a3e !important;}
    body.light-mode [style*="color:#a0b4cc"]{color:#4a5568 !important;}
    body.light-mode [style*="color:#4a6a8a"]{color:#6b7280 !important;}
    body.light-mode [style*="background:#132a45"]{background:#ffffff !important;border-color:#d0d0c8 !important;}
    body.light-mode [style*="background:#0f2035"]{background:#f0f4f8 !important;}
    body.light-mode [style*="background:#0a1628"]{background:#f5f5f0 !important;}
    body.light-mode [style*="background:rgba(77,166,255,0.08)"]{background:rgba(77,166,255,0.06) !important;}
    body.light-mode [style*="background:rgba(77,166,255,0.05)"]{background:rgba(77,166,255,0.04) !important;}
    body.light-mode [style*="background:rgba(255,193,7,0.05)"]{background:rgba(255,193,7,0.06) !important;}
    body.light-mode [style*="background:rgba(255,193,7,0.03)"]{background:rgba(255,193,7,0.04) !important;}
    body.light-mode [style*="background:rgba(176,138,239,0.08)"]{background:rgba(176,138,239,0.06) !important;}
    body.light-mode [style*="background:rgba(176,138,239,0.05)"]{background:rgba(176,138,239,0.04) !important;}
    body.light-mode [style*="background:rgba(74,222,128,0.06)"]{background:rgba(74,222,128,0.08) !important;}
    body.light-mode [style*="background:rgba(77,166,255,0.06)"]{background:rgba(77,166,255,0.04) !important;}
    body.light-mode .rating-label{color:#4a5568 !important;}
    body.light-mode .star{color:#c0c8d0 !important;}
    body.light-mode .star.active{color:#ffc107 !important;}
    body.light-mode .header-nav a,body.light-mode .header-nav button{background:rgba(77,166,255,0.06) !important;border-color:rgba(77,166,255,0.2) !important;}
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
  var _eyeOpen='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  var _eyeClosed='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  function toggleEye(inputId,btnEl){var i=document.getElementById(inputId);if(!i)return;if(i.type==='password'){i.type='text';btnEl.innerHTML=_eyeOpen;}else{i.type='password';btnEl.innerHTML=_eyeClosed;}}
  function togglePwEye(uid,btnEl,pw){var s=document.getElementById('pw_'+uid);if(!s)return;if(s.dataset.shown!=='1'){s.textContent=pw;s.style.color='#4da6ff';s.style.letterSpacing='0';s.dataset.shown='1';btnEl.innerHTML=_eyeOpen;}else{s.textContent='\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022';s.style.color='#4a6a8a';s.style.letterSpacing='2px';s.dataset.shown='0';btnEl.innerHTML=_eyeClosed;}}
  function wfdAlert(msg,type,cb){var ic=type==='success'?'✅':type==='error'?'❌':'ℹ️';var cl=type==='success'?'#28a745':type==='error'?'#dc3545':'#4da6ff';
  var ov=document.createElement('div');ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99998;';
  var t=document.createElement('div');t.style.cssText='position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#132a45;border:1px solid '+cl+';border-radius:12px;padding:14px 24px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.4);max-width:500px;width:90%;animation:wfdSlideDown .3s;';
  t.innerHTML='<span style="font-size:24px;flex-shrink:0;">'+ic+'</span><p style="font-size:14px;color:#fff;line-height:1.4;flex:1;">'+msg+'</p><button style="padding:6px 16px;background:'+cl+';color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;">OK</button>';
  t.querySelector('button').onclick=function(){ov.remove();t.style.animation='wfdSlideUp .2s forwards';setTimeout(function(){t.remove();if(cb)cb();},200);};document.body.appendChild(ov);document.body.appendChild(t);}
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
      <a href="/suggestions" data-en="💡 Suggestions" data-ar="💡 اقتراحات">💡 Suggestions</a>
      <a href="/company-summary" data-en="🏢 Summary" data-ar="🏢 ملخص">🏢 Summary</a>
      <a href="/profile" data-en="👤 Profile" data-ar="👤 الملف">👤 Profile</a>
      ${langToggleBtn()} ${darkToggleBtn()}
      <a href="/logout" style="border-color:rgba(220,53,69,0.3);color:#ff6b7a;" data-en="Logout" data-ar="خروج">Logout</a>
    </div>
  </header>
  ${accessibilityHTML()}
  ${accessibilityJS()}
  <script>
  (function(){
    if(!sessionStorage.getItem('wfd_fb_session')){
      window.location.href='/logout';
      return;
    }
  })();
  </script>`;
}

function footerHTML() {
  return `<div style="text-align:center;padding:30px;color:#4a6a8a;font-size:12px;">&copy; ${new Date().getFullYear()} Watan First Digital. <span data-en="All rights reserved." data-ar="جميع الحقوق محفوظة.">All rights reserved.</span></div>`;
}

function starsHTML(name, labelEn, labelAr) {
  return `<div class="rating-row">
    <span class="rating-label" data-en="${labelEn}" data-ar="${labelAr}">${labelEn}</span>
    <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
      <div class="stars" id="stars_${name}">
        ${[1,2,3,4,5].map(i => `<span class="star" data-val="${i}" onclick="setRating('${name}',${i})">★</span>`).join('')}
      </div>
      <span class="star-label" id="label_${name}" style="font-size:11px;color:#4a6a8a;min-height:16px;"></span>
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
        ${eyeBtn('pass')}</div>
      </div>
      <button class="btn btn-full" onclick="doLogin()" data-en="Login" data-ar="دخول">Login</button>
      <div style="text-align:center;margin-top:16px;">
        <a href="#" onclick="showForgotPassword();return false;" style="font-size:13px;color:#4da6ff;text-decoration:none;" data-en="Forgot Password?" data-ar="نسيت كلمة المرور؟">Forgot Password?</a>
      </div>
      <div id="forgotSection" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid rgba(77,166,255,0.2);">
        <p style="font-size:12px;color:#a0b4cc;margin-bottom:10px;text-align:center;" data-en="Enter your email to receive a temporary password" data-ar="أدخل بريدك لاستلام كلمة مرور مؤقتة">Enter your email to receive a temporary password</p>
        <div class="form-group"><input type="email" id="forgotEmail" placeholder="your@email.com"></div>
        <button class="btn btn-full" style="background:linear-gradient(135deg,#ffc107,#e6a800);font-size:13px;padding:10px;" onclick="sendResetEmail()" data-en="Send Reset Email" data-ar="إرسال بريد إعادة التعيين">Send Reset Email</button>
      </div>
      <p style="text-align:center;margin-top:12px;font-size:12px;color:#4a6a8a;" data-en="Contact HR to get your login credentials" data-ar="تواصل مع الموارد البشرية للحصول على بيانات الدخول">Contact HR to get your login credentials</p>
    </div>
  </div></div>
  ${accessibilityHTML()}${accessibilityJS()}
  <script>
  document.getElementById('pass').addEventListener('keypress',function(e){if(e.key==='Enter')doLogin();});
  async function doLogin(){var e=document.getElementById('email').value.trim(),p=document.getElementById('pass').value,err=document.getElementById('err');
    err.classList.remove('show');
    try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})});var d=await r.json();
      if(d.success){sessionStorage.setItem('wfd_fb_session','1');window.location.href='/dashboard';}else{err.textContent=d.message;err.classList.add('show');}}
    catch(x){err.textContent='Network error.';err.classList.add('show');}}
  function showForgotPassword(){var s=document.getElementById('forgotSection');s.style.display=s.style.display==='none'?'block':'none';var e=document.getElementById('email').value.trim();if(e)document.getElementById('forgotEmail').value=e;}
  async function sendResetEmail(){var e=document.getElementById('forgotEmail').value.trim();if(!e){wfdAlert('Please enter your email.','error');return;}
    try{var r=await fetch('/api/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e})});var d=await r.json();
      if(d.success){wfdAlert('A temporary password has been sent to your email. Please check your inbox.','success');}else{wfdAlert(d.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}}
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

// ── FORGOT PASSWORD ──────────────────────────────────────────
app.post('/api/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({success:false,message:'Email required.'});
    const user = getUserByEmail.get(email.trim().toLowerCase());
    if (!user) return res.status(400).json({success:false,message:'No account found with this email.'});
    if (user.is_admin) return res.status(400).json({success:false,message:'Admin accounts cannot reset password here.'});
    // Generate temporary password
    const tempPw = 'Temp' + Math.random().toString(36).slice(2,8) + '!';
    const hash = bcrypt.hashSync(tempPw, 10);
    db.prepare('UPDATE fb_users SET password_hash=?, plain_password=? WHERE id=?').run(hash, tempPw, user.id);
    cloudUpdate('fb_users', user.id, {password_hash: hash, plain_password: tempPw});
    // Send email
    const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#fff;padding:30px;border-radius:12px;">
      <h2 style="color:#4da6ff;">Password Reset</h2>
      <p style="color:#a0b4cc;">Hello <strong>${user.full_name}</strong>,</p>
      <p style="color:#a0b4cc;">Your password has been reset. Here is your temporary password:</p>
      <div style="background:#0f2035;border:2px solid #4da6ff;border-radius:10px;padding:20px;text-align:center;margin:16px 0;">
        <p style="font-size:24px;font-weight:700;color:#4da6ff;letter-spacing:2px;">${tempPw}</p>
      </div>
      <p style="color:#ffc107;font-size:13px;font-weight:600;">⚠️ Please change your password immediately after logging in.</p>
      <p style="font-size:12px;color:#4a6a8a;">Watan First Digital Feedback System</p>
    </div>`;
    await sendBrevoEmail(user.email, 'Password Reset — Watan First Digital', emailHtml);
    console.log('[RESET] Password reset for', user.email);
    res.json({success:true});
  } catch(e) { console.error('[ERROR] Forgot password:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── EMPLOYEE/SUPERVISOR DASHBOARD ───────────────────────────
app.get('/dashboard', requireAuth, (req, res) => {
  const user = req.session.user;
  const dbUser = getUserById.get(user.id);
  const isSuper = dbUser.role === 'supervisor';

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

  // Get who this user can rate (same department, opposite role)
  let rateTargets = [];
  if (isSuper) {
    rateTargets = db.prepare('SELECT * FROM fb_users WHERE department=? AND role=\'employee\' AND is_admin=0').all(dbUser.department);
  } else {
    rateTargets = db.prepare('SELECT * FROM fb_users WHERE department=? AND role=\'supervisor\' AND is_admin=0').all(dbUser.department);
  }

  // Check which person-targets already rated this month
  const personRatingsThisMonth = db.prepare('SELECT target_id,id,created_at FROM fb_reviews WHERE reviewer_id=? AND target_type!=\'company\' AND target_id IS NOT NULL AND created_at>=?').all(user.id, monthStart);
  const ratedIds = personRatingsThisMonth.map(r => r.target_id);
  const unratedTargets = rateTargets.filter(t => !ratedIds.includes(t.id));

  // Check if company rating submitted this month (both employees AND supervisors)
  const companyRatingThisMonth = db.prepare('SELECT id,created_at FROM fb_reviews WHERE reviewer_id=? AND target_type=\'company\' AND created_at>=?').get(user.id, monthStart);

  // Build rated-persons list with delete eligibility
  const ratedWithInfo = personRatingsThisMonth.filter(r => r.target_id).map(r => {
    const target = getUserById.get(r.target_id);
    const ca = r.created_at || '';
    const submittedAt = new Date(ca.includes('Z') || ca.includes('+') ? ca : ca + 'Z');
    const hoursSince = isNaN(submittedAt.getTime()) ? 999 : (now.getTime() - submittedAt.getTime()) / (1000 * 60 * 60);
    return { reviewId: r.id, targetId: r.target_id, name: target ? target.full_name : 'Unknown', canDelete: hoursSince <= 24 };
  });

  // Company rating delete eligibility
  let companyCanDelete = false;
  if (companyRatingThisMonth) {
    const ca = companyRatingThisMonth.created_at || '';
    const submittedAt = new Date(ca.includes('Z') || ca.includes('+') ? ca : ca + 'Z');
    const hoursSince = isNaN(submittedAt.getTime()) ? 999 : (now.getTime() - submittedAt.getTime()) / (1000 * 60 * 60);
    companyCanDelete = hoursSince <= 24;
  }

  // All ratings this month (for top status)
  const allRatedThisMonth = db.prepare('SELECT id FROM fb_reviews WHERE reviewer_id=? AND created_at>=?').all(user.id, monthStart);

  // Get ratings about this user
  let myRatings = [];
  if (isSuper) {
    myRatings = db.prepare('SELECT * FROM fb_reviews WHERE target_type=\'supervisor\' AND target_id=? ORDER BY created_at DESC').all(user.id);
  } else {
    myRatings = db.prepare('SELECT * FROM fb_reviews WHERE target_type=\'employee\' AND target_id=? ORDER BY created_at DESC').all(user.id);
  }

  // Get user's own past submissions
  const mySubmissions = db.prepare('SELECT * FROM fb_reviews WHERE reviewer_id=? ORDER BY created_at DESC').all(user.id);

  // Employee of the Month
  const eotm = getEmployeeOfTheMonth();

  res.send(`${pageHead('Dashboard')}
  <body>
  ${headerHTML(user)}
  <div class="container">
    <h1 class="page-title" data-en="📊 Dashboard" data-ar="📊 لوحة التحكم">📊 Dashboard</h1>

    ${allRatedThisMonth.length === 0 ? `
    <div style="background:linear-gradient(135deg,rgba(255,193,7,0.12),rgba(255,107,122,0.06));border:1px solid rgba(255,193,7,0.4);border-radius:14px;padding:18px 22px;margin-bottom:20px;display:flex;align-items:center;gap:14px;animation:wfdPulseGlow 2s infinite;">
      <span style="font-size:32px;">📝</span>
      <div style="flex:1;">
        <p style="font-size:15px;font-weight:700;color:#ffc107;" data-en="You haven't rated this month yet!" data-ar="لم تقم بالتقييم هذا الشهر بعد!">You haven't rated this month yet!</p>
        <p style="font-size:12px;color:#a0b4cc;margin-top:4px;" data-en="Your anonymous feedback helps improve the company. Take a moment to share your thoughts below." data-ar="ملاحظاتك المجهولة تساعد في تحسين الشركة. خذ لحظة لمشاركة أفكارك أدناه.">Your anonymous feedback helps improve the company. Take a moment to share your thoughts below.</p>
      </div>
    </div>
    <style>@keyframes wfdPulseGlow{0%,100%{box-shadow:0 0 8px rgba(255,193,7,0.1);}50%{box-shadow:0 0 18px rgba(255,193,7,0.25);}}</style>
    ` : ''}

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
        <p style="font-size:18px;font-weight:700;color:${allRatedThisMonth.length>0?'#4ade80':'#ffc107'};">${allRatedThisMonth.length>0?'Submitted ✅':'Not yet'}</p>
      </div>
    </div>

    <!-- Employee of the Month -->
    ${eotm ? `<div style="background:linear-gradient(135deg,rgba(255,193,7,0.12),rgba(255,215,0,0.06));border:1px solid rgba(255,193,7,0.3);border-radius:16px;padding:20px;margin-bottom:24px;text-align:center;position:relative;overflow:hidden;">
      <div style="position:absolute;top:-10px;right:-10px;font-size:60px;opacity:0.1;">🏆</div>
      <p style="font-size:12px;color:#ffc107;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px;" data-en="⭐ Employee of the Month — ${escapeHtml(eotm.month)}" data-ar="⭐ موظف الشهر — ${escapeHtml(eotm.month)}">⭐ Employee of the Month — ${escapeHtml(eotm.month)}</p>
      <div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#ffc107,#e6a800);display:flex;align-items:center;justify-content:center;margin:0 auto 10px;font-size:28px;color:#fff;font-weight:700;box-shadow:0 4px 15px rgba(255,193,7,0.4);">${escapeHtml(eotm.name.charAt(0).toUpperCase())}</div>
      <h3 style="font-size:20px;font-weight:800;color:#ffc107;">${escapeHtml(eotm.name)}</h3>
      <p style="font-size:13px;color:#a0b4cc;margin-top:4px;">${escapeHtml(eotm.department)} · <span style="color:#ffc107;font-weight:700;">${eotm.avg}/5 ★</span> · ${eotm.ratings} rating(s)</p>
      ${eotm.id === user.id ? '<p style="font-size:14px;color:#4ade80;font-weight:700;margin-top:8px;" data-en="🎉 Congratulations! That\'s YOU!" data-ar="🎉 مبروك! هذا أنت!">🎉 Congratulations! That\'s YOU!</p>' : ''}
    </div>` : ''}

    <!-- Dashboard Tabs -->
    <div style="display:flex;gap:0;margin-bottom:24px;border-bottom:2px solid rgba(77,166,255,0.2);">
      <button class="dash-tab active" onclick="switchDashTab('tab-give')" id="tabBtn-give" style="flex:1;padding:14px 20px;background:rgba(77,166,255,0.12);color:#4da6ff;border:none;border-bottom:3px solid #4da6ff;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;border-radius:8px 8px 0 0;transition:all .2s;" data-en="${isSuper?'Rate My Team':'Give Feedback'}" data-ar="${isSuper?'قيّم فريقي':'إرسال تقييم'}">${isSuper?'Rate My Team':'Give Feedback'}</button>
      <button class="dash-tab" onclick="switchDashTab('tab-view')" id="tabBtn-view" style="flex:1;padding:14px 20px;background:transparent;color:#a0b4cc;border:none;border-bottom:3px solid transparent;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;border-radius:8px 8px 0 0;transition:all .2s;" data-en="${isSuper?'My Feedback':'My Ratings'}" data-ar="${isSuper?'تقييماتي':'تقييماتي'}">${isSuper?'My Feedback':'My Ratings'}</button>
    </div>

    <!-- TAB 1: Give Feedback / Rate Team -->
    <div id="tab-give">

    ${!isSuper ? `
    <!-- ═══════ CARD 1: COMPANY RATING (Employees Only) ═══════ -->
    <div class="card" style="border-left:4px solid #4da6ff;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:24px;">🏢</span>
        <span data-en="Company Rating" data-ar="تقييم الشركة">Company Rating</span>
      </h2>
      <p style="font-size:13px;color:#a0b4cc;margin-bottom:16px;" data-en="Rate your overall experience at the company. This is NOT about a specific person." data-ar="قيّم تجربتك العامة في الشركة. هذا ليس عن شخص محدد.">Rate your overall experience at the company. This is NOT about a specific person.</p>

      ${companyRatingThisMonth ? `
        <div style="text-align:center;padding:20px;background:rgba(74,222,128,0.06);border-radius:12px;">
          <p style="color:#4ade80;font-size:16px;font-weight:600;" data-en="✅ Company rating submitted this month" data-ar="✅ تم إرسال تقييم الشركة هذا الشهر">✅ Company rating submitted this month</p>
          <p style="color:#a0b4cc;font-size:13px;margin-top:6px;" data-en="You can submit again next month." data-ar="يمكنك الإرسال مرة أخرى الشهر القادم.">You can submit again next month.</p>
          ${companyCanDelete ? `<p style="color:#ffc107;font-size:11px;margin-top:8px;" data-en="⏰ You can delete & re-submit within 24 hours only." data-ar="⏰ يمكنك الحذف وإعادة الإرسال خلال 24 ساعة فقط.">⏰ You can delete & re-submit within 24 hours only.</p><button onclick="deleteRating('${companyRatingThisMonth.id}','Company Rating')" style="margin-top:10px;padding:6px 16px;background:rgba(220,53,69,0.1);border:1px solid rgba(220,53,69,0.3);border-radius:8px;color:#ff6b7a;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;" data-en="🗑️ Delete & Re-submit" data-ar="🗑️ حذف وإعادة إرسال">🗑️ Delete & Re-submit</button>` : `<p style="color:#4a6a8a;font-size:11px;margin-top:8px;" data-en="🔒 24-hour edit window has passed. This rating is now final." data-ar="🔒 انتهت فترة التعديل (24 ساعة). هذا التقييم نهائي الآن.">🔒 24-hour edit window has passed. This rating is now final.</p>`}
        </div>
      ` : `
        <div class="trust-banner">
          <p data-en="🔒 Your feedback is 100% anonymous. Be honest — your name will never be shown." data-ar="🔒 تقييمك مجهول تماماً. كن صادقاً — لن يظهر اسمك أبداً.">🔒 Your feedback is 100% anonymous. Be honest — your name will never be shown.</p>
        </div>

        <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-bottom:16px;padding:10px;background:rgba(77,166,255,0.05);border-radius:8px;">
          <span style="font-size:11px;color:#dc3545;">★ <span data-en="Bad" data-ar="سيء">Bad</span></span>
          <span style="font-size:11px;color:#ff6b7a;">★★ <span data-en="Poor" data-ar="ضعيف">Poor</span></span>
          <span style="font-size:11px;color:#ffc107;">★★★ <span data-en="Good" data-ar="جيد">Good</span></span>
          <span style="font-size:11px;color:#4da6ff;">★★★★ <span data-en="Very Good" data-ar="جيد جداً">Very Good</span></span>
          <span style="font-size:11px;color:#4ade80;">★★★★★ <span data-en="Excellent" data-ar="ممتاز">Excellent</span></span>
        </div>

        ${starsHTML('job_satisfaction','How happy are you with your daily tasks?','ما مدى رضاك عن مهامك اليومية؟')}
        ${starsHTML('salary_benefits','How fair is your compensation?','ما مدى عدالة تعويضاتك؟')}
        ${starsHTML('growth_training','Do you have opportunities to develop your skills?','هل لديك فرص لتطوير مهاراتك؟')}
        ${starsHTML('team_teamwork','Does your team cooperate and work well together?','هل يتعاون فريقك ويعمل بشكل جيد معاً؟')}
        ${starsHTML('team_respect','Do your colleagues treat each other with respect?','هل يتعامل زملاؤك مع بعضهم باحترام؟')}

        <div class="form-group" style="margin-top:20px;">
          <label data-en="💬 Why did you give this rating? What would you improve? (optional, anonymous)" data-ar="💬 لماذا أعطيت هذا التقييم؟ ما الذي تحسّنه؟ (اختياري، مجهول)">💬 Why did you give this rating? What would you improve? (optional, anonymous)</label>
          <textarea id="company_comment" placeholder="e.g. I wish we had more training opportunities..." style="min-height:70px;"></textarea>
          <p style="font-size:11px;color:#4a6a8a;margin-top:4px;" data-en="🔒 Your comment is 100% anonymous — HR sees the text, never your name." data-ar="🔒 تعليقك مجهول 100% — الموارد البشرية ترى النص فقط، أبداً اسمك.">🔒 Your comment is 100% anonymous — HR sees the text, never your name.</p>
        </div>
        <button class="btn btn-full" onclick="submitCompanyFeedback()" data-en="Submit Company Rating" data-ar="إرسال تقييم الشركة">Submit Company Rating</button>
      `}
    </div>

    <!-- ═══════ CARD 2: PERSON RATING (Employee → Supervisor) ═══════ -->
    <div class="card" style="margin-top:20px;border-left:4px solid #b08aef;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:24px;">👤</span>
        <span data-en="Supervisor Rating" data-ar="تقييم المشرف">Supervisor Rating</span>
      </h2>
      <p style="font-size:13px;color:#a0b4cc;margin-bottom:16px;" data-en="Rate a specific supervisor. You can rate each supervisor once per month." data-ar="قيّم مشرفاً محدداً. يمكنك تقييم كل مشرف مرة واحدة شهرياً.">Rate a specific supervisor. You can rate each supervisor once per month.</p>

      ${unratedTargets.length === 0 && personRatingsThisMonth.length > 0 ? `
        <div style="text-align:center;padding:20px;background:rgba(74,222,128,0.06);border-radius:12px;">
          <p style="color:#4ade80;font-size:16px;font-weight:600;" data-en="✅ You have rated all supervisors this month" data-ar="✅ لقد قيّمت جميع المشرفين هذا الشهر">✅ You have rated all supervisors this month</p>
          <p style="color:#a0b4cc;font-size:13px;margin-top:8px;" data-en="Delete a rating below to re-rate (within 24 hours only)." data-ar="احذف تقييم أدناه لإعادة التقييم (خلال 24 ساعة فقط).">Delete a rating below to re-rate (within 24 hours only).</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:12px;">
            ${ratedWithInfo.map(r => `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);border-radius:20px;padding:4px 12px;"><span style="font-size:12px;color:#4ade80;">✅ ${escapeHtml(r.name)}</span>${r.canDelete ? `<button onclick="deleteRating('${r.reviewId}','${escapeHtml(r.name)}')" style="background:none;border:none;color:#ff6b7a;cursor:pointer;font-size:12px;padding:0 2px;" title="Delete rating">🗑️</button>` : ''}</div>`).join('')}
          </div>
        </div>
      ` : rateTargets.length === 0 ? `
        <p style="color:#a0b4cc;text-align:center;padding:20px;" data-en="No supervisors in your department." data-ar="لا يوجد مشرفين في قسمك.">No supervisors in your department.</p>
      ` : `
        <div class="form-group" style="margin-bottom:20px;">
          <label style="font-size:15px;font-weight:700;color:#b08aef;" data-en="Select Supervisor to Rate" data-ar="اختر المشرف لتقييمه">Select Supervisor to Rate</label>
          <select id="rateTarget" onchange="showRatingForm()" style="width:100%;padding:12px;font-size:14px;color:#fff;background:#0f2035;border:1.5px solid rgba(176,138,239,0.3);border-radius:8px;font-family:inherit;margin-top:8px;">
            <option value="" data-en="— Choose —" data-ar="— اختر —">— Choose —</option>
            ${unratedTargets.map(t => `<option value="${t.id}">${escapeHtml(t.full_name)} (${escapeHtml(t.department)})</option>`).join('')}
          </select>
          ${ratedWithInfo.length > 0 ? `<div style="margin-top:10px;"><p style="font-size:12px;color:#4ade80;margin-bottom:6px;" data-en="Already rated this month:" data-ar="تم تقييمهم هذا الشهر:">Already rated this month:</p><div style="display:flex;flex-wrap:wrap;gap:6px;">${ratedWithInfo.map(r => `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);border-radius:20px;padding:4px 12px;"><span style="font-size:12px;color:#4ade80;">✅ ${escapeHtml(r.name)}</span>${r.canDelete ? `<button onclick="deleteRating('${r.reviewId}','${escapeHtml(r.name)}')" style="background:none;border:none;color:#ff6b7a;cursor:pointer;font-size:12px;padding:0 2px;" title="Delete rating">🗑️</button>` : ''}</div>`).join('')}</div></div>` : ''}
        </div>

        <div id="ratingFormArea" style="display:none;">
          ${starsHTML('sup_communication','Does this supervisor communicate clearly?','هل يتواصل هذا المشرف بوضوح؟')}
          ${starsHTML('sup_support','Does this supervisor help when you face problems?','هل يساعدك هذا المشرف عند مواجهة المشاكل؟')}
          ${starsHTML('sup_fairness','Does this supervisor treat everyone equally?','هل يعامل هذا المشرف الجميع بعدالة؟')}
          <div class="form-group" style="margin-top:16px;">
            <label data-en="💬 Why did you give this rating? Any specific examples? (optional, anonymous)" data-ar="💬 لماذا أعطيت هذا التقييم؟ أي أمثلة محددة؟ (اختياري، مجهول)">💬 Why did you give this rating? Any specific examples? (optional, anonymous)</label>
            <textarea id="person_comment" placeholder="e.g. My supervisor is great at listening but could give clearer instructions..." style="min-height:70px;"></textarea>
            <p style="font-size:11px;color:#4a6a8a;margin-top:4px;" data-en="🔒 Your comment is 100% anonymous — HR sees the text, never your name." data-ar="🔒 تعليقك مجهول 100% — الموارد البشرية ترى النص فقط، أبداً اسمك.">🔒 Your comment is 100% anonymous — HR sees the text, never your name.</p>
          </div>
          <button class="btn btn-full" style="background:linear-gradient(135deg,#b08aef,#8b5cf6);" onclick="submitPersonFeedback()" data-en="Submit Supervisor Rating" data-ar="إرسال تقييم المشرف">Submit Supervisor Rating</button>
        </div>
      `}
    </div>
    ` : `
    <!-- ═══════ CARD 1: COMPANY RATING (Supervisors Too) ═══════ -->
    <div class="card" style="border-left:4px solid #4da6ff;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:24px;">🏢</span>
        <span data-en="Company Rating" data-ar="تقييم الشركة">Company Rating</span>
      </h2>
      <p style="font-size:13px;color:#a0b4cc;margin-bottom:16px;" data-en="Rate your overall experience at the company. This is NOT about a specific person." data-ar="قيّم تجربتك العامة في الشركة. هذا ليس عن شخص محدد.">Rate your overall experience at the company. This is NOT about a specific person.</p>

      ${companyRatingThisMonth ? `
        <div style="text-align:center;padding:20px;background:rgba(74,222,128,0.06);border-radius:12px;">
          <p style="color:#4ade80;font-size:16px;font-weight:600;" data-en="✅ Company rating submitted this month" data-ar="✅ تم إرسال تقييم الشركة هذا الشهر">✅ Company rating submitted this month</p>
          <p style="color:#a0b4cc;font-size:13px;margin-top:6px;" data-en="You can submit again next month." data-ar="يمكنك الإرسال مرة أخرى الشهر القادم.">You can submit again next month.</p>
          ${companyCanDelete ? `<p style="color:#ffc107;font-size:11px;margin-top:8px;" data-en="⏰ You can delete & re-submit within 24 hours only." data-ar="⏰ يمكنك الحذف وإعادة الإرسال خلال 24 ساعة فقط.">⏰ You can delete & re-submit within 24 hours only.</p><button onclick="deleteRating('${companyRatingThisMonth.id}','Company Rating')" style="margin-top:10px;padding:6px 16px;background:rgba(220,53,69,0.1);border:1px solid rgba(220,53,69,0.3);border-radius:8px;color:#ff6b7a;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;" data-en="🗑️ Delete & Re-submit" data-ar="🗑️ حذف وإعادة إرسال">🗑️ Delete & Re-submit</button>` : `<p style="color:#4a6a8a;font-size:11px;margin-top:8px;" data-en="🔒 24-hour edit window has passed. This rating is now final." data-ar="🔒 انتهت فترة التعديل (24 ساعة). هذا التقييم نهائي الآن.">🔒 24-hour edit window has passed. This rating is now final.</p>`}
        </div>
      ` : `
        <div class="trust-banner">
          <p data-en="🔒 Your feedback is 100% anonymous. Be honest — your name will never be shown." data-ar="🔒 تقييمك مجهول تماماً. كن صادقاً — لن يظهر اسمك أبداً.">🔒 Your feedback is 100% anonymous. Be honest — your name will never be shown.</p>
        </div>

        <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-bottom:16px;padding:10px;background:rgba(77,166,255,0.05);border-radius:8px;">
          <span style="font-size:11px;color:#dc3545;">★ <span data-en="Bad" data-ar="سيء">Bad</span></span>
          <span style="font-size:11px;color:#ff6b7a;">★★ <span data-en="Poor" data-ar="ضعيف">Poor</span></span>
          <span style="font-size:11px;color:#ffc107;">★★★ <span data-en="Good" data-ar="جيد">Good</span></span>
          <span style="font-size:11px;color:#4da6ff;">★★★★ <span data-en="Very Good" data-ar="جيد جداً">Very Good</span></span>
          <span style="font-size:11px;color:#4ade80;">★★★★★ <span data-en="Excellent" data-ar="ممتاز">Excellent</span></span>
        </div>

        ${starsHTML('job_satisfaction','How happy are you with your daily tasks?','ما مدى رضاك عن مهامك اليومية؟')}
        ${starsHTML('salary_benefits','How fair is your compensation?','ما مدى عدالة تعويضاتك؟')}
        ${starsHTML('growth_training','Do you have opportunities to develop your skills?','هل لديك فرص لتطوير مهاراتك؟')}
        ${starsHTML('team_teamwork','Does your team cooperate and work well together?','هل يتعاون فريقك ويعمل بشكل جيد معاً؟')}
        ${starsHTML('team_respect','Do your colleagues treat each other with respect?','هل يتعامل زملاؤك مع بعضهم باحترام؟')}

        <div class="form-group" style="margin-top:20px;">
          <label data-en="💬 Why did you give this rating? What would you improve? (optional, anonymous)" data-ar="💬 لماذا أعطيت هذا التقييم؟ ما الذي تحسّنه؟ (اختياري، مجهول)">💬 Why did you give this rating? What would you improve? (optional, anonymous)</label>
          <textarea id="company_comment" placeholder="e.g. I wish we had more training opportunities..." style="min-height:70px;"></textarea>
          <p style="font-size:11px;color:#4a6a8a;margin-top:4px;" data-en="🔒 Your comment is 100% anonymous — HR sees the text, never your name." data-ar="🔒 تعليقك مجهول 100% — الموارد البشرية ترى النص فقط، أبداً اسمك.">🔒 Your comment is 100% anonymous — HR sees the text, never your name.</p>
        </div>
        <button class="btn btn-full" onclick="submitCompanyFeedback()" data-en="Submit Company Rating" data-ar="إرسال تقييم الشركة">Submit Company Rating</button>
      `}
    </div>

    <!-- ═══════ CARD 2: Rate Employees (Supervisor) ═══════ -->
    <div class="card" style="margin-top:20px;border-left:4px solid #b08aef;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:24px;">👥</span>
        <span data-en="Rate Your Team Members" data-ar="قيّم أعضاء فريقك">Rate Your Team Members</span>
      </h2>

      ${unratedTargets.length === 0 && personRatingsThisMonth.length > 0 ? `
        <div style="text-align:center;padding:20px;background:rgba(74,222,128,0.06);border-radius:12px;">
          <p style="color:#4ade80;font-size:16px;font-weight:600;" data-en="✅ You have rated all employees this month" data-ar="✅ لقد قيّمت جميع الموظفين هذا الشهر">✅ You have rated all employees this month</p>
          <p style="color:#a0b4cc;font-size:13px;margin-top:8px;" data-en="Delete a rating below to re-rate (within 24 hours only)." data-ar="احذف تقييم أدناه لإعادة التقييم (خلال 24 ساعة فقط).">Delete a rating below to re-rate (within 24 hours only).</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:12px;">
            ${ratedWithInfo.map(r => `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);border-radius:20px;padding:4px 12px;"><span style="font-size:12px;color:#4ade80;">✅ ${escapeHtml(r.name)}</span>${r.canDelete ? `<button onclick="deleteRating('${r.reviewId}','${escapeHtml(r.name)}')" style="background:none;border:none;color:#ff6b7a;cursor:pointer;font-size:12px;padding:0 2px;" title="Delete rating">🗑️</button>` : ''}</div>`).join('')}
          </div>
        </div>
      ` : rateTargets.length === 0 ? `
        <p style="color:#a0b4cc;text-align:center;padding:20px;" data-en="No employees in your department." data-ar="لا يوجد موظفين في قسمك.">No employees in your department.</p>
      ` : `
        <div class="form-group" style="margin-bottom:20px;">
          <label style="font-size:15px;font-weight:700;color:#b08aef;" data-en="Select Employee to Rate" data-ar="اختر الموظف لتقييمه">Select Employee to Rate</label>
          <select id="rateTarget" onchange="showRatingForm()" style="width:100%;padding:12px;font-size:14px;color:#fff;background:#0f2035;border:1.5px solid rgba(176,138,239,0.3);border-radius:8px;font-family:inherit;margin-top:8px;">
            <option value="" data-en="— Choose —" data-ar="— اختر —">— Choose —</option>
            ${unratedTargets.map(t => `<option value="${t.id}">${escapeHtml(t.full_name)} (${escapeHtml(t.department)})</option>`).join('')}
          </select>
          ${ratedWithInfo.length > 0 ? `<div style="margin-top:10px;"><p style="font-size:12px;color:#4ade80;margin-bottom:6px;" data-en="Already rated this month:" data-ar="تم تقييمهم هذا الشهر:">Already rated this month:</p><div style="display:flex;flex-wrap:wrap;gap:6px;">${ratedWithInfo.map(r => `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);border-radius:20px;padding:4px 12px;"><span style="font-size:12px;color:#4ade80;">✅ ${escapeHtml(r.name)}</span>${r.canDelete ? `<button onclick="deleteRating('${r.reviewId}','${escapeHtml(r.name)}')" style="background:none;border:none;color:#ff6b7a;cursor:pointer;font-size:12px;padding:0 2px;" title="Delete rating">🗑️</button>` : ''}</div>`).join('')}</div></div>` : ''}
        </div>

        <div id="ratingFormArea" style="display:none;">
          ${starsHTML('emp_performance','Performance — How well does this employee do their job?','الأداء — ما مدى جودة أداء هذا الموظف؟')}
          ${starsHTML('emp_punctuality','Punctuality — Does this employee arrive on time and meet deadlines?','الالتزام — هل يصل هذا الموظف في الوقت ويلتزم بالمواعيد؟')}
          ${starsHTML('emp_attitude','Attitude — Is this employee positive and professional?','السلوك — هل هذا الموظف إيجابي ومهني؟')}
          ${starsHTML('emp_initiative','Initiative — Does this employee take action without being asked?','المبادرة — هل يتخذ هذا الموظف إجراءات دون أن يُطلب منه؟')}
          <div class="form-group" style="margin-top:12px;">
            <label data-en="💬 Written feedback (visible to employee)" data-ar="💬 تقييم مكتوب (مرئي للموظف)">💬 Written feedback (visible to employee)</label>
            <textarea id="sup_comment" placeholder="Your feedback..."></textarea>
          </div>
          <button class="btn btn-full" style="background:linear-gradient(135deg,#b08aef,#8b5cf6);" onclick="submitSupReview()" data-en="Submit Rating" data-ar="إرسال التقييم">Submit Rating</button>
        </div>
      `}
    </div>
    `}

    </div><!-- end tab-give -->

    <!-- TAB 2: My Ratings / My Feedback -->
    <div id="tab-view" style="display:none;">
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
          <p style="font-size:12px;color:#a0b4cc;margin-bottom:8px;">${fmtDate(r.created_at)}</p>
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
    <!-- Rating History Chart -->
    ${myRatings.length >= 1 ? `<div class="card" style="margin-top:20px;">
      <h2 class="section-title" data-en="📊 Rating History" data-ar="📊 سجل التقييمات">📊 Rating History</h2>
      ${isSuper ? (() => {
        const fields = [{k:'sup_communication',en:'Communication'},{k:'sup_support',en:'Support'},{k:'sup_fairness',en:'Fairness'}];
        const avgCalc = (f) => { const v=myRatings.filter(r=>r[f]); return v.length?(v.reduce((s,r)=>s+r[f],0)/v.length):0; };
        return `<div style="display:flex;flex-direction:column;gap:10px;">
          ${fields.map(f => { const val=avgCalc(f.k).toFixed(1); const pct=Math.round(avgCalc(f.k)*20); return `<div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:12px;color:#a0b4cc;">${f.en}</span><span style="font-size:12px;font-weight:700;color:#ffc107;">${val}/5</span></div>
            <div style="height:8px;background:#0f2035;border-radius:4px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,${pct<40?'#dc3545':pct<70?'#ffc107':'#4ade80'},${pct<40?'#ff6b7a':pct<70?'#ffd43b':'#28a745'});border-radius:4px;transition:width .5s;"></div></div>
          </div>`; }).join('')}
        </div>`;
      })() : (() => {
        const fields = [{k:'emp_performance',en:'Performance'},{k:'emp_punctuality',en:'Punctuality'},{k:'emp_attitude',en:'Attitude'},{k:'emp_initiative',en:'Initiative'}];
        const avgCalc = (f) => { const v=myRatings.filter(r=>r[f]); return v.length?(v.reduce((s,r)=>s+r[f],0)/v.length):0; };
        return `<div style="display:flex;flex-direction:column;gap:10px;">
          ${fields.map(f => { const val=avgCalc(f.k).toFixed(1); const pct=Math.round(avgCalc(f.k)*20); return `<div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:12px;color:#a0b4cc;">${f.en}</span><span style="font-size:12px;font-weight:700;color:#ffc107;">${val}/5</span></div>
            <div style="height:8px;background:#0f2035;border-radius:4px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,${pct<40?'#dc3545':pct<70?'#ffc107':'#4ade80'},${pct<40?'#ff6b7a':pct<70?'#ffd43b':'#28a745'});border-radius:4px;transition:width .5s;"></div></div>
          </div>`; }).join('')}
        </div>`;
      })()}
      <p style="text-align:center;color:#4a6a8a;font-size:11px;margin-top:12px;">${myRatings.length} rating(s) total</p>
    </div>` : ''}

    <!-- My Past Submissions -->
    <div class="card" style="margin-top:20px;">
      <h2 class="section-title" data-en="📋 My Past Submissions" data-ar="📋 تقييماتي السابقة">📋 My Past Submissions</h2>
      <p style="font-size:12px;color:#a0b4cc;margin-bottom:16px;background:rgba(77,166,255,0.06);padding:10px;border-radius:8px;" data-en="🔒 Only you can see this — HR sees anonymous averages, not your individual ratings." data-ar="🔒 أنت فقط تستطيع رؤية هذا — الموارد البشرية ترى المعدلات المجهولة فقط.">🔒 Only you can see this — HR sees anonymous averages, not your individual ratings.</p>
      ${mySubmissions.length === 0 ? `<p style="text-align:center;color:#a0b4cc;padding:20px;" data-en="You haven't submitted any feedback yet." data-ar="لم ترسل أي تقييم بعد.">You haven't submitted any feedback yet.</p>` :
        mySubmissions.map(r => {
          const subDate = fmtDate(r.created_at);
          if (r.target_type === 'company') {
            return `<div class="emp-card" style="border-left:3px solid #4da6ff;"><p style="font-size:12px;color:#a0b4cc;margin-bottom:10px;">${subDate} · <span style="color:#4da6ff;font-weight:600;" data-en="🏢 Company Rating" data-ar="🏢 تقييم الشركة">🏢 Company Rating</span></p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                <div><span style="font-size:11px;color:#a0b4cc;">Job Satisfaction</span> <span style="color:#ffc107;">${'★'.repeat(r.job_satisfaction||0)}${'☆'.repeat(5-(r.job_satisfaction||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Salary & Benefits</span> <span style="color:#ffc107;">${'★'.repeat(r.salary_benefits||0)}${'☆'.repeat(5-(r.salary_benefits||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Growth & Training</span> <span style="color:#ffc107;">${'★'.repeat(r.growth_training||0)}${'☆'.repeat(5-(r.growth_training||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Teamwork</span> <span style="color:#ffc107;">${'★'.repeat(r.team_teamwork||0)}${'☆'.repeat(5-(r.team_teamwork||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Respect</span> <span style="color:#ffc107;">${'★'.repeat(r.team_respect||0)}${'☆'.repeat(5-(r.team_respect||0))}</span></div>
              </div>
              ${r.comment?`<p style="margin-top:8px;font-size:13px;color:#a0b4cc;">💬 ${escapeHtml(r.comment)}</p>`:''}
            </div>`;
          } else if (r.reviewer_role === 'employee') {
            const tgt = r.target_id ? getUserById.get(r.target_id) : null;
            return `<div class="emp-card" style="border-left:3px solid #b08aef;"><p style="font-size:12px;color:#a0b4cc;margin-bottom:10px;">${subDate} · <span style="color:#b08aef;font-weight:600;" data-en="👤 Supervisor Rating" data-ar="👤 تقييم المشرف">👤 Supervisor Rating</span>${tgt?' — '+escapeHtml(tgt.full_name):''}</p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                <div><span style="font-size:11px;color:#a0b4cc;">Communication</span> <span style="color:#ffc107;">${'★'.repeat(r.sup_communication||0)}${'☆'.repeat(5-(r.sup_communication||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Support</span> <span style="color:#ffc107;">${'★'.repeat(r.sup_support||0)}${'☆'.repeat(5-(r.sup_support||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Fairness</span> <span style="color:#ffc107;">${'★'.repeat(r.sup_fairness||0)}${'☆'.repeat(5-(r.sup_fairness||0))}</span></div>
              </div>
              ${r.comment?`<p style="margin-top:8px;font-size:13px;color:#a0b4cc;">💬 ${escapeHtml(r.comment)}</p>`:''}
            </div>`;
          } else {
            const tgt = r.target_id ? getUserById.get(r.target_id) : null;
            return `<div class="emp-card" style="border-left:3px solid #b08aef;"><p style="font-size:12px;color:#a0b4cc;margin-bottom:10px;">${subDate} · <span data-en="Rating for" data-ar="تقييم لـ">Rating for</span> ${tgt?escapeHtml(tgt.full_name):'Employee'}</p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                <div><span style="font-size:11px;color:#a0b4cc;">Performance</span> <span style="color:#ffc107;">${'★'.repeat(r.emp_performance||0)}${'☆'.repeat(5-(r.emp_performance||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Punctuality</span> <span style="color:#ffc107;">${'★'.repeat(r.emp_punctuality||0)}${'☆'.repeat(5-(r.emp_punctuality||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Attitude</span> <span style="color:#ffc107;">${'★'.repeat(r.emp_attitude||0)}${'☆'.repeat(5-(r.emp_attitude||0))}</span></div>
                <div><span style="font-size:11px;color:#a0b4cc;">Initiative</span> <span style="color:#ffc107;">${'★'.repeat(r.emp_initiative||0)}${'☆'.repeat(5-(r.emp_initiative||0))}</span></div>
              </div>
              ${r.sup_comment?`<p style="margin-top:8px;font-size:13px;color:#a0b4cc;">💬 ${escapeHtml(r.sup_comment)}</p>`:''}
            </div>`;
          }
        }).join('')}
    </div>
    </div><!-- end tab-view -->
  </div>
  ${footerHTML()}
  <script>
  function switchDashTab(tabId){
    document.getElementById('tab-give').style.display=tabId==='tab-give'?'block':'none';
    document.getElementById('tab-view').style.display=tabId==='tab-view'?'block':'none';
    document.getElementById('tabBtn-give').style.background=tabId==='tab-give'?'rgba(77,166,255,0.12)':'transparent';
    document.getElementById('tabBtn-give').style.color=tabId==='tab-give'?'#4da6ff':'#a0b4cc';
    document.getElementById('tabBtn-give').style.borderBottomColor=tabId==='tab-give'?'#4da6ff':'transparent';
    document.getElementById('tabBtn-view').style.background=tabId==='tab-view'?'rgba(77,166,255,0.12)':'transparent';
    document.getElementById('tabBtn-view').style.color=tabId==='tab-view'?'#4da6ff':'#a0b4cc';
    document.getElementById('tabBtn-view').style.borderBottomColor=tabId==='tab-view'?'#4da6ff':'transparent';
  }
  var ratingLabels={1:['Bad','سيء','#dc3545'],2:['Poor','ضعيف','#ff6b7a'],3:['Good','جيد','#ffc107'],4:['Very Good','جيد جداً','#4da6ff'],5:['Excellent','ممتاز','#4ade80']};
  function setRating(name,val){
    document.getElementById('r_'+name).value=val;
    var stars=document.getElementById('stars_'+name).querySelectorAll('.star');
    stars.forEach(function(s,i){s.classList.toggle('active',i<val);});
    var lb=document.getElementById('label_'+name);
    if(lb&&ratingLabels[val]){lb.textContent=wfdLang==='ar'?ratingLabels[val][1]:ratingLabels[val][0];lb.style.color=ratingLabels[val][2];}
  }
  function showRatingForm(){
    var sel=document.getElementById('rateTarget');
    var area=document.getElementById('ratingFormArea');
    if(sel&&sel.value){area.style.display='block';}else{area.style.display='none';}
  }
  async function submitCompanyFeedback(){
    var data={
      job_satisfaction:parseInt(document.getElementById('r_job_satisfaction').value),
      salary_benefits:parseInt(document.getElementById('r_salary_benefits').value),
      growth_training:parseInt(document.getElementById('r_growth_training').value),
      team_teamwork:parseInt(document.getElementById('r_team_teamwork').value),
      team_respect:parseInt(document.getElementById('r_team_respect').value),
      comment:(document.getElementById('company_comment')||{}).value||''
    };
    if(data.job_satisfaction===0||data.salary_benefits===0||data.growth_training===0||data.team_teamwork===0||data.team_respect===0){wfdAlert('Please rate all categories (1-5 stars).','error');return;}
    try{var r=await fetch('/api/company-feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});var d=await r.json();
      if(d.success){wfdAlert('Thank you for your company feedback!','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  async function submitPersonFeedback(){
    var targetId=document.getElementById('rateTarget').value;
    if(!targetId){wfdAlert('Please select a supervisor to rate.','error');return;}
    var data={
      target_id:targetId,
      sup_communication:parseInt(document.getElementById('r_sup_communication').value),
      sup_support:parseInt(document.getElementById('r_sup_support').value),
      sup_fairness:parseInt(document.getElementById('r_sup_fairness').value),
      comment:(document.getElementById('person_comment')||{}).value||''
    };
    if(data.sup_communication===0||data.sup_support===0||data.sup_fairness===0){wfdAlert('Please rate all categories (1-5 stars).','error');return;}
    try{var r=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});var d=await r.json();
      if(d.success){wfdAlert('Supervisor rating submitted!','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  async function submitSupReview(){
    var targetId=document.getElementById('rateTarget').value;
    if(!targetId){wfdAlert('Please select an employee to rate.','error');return;}
    var data={
      reviews:[{
        target_id:targetId,
        emp_performance:parseInt(document.getElementById('r_emp_performance').value),
        emp_punctuality:parseInt(document.getElementById('r_emp_punctuality').value),
        emp_attitude:parseInt(document.getElementById('r_emp_attitude').value),
        emp_initiative:parseInt(document.getElementById('r_emp_initiative').value),
        sup_comment:(document.getElementById('sup_comment')||{}).value||''
      }]
    };
    if(data.reviews[0].emp_performance===0||data.reviews[0].emp_punctuality===0||data.reviews[0].emp_attitude===0||data.reviews[0].emp_initiative===0){wfdAlert('Please rate all categories.','error');return;}
    try{var r=await fetch('/api/supervisor-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});var d=await r.json();
      if(d.success){wfdAlert('Rating submitted!','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  async function deleteRating(reviewId,name){
    // Custom confirm using wfdAlert overlay
    var ov=document.createElement('div');ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99998;';
    var t=document.createElement('div');t.style.cssText='position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#132a45;border:1px solid #ffc107;border-radius:12px;padding:14px 24px;display:flex;flex-direction:column;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.4);max-width:500px;width:90%;animation:wfdSlideDown .3s;';
    t.innerHTML='<span style="font-size:28px;">⚠️</span><p style="font-size:14px;color:#fff;text-align:center;">Delete your rating for <strong>"'+name+'"</strong>?</p><div style="display:flex;gap:10px;"><button id="cfmYes" style="padding:8px 20px;background:#dc3545;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Yes, Delete</button><button id="cfmNo" style="padding:8px 20px;background:#4a6a8a;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button></div>';
    document.body.appendChild(ov);document.body.appendChild(t);
    t.querySelector('#cfmNo').onclick=function(){ov.remove();t.remove();};
    t.querySelector('#cfmYes').onclick=async function(){
      ov.remove();t.remove();
      try{var r=await fetch('/api/feedback/delete-rating/'+reviewId,{method:'DELETE'});var d=await r.json();
        if(d.success){wfdAlert('Rating for '+name+' deleted. You can rate again.','success',function(){location.reload();});}
        else{wfdAlert(d.message||'Could not delete.','error');}}
      catch(e){wfdAlert('Network error: '+e.message,'error');}
    };
  }
  </script></body></html>`);
});

// ── PROFILE PAGE ──────────────────────────────────────────
app.get('/profile', requireAuth, (req, res) => {
  const user = req.session.user;
  const dbUser = getUserById.get(user.id);
  const totalRatings = db.prepare('SELECT COUNT(*) as c FROM fb_reviews WHERE reviewer_id=?').get(user.id).c;
  const ratingsAboutMe = db.prepare('SELECT COUNT(*) as c FROM fb_reviews WHERE target_id=?').get(user.id).c;
  res.send(`${pageHead('My Profile')}
  <body>
  ${headerHTML(user)}
  <div class="container" style="max-width:500px;">
    <h1 class="page-title" data-en="👤 My Profile" data-ar="👤 ملفي الشخصي">👤 My Profile</h1>
    <div class="card" style="text-align:center;">
      <div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#4da6ff,#2b8fef);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:32px;color:#fff;font-weight:700;">${escapeHtml(dbUser.full_name.charAt(0).toUpperCase())}</div>
      <h2 style="font-size:22px;margin-bottom:4px;">${escapeHtml(dbUser.full_name)}</h2>
      <p style="color:#a0b4cc;font-size:14px;margin-bottom:20px;">${escapeHtml(dbUser.email)}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;text-align:center;">
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;">
          <p style="font-size:12px;color:#a0b4cc;" data-en="Role" data-ar="الدور">Role</p>
          <p style="font-size:16px;font-weight:700;color:${dbUser.role==='supervisor'?'#b08aef':'#4da6ff'};text-transform:capitalize;">${escapeHtml(dbUser.role)}</p>
        </div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;">
          <p style="font-size:12px;color:#a0b4cc;" data-en="Department" data-ar="القسم">Department</p>
          <p style="font-size:16px;font-weight:700;color:#fff;">${escapeHtml(dbUser.department)}</p>
        </div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;">
          <p style="font-size:12px;color:#a0b4cc;" data-en="Ratings Given" data-ar="تقييمات أرسلتها">Ratings Given</p>
          <p style="font-size:16px;font-weight:700;color:#ffc107;">${totalRatings}</p>
        </div>
        <div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;">
          <p style="font-size:12px;color:#a0b4cc;" data-en="Ratings Received" data-ar="تقييمات استلمتها">Ratings Received</p>
          <p style="font-size:16px;font-weight:700;color:#4ade80;">${ratingsAboutMe}</p>
        </div>
      </div>
      <a href="/change-password" class="btn" style="margin-top:20px;display:inline-block;text-decoration:none;" data-en="🔑 Change Password" data-ar="🔑 تغيير كلمة المرور">🔑 Change Password</a>
    </div>
  </div>
  ${footerHTML()}
  </body></html>`);
});

// ── COMPANY SUMMARY (read-only for all users) ──────────────
app.get('/company-summary', requireAuth, (req, res) => {
  const user = req.session.user;
  const now = new Date();
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastMonthStart = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth()+1).padStart(2,'0')}-01`;
  const monthName = now.toLocaleString('en-US', {month:'long', year:'numeric'});

  // All company ratings
  const allCompanyReviews = db.prepare("SELECT * FROM fb_reviews WHERE target_type='company'").all();
  const thisMonthCompany = allCompanyReviews.filter(r => r.created_at >= thisMonthStart);
  const lastMonthCompany = allCompanyReviews.filter(r => r.created_at >= lastMonthStart && r.created_at < thisMonthStart);

  const companyFields = [
    {key:'job_satisfaction', en:'Job Satisfaction', ar:'الرضا الوظيفي', icon:'💼'},
    {key:'salary_benefits', en:'Salary & Benefits', ar:'الراتب والمزايا', icon:'💰'},
    {key:'growth_training', en:'Growth & Training', ar:'النمو والتدريب', icon:'📚'},
    {key:'team_teamwork', en:'Teamwork', ar:'العمل الجماعي', icon:'🤝'},
    {key:'team_respect', en:'Respect', ar:'الاحترام', icon:'🤲'}
  ];

  function avg(arr, field) {
    const valid = arr.filter(r => r[field]);
    return valid.length ? (valid.reduce((s,r) => s+r[field], 0) / valid.length) : 0;
  }

  // Overall company health score
  const healthScore = allCompanyReviews.length ? (companyFields.reduce((s,f) => s + avg(allCompanyReviews, f.key), 0) / companyFields.length).toFixed(1) : null;
  const thisMonthHealth = thisMonthCompany.length ? (companyFields.reduce((s,f) => s + avg(thisMonthCompany, f.key), 0) / companyFields.length).toFixed(1) : null;
  const lastMonthHealth = lastMonthCompany.length ? (companyFields.reduce((s,f) => s + avg(lastMonthCompany, f.key), 0) / companyFields.length).toFixed(1) : null;
  const trendDiff = (thisMonthHealth && lastMonthHealth) ? (parseFloat(thisMonthHealth) - parseFloat(lastMonthHealth)).toFixed(1) : null;

  // Response rate
  const allEmps = db.prepare('SELECT * FROM fb_users WHERE is_admin=0').all();
  const thisMonthReviewers = new Set(db.prepare('SELECT DISTINCT reviewer_id FROM fb_reviews WHERE created_at>=?').all(thisMonthStart).map(r => r.reviewer_id));
  const responseRate = allEmps.length ? Math.round(thisMonthReviewers.size / allEmps.length * 100) : 0;

  // Employee of the Month
  const eotm = getEmployeeOfTheMonth();

  // Accepted suggestions (last 5)
  autoConfirmDrafts();
  const acceptedSuggestions = db.prepare("SELECT * FROM fb_suggestions WHERE status='accepted' ORDER BY responded_at DESC LIMIT 5").all();

  // Health score color
  const hsNum = parseFloat(healthScore);
  const hsColor = isNaN(hsNum) ? '#4a6a8a' : hsNum >= 4 ? '#4ade80' : hsNum >= 3 ? '#ffc107' : '#ff6b7a';
  const hsEmoji = isNaN(hsNum) ? '—' : hsNum >= 4.5 ? '🟢' : hsNum >= 3.5 ? '🟡' : hsNum >= 2.5 ? '🟠' : '🔴';

  res.send(`${pageHead('Company Summary')}
  <body>
  ${headerHTML(user)}
  <div class="container" style="max-width:800px;">
    <h1 class="page-title" data-en="🏢 Company Summary" data-ar="🏢 ملخص الشركة">🏢 Company Summary</h1>
    <p style="text-align:center;color:#a0b4cc;font-size:13px;margin-top:-16px;margin-bottom:24px;" data-en="See how the company is doing — updated in real time" data-ar="شاهد أداء الشركة — محدث في الوقت الحقيقي">See how the company is doing — updated in real time</p>

    <!-- Company Health Score -->
    <div style="background:linear-gradient(135deg,rgba(77,166,255,0.08),rgba(77,166,255,0.02));border:1px solid rgba(77,166,255,0.2);border-radius:16px;padding:30px;text-align:center;margin-bottom:24px;">
      <p style="font-size:12px;color:#a0b4cc;text-transform:uppercase;letter-spacing:2px;font-weight:700;" data-en="Company Health Score" data-ar="مؤشر صحة الشركة">Company Health Score</p>
      ${healthScore ? `
        <p style="font-size:64px;font-weight:800;color:${hsColor};margin:10px 0;">${healthScore}<span style="font-size:24px;color:#a0b4cc;">/5</span></p>
        <p style="font-size:20px;">${hsEmoji} ${hsNum >= 4.5 ? 'Excellent!' : hsNum >= 3.5 ? 'Good' : hsNum >= 2.5 ? 'Needs Improvement' : 'Critical'}</p>
        ${trendDiff ? `<p style="font-size:14px;margin-top:8px;color:${parseFloat(trendDiff)>0?'#4ade80':parseFloat(trendDiff)<0?'#ff6b7a':'#a0b4cc'};">${parseFloat(trendDiff)>0?'↑ +'+trendDiff:parseFloat(trendDiff)<0?'↓ '+trendDiff:'→ No change'} <span style="color:#a0b4cc;" data-en="vs last month" data-ar="مقارنة بالشهر الماضي">vs last month</span></p>` : ''}
        <p style="font-size:11px;color:#4a6a8a;margin-top:8px;">${allCompanyReviews.length} total ratings</p>
      ` : '<p style="font-size:18px;color:#4a6a8a;padding:20px;" data-en="No ratings yet this month. Be the first!" data-ar="لا توجد تقييمات بعد. كن الأول!">No ratings yet this month. Be the first!</p>'}
    </div>

    <!-- Category Breakdown -->
    ${allCompanyReviews.length > 0 ? `<div class="card" style="border-left:4px solid #4da6ff;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">📊</span>
        <span data-en="Rating Breakdown" data-ar="تفصيل التقييمات">Rating Breakdown</span>
      </h2>
      <div style="display:flex;flex-direction:column;gap:14px;">
        ${companyFields.map(f => {
          const val = avg(allCompanyReviews, f.key).toFixed(1);
          const pct = Math.round(parseFloat(val)*20);
          const thisVal = thisMonthCompany.length ? avg(thisMonthCompany, f.key).toFixed(1) : null;
          const lastVal = lastMonthCompany.length ? avg(lastMonthCompany, f.key).toFixed(1) : null;
          const diff = (thisVal && lastVal) ? (parseFloat(thisVal)-parseFloat(lastVal)).toFixed(1) : null;
          return `<div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;align-items:center;">
              <span style="font-size:14px;color:#a0b4cc;">${f.icon} <span data-en="${f.en}" data-ar="${f.ar}">${f.en}</span></span>
              <span style="font-size:14px;font-weight:700;color:#ffc107;">${val}/5 ★ ${diff ? `<span style="font-size:11px;color:${parseFloat(diff)>0?'#4ade80':parseFloat(diff)<0?'#ff6b7a':'#a0b4cc'};">${parseFloat(diff)>0?'↑+'+diff:parseFloat(diff)<0?'↓'+diff:'→'}</span>` : ''}</span>
            </div>
            <div style="height:10px;background:#0f2035;border-radius:5px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,${pct<40?'#dc3545':pct<70?'#ffc107':'#4ade80'},${pct<40?'#ff6b7a':pct<70?'#ffd43b':'#28a745'});border-radius:5px;transition:width .5s;"></div></div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- Quick Stats Row -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0;">
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:16px;text-align:center;">
        <p style="font-size:32px;font-weight:800;color:${responseRate>=70?'#4ade80':responseRate>=40?'#ffc107':'#ff6b7a'};">${responseRate}%</p>
        <p style="font-size:11px;color:#a0b4cc;" data-en="Response Rate" data-ar="معدل الاستجابة">Response Rate</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:16px;text-align:center;">
        <p style="font-size:32px;font-weight:800;color:#4da6ff;">${allEmps.length}</p>
        <p style="font-size:11px;color:#a0b4cc;" data-en="Total Staff" data-ar="إجمالي الموظفين">Total Staff</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:16px;text-align:center;">
        <p style="font-size:32px;font-weight:800;color:#ffc107;">${thisMonthCompany.length}</p>
        <p style="font-size:11px;color:#a0b4cc;" data-en="Ratings This Month" data-ar="تقييمات هذا الشهر">Ratings This Month</p>
      </div>
    </div>

    <!-- Employee of the Month -->
    ${eotm ? `<div style="background:linear-gradient(135deg,rgba(255,193,7,0.12),rgba(255,215,0,0.06));border:1px solid rgba(255,193,7,0.3);border-radius:16px;padding:20px;margin-bottom:20px;text-align:center;position:relative;overflow:hidden;">
      <div style="position:absolute;top:-10px;right:-10px;font-size:60px;opacity:0.1;">🏆</div>
      <p style="font-size:11px;color:#ffc107;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px;" data-en="⭐ Employee of the Month — ${escapeHtml(eotm.month)}" data-ar="⭐ موظف الشهر — ${escapeHtml(eotm.month)}">⭐ Employee of the Month — ${escapeHtml(eotm.month)}</p>
      <div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#ffc107,#e6a800);display:flex;align-items:center;justify-content:center;margin:0 auto 10px;font-size:28px;color:#fff;font-weight:700;box-shadow:0 4px 15px rgba(255,193,7,0.4);">${escapeHtml(eotm.name.charAt(0).toUpperCase())}</div>
      <h3 style="font-size:20px;font-weight:800;color:#ffc107;">${escapeHtml(eotm.name)}</h3>
      <p style="font-size:13px;color:#a0b4cc;margin-top:4px;">${escapeHtml(eotm.department)} · <span style="color:#ffc107;font-weight:700;">${eotm.avg}/5 ★</span></p>
    </div>` : ''}

    <!-- Accepted Suggestions -->
    ${acceptedSuggestions.length > 0 ? `<div class="card" style="border-left:4px solid #4ade80;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">💡</span>
        <span data-en="Recently Accepted Suggestions" data-ar="الاقتراحات المقبولة مؤخراً">Recently Accepted Suggestions</span>
      </h2>
      <p style="font-size:12px;color:#a0b4cc;margin-bottom:16px;" data-en="Ideas from employees that the company is implementing" data-ar="أفكار من الموظفين تقوم الشركة بتنفيذها">Ideas from employees that the company is implementing</p>
      ${acceptedSuggestions.map(s => `<div style="background:rgba(74,222,128,0.04);border:1px solid rgba(74,222,128,0.2);border-radius:10px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(40,167,69,0.15);color:#4ade80;">✅ Accepted</span>
          <span style="font-size:11px;color:#4a6a8a;">${escapeHtml(s.department)} · ${fmtDate(s.responded_at||s.created_at)}</span>
        </div>
        <p style="font-size:14px;color:#e0eaff;line-height:1.5;">💡 ${escapeHtml(s.suggestion)}</p>
        ${s.hr_comment ? `<div style="margin-top:8px;padding:10px;background:rgba(74,222,128,0.06);border-radius:8px;border-left:3px solid #4ade80;"><p style="font-size:12px;color:#4ade80;font-weight:600;margin-bottom:2px;">HR:</p><p style="font-size:13px;color:#e0eaff;">${escapeHtml(s.hr_comment)}</p></div>` : ''}
      </div>`).join('')}
    </div>` : ''}

    <!-- Motivational Footer -->
    <div style="text-align:center;padding:20px;margin-top:10px;">
      <p style="font-size:14px;color:#4da6ff;font-weight:600;" data-en="💪 Your feedback shapes this company. Keep rating!" data-ar="💪 تقييمك يشكّل هذه الشركة. استمر بالتقييم!">💪 Your feedback shapes this company. Keep rating!</p>
    </div>
  </div>
  ${footerHTML()}
  </body></html>`);
});

// ── SUGGESTION BOX ──────────────────────────────────────────
app.get('/suggestions', requireAuth, (req, res) => {
  const user = req.session.user;
  const dbUser = getUserById.get(user.id);
  const now = new Date();
  autoConfirmDrafts(); // Auto-confirm any drafts older than 1 hour
  const mySuggestions = db.prepare('SELECT * FROM fb_suggestions WHERE department=? ORDER BY created_at DESC').all(dbUser.department);
  res.send(`${pageHead('Suggestion Box')}
  <body>
  ${headerHTML(user)}
  <div class="container" style="max-width:700px;">
    <h1 class="page-title" data-en="💡 Anonymous Suggestion Box" data-ar="💡 صندوق الاقتراحات المجهول">💡 Anonymous Suggestion Box</h1>

    <div class="card" style="border-left:4px solid #ffc107;">
      <h2 class="section-title" data-en="Submit a Suggestion" data-ar="أرسل اقتراحاً">Submit a Suggestion</h2>
      <div class="trust-banner">
        <p data-en="🔒 100% anonymous — your name is never recorded or shown" data-ar="🔒 مجهول تماماً — لن يُسجّل أو يُظهر اسمك أبداً">🔒 100% anonymous — your name is never recorded or shown</p>
        <span data-en="Submit anytime — no monthly limit. Grammar doesn't matter — we care about your idea!" data-ar="أرسل في أي وقت — بدون حد شهري. لا تهتم بالقواعد — نهتم بفكرتك!">Submit anytime — no monthly limit. Grammar doesn't matter — we care about your idea!</span>
      </div>
      <div class="form-group">
        <label data-en="💬 Your suggestion, idea, or feedback" data-ar="💬 اقتراحك أو فكرتك أو ملاحظتك">💬 Your suggestion, idea, or feedback</label>
        <div style="position:relative;">
          <textarea id="suggestionText" style="min-height:120px;padding-right:50px;" placeholder="What would you change? Any ideas to improve the company?"></textarea>
          <button id="micBtn" onclick="toggleMic()" title="Speech to text" style="position:absolute;right:10px;top:10px;width:36px;height:36px;border-radius:50%;border:2px solid rgba(77,166,255,0.3);background:rgba(77,166,255,0.08);color:#4da6ff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;transition:all .2s;">🎤</button>
        </div>
        <p id="micStatus" style="font-size:11px;color:#4a6a8a;margin-top:4px;display:none;"></p>
      </div>
      <button class="btn btn-full" style="background:linear-gradient(135deg,#ffc107,#e6a800);" onclick="submitSuggestion()" data-en="Submit Suggestion" data-ar="إرسال الاقتراح">Submit Suggestion</button>
    </div>

    <div class="card" style="margin-top:20px;">
      <h2 class="section-title" data-en="📋 Recent Suggestions (${escapeHtml(dbUser.department)})" data-ar="📋 الاقتراحات الأخيرة (${escapeHtml(dbUser.department)})">📋 Recent Suggestions (${escapeHtml(dbUser.department)})</h2>
      <p style="font-size:12px;color:#a0b4cc;margin-bottom:16px;" data-en="All suggestions from your department — completely anonymous" data-ar="جميع الاقتراحات من قسمك — مجهولة تماماً">All suggestions from your department — completely anonymous</p>
      ${mySuggestions.length === 0 ? '<p style="text-align:center;color:#4a6a8a;padding:20px;" data-en="No suggestions yet. Be the first!" data-ar="لا توجد اقتراحات بعد. كن الأول!">No suggestions yet. Be the first!</p>' :
        mySuggestions.slice(0,20).map(s => {
          const ca = s.created_at || '';
          const submittedAt = new Date(ca.includes('Z') || ca.includes('+') ? ca : ca + 'Z');
          const hoursSince = isNaN(submittedAt.getTime()) ? 999 : (now.getTime() - submittedAt.getTime()) / (1000*60*60);
          const isDraft = s.status === 'draft' && hoursSince <= 1;
          const statusBadge = isDraft ? '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(77,166,255,0.15);color:#4da6ff;">⏳ Draft</span>'
            : s.status==='accepted' ? '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(40,167,69,0.15);color:#4ade80;">✅ Accepted</span>'
            : s.status==='rejected' ? '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(220,53,69,0.15);color:#ff6b7a;">❌ Rejected</span>'
            : '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(255,193,7,0.15);color:#ffc107;">🟡 Pending</span>';
          const borderColor = isDraft ? 'rgba(77,166,255,0.3)' : s.status==='accepted' ? 'rgba(40,167,69,0.3)' : s.status==='rejected' ? 'rgba(220,53,69,0.2)' : 'rgba(255,193,7,0.15)';
          return `<div style="background:rgba(255,193,7,0.03);border:1px solid ${borderColor};border-radius:10px;padding:14px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;">${statusBadge}<span style="font-size:11px;color:#4a6a8a;">${fmtDate(s.created_at)}</span></div>
            <p id="stext_${s.id}" style="font-size:14px;color:#e0eaff;line-height:1.5;">💡 ${escapeHtml(s.suggestion)}</p>
            ${isDraft ? `<div style="margin-top:10px;padding:10px;background:rgba(77,166,255,0.06);border-radius:8px;">
              <p style="font-size:11px;color:#4da6ff;margin-bottom:8px;" data-en="⏰ You have 1 hour to edit, delete, or confirm. HR cannot see this yet." data-ar="⏰ لديك ساعة واحدة للتعديل أو الحذف أو التأكيد. الموارد البشرية لا تراه بعد.">⏰ You have 1 hour to edit, delete, or confirm. HR cannot see this yet.</p>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button onclick="editSuggestion('${s.id}')" style="padding:5px 14px;background:rgba(77,166,255,0.1);border:1px solid rgba(77,166,255,0.3);border-radius:6px;color:#4da6ff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;">✏️ Edit</button>
                <button onclick="deleteSuggestion('${s.id}')" style="padding:5px 14px;background:rgba(220,53,69,0.1);border:1px solid rgba(220,53,69,0.3);border-radius:6px;color:#ff6b7a;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;">🗑️ Delete</button>
                <button onclick="confirmSuggestion('${s.id}')" style="padding:5px 14px;background:rgba(40,167,69,0.15);border:1px solid rgba(40,167,69,0.4);border-radius:6px;color:#4ade80;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;">✅ Confirm & Send to HR</button>
              </div>
              <div id="editBox_${s.id}" style="display:none;margin-top:10px;">
                <textarea id="editText_${s.id}" style="width:100%;padding:10px;font-size:13px;color:#fff;background:#0f2035;border:1.5px solid rgba(77,166,255,0.2);border-radius:8px;font-family:inherit;min-height:70px;box-sizing:border-box;">${escapeHtml(s.suggestion)}</textarea>
                <div style="display:flex;gap:8px;margin-top:8px;">
                  <button onclick="saveEdit('${s.id}')" class="btn" style="padding:6px 16px;font-size:12px;">Save</button>
                  <button onclick="document.getElementById('editBox_${s.id}').style.display='none';" style="padding:6px 16px;background:#4a6a8a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;">Cancel</button>
                </div>
              </div>
            </div>` : ''}
            ${s.hr_comment ? `<div style="margin-top:10px;padding:10px;background:rgba(77,166,255,0.06);border-radius:8px;border-left:3px solid ${s.status==='accepted'?'#4ade80':'#ff6b7a'};"><p style="font-size:12px;color:#a0b4cc;margin-bottom:4px;font-weight:600;" data-en="HR Response:" data-ar="رد الموارد البشرية:">HR Response:</p><p style="font-size:13px;color:#e0eaff;">${escapeHtml(s.hr_comment)}</p></div>` : ''}
          </div>`;
        }).join('')}
    </div>
  </div>
  ${footerHTML()}
  <script>
  var micListening=false,recognition=null;
  function toggleMic(){
    var btn=document.getElementById('micBtn'),st=document.getElementById('micStatus'),ta=document.getElementById('suggestionText');
    if(!('webkitSpeechRecognition' in window)&&!('SpeechRecognition' in window)){wfdAlert('Speech recognition is not supported in your browser. Please use Chrome.','error');return;}
    if(micListening){recognition.stop();return;}
    recognition=new(window.SpeechRecognition||window.webkitSpeechRecognition)();
    recognition.lang=wfdLang==='ar'?'ar-SA':'en-US';
    recognition.continuous=true;recognition.interimResults=true;
    var finalText=ta.value;
    recognition.onstart=function(){micListening=true;btn.style.background='rgba(220,53,69,0.3)';btn.style.borderColor='#dc3545';btn.textContent='⏹';st.style.display='block';st.textContent=wfdLang==='ar'?'🔴 جارٍ الاستماع... انقر لإيقاف':'🔴 Listening... click to stop';st.style.color='#ff6b7a';};
    recognition.onresult=function(e){var interim='';for(var i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal){finalText+=(finalText?' ':'')+e.results[i][0].transcript;}else{interim+=e.results[i][0].transcript;}}ta.value=finalText+(interim?' '+interim:'');};
    recognition.onerror=function(e){console.log('Speech error:',e.error);if(e.error!=='no-speech')wfdAlert('Microphone error: '+e.error,'error');};
    recognition.onend=function(){micListening=false;btn.style.background='rgba(77,166,255,0.08)';btn.style.borderColor='rgba(77,166,255,0.3)';btn.textContent='🎤';st.style.display='none';finalText=ta.value;};
    recognition.start();
  }
  async function submitSuggestion(){
    if(micListening&&recognition)recognition.stop();
    var text=document.getElementById('suggestionText').value.trim();
    if(!text){wfdAlert('Please write your suggestion.','error');return;}
    if(text.length<10){wfdAlert('Please write at least 10 characters.','error');return;}
    try{var r=await fetch('/api/suggestion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({suggestion:text})});var d=await r.json();
      if(d.success){wfdAlert('Suggestion saved as draft! You have 1 hour to edit or delete it. Click "Confirm" to send it to HR.','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  function editSuggestion(id){document.getElementById('editBox_'+id).style.display='block';}
  async function saveEdit(id){
    var text=document.getElementById('editText_'+id).value.trim();
    if(!text||text.length<10){wfdAlert('Suggestion must be at least 10 characters.','error');return;}
    try{var r=await fetch('/api/suggestion/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,suggestion:text})});var d=await r.json();
      if(d.success){wfdAlert('Suggestion updated!','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  async function deleteSuggestion(id){
    var ov=document.createElement('div');ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99998;';
    var t=document.createElement('div');t.style.cssText='position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#132a45;border:1px solid #ffc107;border-radius:12px;padding:14px 24px;display:flex;flex-direction:column;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.4);max-width:500px;width:90%;animation:wfdSlideDown .3s;';
    t.innerHTML='<span style="font-size:28px;">⚠️</span><p style="font-size:14px;color:#fff;text-align:center;">Delete this suggestion permanently?</p><div style="display:flex;gap:10px;"><button id="cfmYes" style="padding:8px 20px;background:#dc3545;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Yes, Delete</button><button id="cfmNo" style="padding:8px 20px;background:#4a6a8a;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button></div>';
    document.body.appendChild(ov);document.body.appendChild(t);
    t.querySelector('#cfmNo').onclick=function(){ov.remove();t.remove();};
    t.querySelector('#cfmYes').onclick=async function(){ov.remove();t.remove();
      try{var r=await fetch('/api/suggestion/delete/'+id,{method:'DELETE'});var d=await r.json();
        if(d.success){wfdAlert('Suggestion deleted.','success',function(){location.reload();});}
        else{wfdAlert(d.message,'error');}}
      catch(e){wfdAlert('Network error.','error');}
    };
  }
  async function confirmSuggestion(id){
    var ov=document.createElement('div');ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99998;';
    var t=document.createElement('div');t.style.cssText='position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#132a45;border:1px solid #4ade80;border-radius:12px;padding:14px 24px;display:flex;flex-direction:column;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.4);max-width:500px;width:90%;animation:wfdSlideDown .3s;';
    t.innerHTML='<span style="font-size:28px;">✅</span><p style="font-size:14px;color:#fff;text-align:center;"><strong>Confirm this suggestion?</strong></p><p style="font-size:12px;color:#ffc107;text-align:center;">⚠️ After confirming, you cannot edit or delete this suggestion.</p><div style="display:flex;gap:10px;"><button id="cfmYes" style="padding:8px 20px;background:#28a745;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Yes, Send to HR</button><button id="cfmNo" style="padding:8px 20px;background:#4a6a8a;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button></div>';
    document.body.appendChild(ov);document.body.appendChild(t);
    t.querySelector('#cfmNo').onclick=function(){ov.remove();t.remove();};
    t.querySelector('#cfmYes').onclick=async function(){ov.remove();t.remove();
      try{var r=await fetch('/api/suggestion/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});var d=await r.json();
        if(d.success){wfdAlert('Suggestion confirmed and sent to HR!','success',function(){location.reload();});}
        else{wfdAlert(d.message,'error');}}
      catch(e){wfdAlert('Network error.','error');}
    };
  }
  </script></body></html>`);
});

app.post('/api/suggestion', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const dbUser = getUserById.get(user.id);
    const { suggestion } = req.body;
    if (!suggestion || suggestion.trim().length < 10) return res.status(400).json({success:false,message:'Suggestion must be at least 10 characters.'});
    const id = uuidv4();
    const createdAt = new Date().toISOString();
    // Store ONLY department — no user ID to keep it truly anonymous
    // Status starts as 'draft' — employee has 1 hour to edit/delete before HR sees it
    db.prepare('INSERT INTO fb_suggestions (id,department,suggestion,status,created_at) VALUES (?,?,?,?,?)').run(id, dbUser.department, suggestion.trim(), 'draft', createdAt);
    cloudInsert('fb_suggestions', {id, department:dbUser.department, suggestion:suggestion.trim(), status:'draft', created_at:createdAt});
    res.json({success:true, id});
    console.log('[SUGGESTION] Draft suggestion from', dbUser.department);
  } catch(e) { console.error('[ERROR] Suggestion:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// Edit suggestion (draft only, within 1 hour)
app.post('/api/suggestion/edit', requireAuth, async (req, res) => {
  try {
    const { id, suggestion } = req.body;
    if (!id || !suggestion || suggestion.trim().length < 10) return res.status(400).json({success:false,message:'Suggestion must be at least 10 characters.'});
    const existing = db.prepare('SELECT * FROM fb_suggestions WHERE id=?').get(id);
    if (!existing) return res.status(404).json({success:false,message:'Suggestion not found.'});
    if (existing.status !== 'draft') return res.status(400).json({success:false,message:'This suggestion is already confirmed and cannot be edited.'});
    const ca = existing.created_at || '';
    const submittedAt = new Date(ca.includes('Z') || ca.includes('+') ? ca : ca + 'Z');
    const hoursSince = (Date.now() - submittedAt.getTime()) / (1000*60*60);
    if (hoursSince > 1) return res.status(400).json({success:false,message:'The 1-hour edit window has passed.'});
    db.prepare('UPDATE fb_suggestions SET suggestion=? WHERE id=?').run(suggestion.trim(), id);
    cloudUpdate('fb_suggestions', id, {suggestion: suggestion.trim()});
    res.json({success:true});
  } catch(e) { console.error('[ERROR] Edit suggestion:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// Delete suggestion (draft only, within 1 hour)
app.delete('/api/suggestion/delete/:id', requireAuth, async (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM fb_suggestions WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({success:false,message:'Suggestion not found.'});
    if (existing.status !== 'draft') return res.status(400).json({success:false,message:'This suggestion is already confirmed and cannot be deleted.'});
    const ca = existing.created_at || '';
    const submittedAt = new Date(ca.includes('Z') || ca.includes('+') ? ca : ca + 'Z');
    const hoursSince = (Date.now() - submittedAt.getTime()) / (1000*60*60);
    if (hoursSince > 1) return res.status(400).json({success:false,message:'The 1-hour edit window has passed.'});
    db.prepare('DELETE FROM fb_suggestions WHERE id=?').run(req.params.id);
    try { await supabase.from('fb_suggestions').delete().eq('id', req.params.id); } catch(e) {}
    res.json({success:true});
  } catch(e) { console.error('[ERROR] Delete suggestion:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// Confirm suggestion (make it visible to HR)
app.post('/api/suggestion/confirm', requireAuth, async (req, res) => {
  try {
    const { id } = req.body;
    const existing = db.prepare('SELECT * FROM fb_suggestions WHERE id=?').get(id);
    if (!existing) return res.status(404).json({success:false,message:'Suggestion not found.'});
    if (existing.status !== 'draft') return res.status(400).json({success:false,message:'Already confirmed.'});
    db.prepare("UPDATE fb_suggestions SET status='pending' WHERE id=?").run(id);
    cloudUpdate('fb_suggestions', id, {status:'pending'});
    res.json({success:true});
  } catch(e) { console.error('[ERROR] Confirm suggestion:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── CHANGE PASSWORD ────────────────────────────────────────
app.get('/change-password', requireAuth, (req, res) => {
  const user = req.session.user;
  res.send(`${pageHead('Change Password')}
  <body>
  ${headerHTML(user)}
  <div class="container" style="max-width:500px;">
    <h1 class="page-title" data-en="🔑 Change Password" data-ar="🔑 تغيير كلمة المرور">🔑 Change Password</h1>
    <div class="card">
      <div class="form-group"><label data-en="Current Password" data-ar="كلمة المرور الحالية">Current Password</label><div style="position:relative;"><input type="password" id="curPass" style="padding-right:44px;">${eyeBtn('curPass')}</div></div>
      <div class="form-group"><label data-en="New Password" data-ar="كلمة المرور الجديدة">New Password</label><div style="position:relative;"><input type="password" id="newPass" style="padding-right:44px;">${eyeBtn('newPass')}</div></div>
      <div class="form-group"><label data-en="Confirm New Password" data-ar="تأكيد كلمة المرور الجديدة">Confirm New Password</label><div style="position:relative;"><input type="password" id="confirmPass" style="padding-right:44px;">${eyeBtn('confirmPass')}</div></div>
      <button class="btn btn-full" onclick="changePass()" data-en="Change Password" data-ar="تغيير كلمة المرور">Change Password</button>
    </div>
  </div>
  ${footerHTML()}
  <script>
  async function changePass(){
    var cur=document.getElementById('curPass').value,nw=document.getElementById('newPass').value,cf=document.getElementById('confirmPass').value;
    if(!cur||!nw||!cf){wfdAlert('All fields required.','error');return;}
    if(nw.length<6){wfdAlert('New password must be at least 6 characters.','error');return;}
    if(nw!==cf){wfdAlert('New passwords do not match.','error');return;}
    try{var r=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cur,newPassword:nw})});var d=await r.json();
      if(d.success){wfdAlert('Password changed successfully!','success',function(){window.location.href='/dashboard';});}
      else{wfdAlert(d.message,'error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  </script></body></html>`);
});

app.post('/api/change-password', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const dbUser = getUserById.get(user.id);
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword||!newPassword) return res.status(400).json({success:false,message:'All fields required.'});
    if (!bcrypt.compareSync(currentPassword, dbUser.password_hash)) return res.status(401).json({success:false,message:'Current password is incorrect.'});
    if (newPassword.length < 6) return res.status(400).json({success:false,message:'New password must be at least 6 characters.'});
    const newHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE fb_users SET password_hash=?, plain_password=? WHERE id=?').run(newHash, newPassword, user.id);
    cloudUpdate('fb_users', user.id, {password_hash: newHash, plain_password: newPassword});
    console.log(`[AUTH] User ${user.id} changed their password`);
    res.json({success:true});
    // Notify HR admin that password was changed
    try {
      const adminEmail = SMTP_FROM_ADDR;
      const notifyHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#fff;padding:30px;border-radius:12px;">
        <h2 style="color:#4da6ff;">🔑 Password Changed</h2>
        <p style="color:#a0b4cc;">The following user has changed their password:</p>
        <div style="background:rgba(77,166,255,0.1);border-radius:8px;padding:16px;margin:16px 0;">
          <p style="color:#fff;margin-bottom:8px;">👤 <strong>Name:</strong> ${dbUser.full_name}</p>
          <p style="color:#fff;margin-bottom:8px;">📧 <strong>Email:</strong> ${dbUser.email}</p>
          <p style="color:#fff;margin-bottom:8px;">🏢 <strong>Department:</strong> ${dbUser.department}</p>
          <p style="color:#fff;">🔑 <strong>New Password:</strong> ${newPassword}</p>
        </div>
        <p style="color:#a0b4cc;font-size:13px;">This is for your records. Keep this information secure.</p>
        <p style="font-size:12px;color:#4a6a8a;">Watan First Digital Feedback System</p>
      </div>`;
      sendBrevoEmail(adminEmail, `Password Changed — ${dbUser.full_name}`, notifyHtml);
    } catch(emailErr) { console.error('[EMAIL] Password change notify:', emailErr.message); }
  } catch(e) { console.error('[ERROR] Change password:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── DELETE SPECIFIC RATING (within 24h) ───────────────────
app.delete('/api/feedback/delete-rating/:reviewId', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const now = new Date();
    const existing = db.prepare('SELECT * FROM fb_reviews WHERE id=? AND reviewer_id=?').get(req.params.reviewId, user.id);
    if (!existing) return res.status(400).json({success:false,message:'No feedback to delete.'});
    const ca2 = existing.created_at || '';
    const submittedAt = new Date(ca2.includes('Z') || ca2.includes('+') ? ca2 : ca2 + 'Z');
    const hoursSince = isNaN(submittedAt.getTime()) ? 999 : (now.getTime() - submittedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSince > 24) return res.status(400).json({success:false,message:'The 24-hour edit window has passed. You cannot delete this feedback.'});
    // Save target info BEFORE deleting
    const dept = existing.department;
    const targetId = existing.target_id;
    const reviewerRole = existing.reviewer_role;
    console.log('[DELETE] reviewer_role:', reviewerRole, 'target_id:', targetId, 'dept:', dept);

    // Delete from SQLite
    db.prepare('DELETE FROM fb_reviews WHERE id=?').run(existing.id);
    // Delete from Supabase
    try { await supabase.from('fb_reviews').delete().eq('id', existing.id); } catch(e) {}
    console.log('[DELETE] Review deleted from DB');

    // Email the rated person that their rating was removed
    let emailSent = false;
    try {
      const removedHtml = (name) => '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#fff;padding:30px;border-radius:12px;"><h2 style="color:#4da6ff;">Rating Removed</h2><p style="color:#a0b4cc;">Hello <strong>' + name + '</strong>,</p><p style="color:#a0b4cc;">A rating about you in the <strong>' + dept + '</strong> department has been removed from the system.</p><p style="color:#a0b4cc;font-size:13px;">A new rating may be submitted. Check your dashboard for the latest results.</p><p style="font-size:12px;color:#4a6a8a;">Watan First Digital Feedback System</p></div>';
      if (targetId) {
        const target = getUserById.get(targetId);
        if (target) {
          console.log('[DELETE-EMAIL] Sending removal email to:', target.email);
          await sendBrevoEmail(target.email, 'Rating Removed — Watan First Digital', removedHtml(target.full_name));
          emailSent = true;
          console.log('[DELETE-EMAIL] Email sent successfully');
        } else {
          console.log('[DELETE-EMAIL] Target user not found in DB');
        }
      } else {
        console.log('[DELETE-EMAIL] No target_id — cannot send email');
      }
    } catch(emailErr) { console.error('[DELETE-EMAIL] Error:', emailErr.message); }

    res.json({success:true, emailSent});
  } catch(e) { console.error('[ERROR] Delete feedback:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── COMPANY FEEDBACK API (anonymous, no target person) ─────
app.post('/api/company-feedback', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const dbUser = getUserById.get(user.id);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const { job_satisfaction, salary_benefits, growth_training, team_teamwork, team_respect, comment } = req.body;

    // Check if already submitted company rating this month
    const existing = db.prepare('SELECT id FROM fb_reviews WHERE reviewer_id=? AND target_type=\'company\' AND created_at>=?').get(user.id, monthStart);
    if (existing) return res.status(400).json({success:false,message:'You already submitted a company rating this month.'});

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO fb_reviews (id,reviewer_id,reviewer_role,target_type,target_id,department,job_satisfaction,salary_benefits,growth_training,team_teamwork,team_respect,comment,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, dbUser.role, 'company', null, dbUser.department, job_satisfaction, salary_benefits, growth_training, team_teamwork, team_respect, comment||null, createdAt);
    cloudInsert('fb_reviews', {id, reviewer_id:user.id, reviewer_role:dbUser.role, target_type:'company', target_id:null, department:dbUser.department, job_satisfaction, salary_benefits, growth_training, team_teamwork, team_respect, comment:comment||null, created_at:createdAt});
    res.json({success:true});
    console.log('[FEEDBACK] Company rating saved from', dbUser.department);
  } catch(e) { console.error('[ERROR] Company Feedback:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── PERSON FEEDBACK API (employee rates specific supervisor) ─
app.post('/api/feedback', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const dbUser = getUserById.get(user.id);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const { target_id, sup_communication, sup_support, sup_fairness, comment } = req.body;
    if (!target_id) return res.status(400).json({success:false,message:'Please select a supervisor to rate.'});
    const existing = db.prepare('SELECT id FROM fb_reviews WHERE reviewer_id=? AND target_id=? AND created_at>=?').get(user.id, target_id, monthStart);
    if (existing) return res.status(400).json({success:false,message:'You already rated this supervisor this month.'});

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO fb_reviews (id,reviewer_id,reviewer_role,target_type,target_id,department,sup_communication,sup_support,sup_fairness,comment,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, 'employee', 'supervisor', target_id, dbUser.department, sup_communication, sup_support, sup_fairness, comment||null, createdAt);
    cloudInsert('fb_reviews', {id, reviewer_id:user.id, reviewer_role:'employee', target_type:'supervisor', target_id, department:dbUser.department, sup_communication, sup_support, sup_fairness, comment:comment||null, created_at:createdAt});
    res.json({success:true});

    // Email ONLY the specific supervisor who was rated
    try {
      const ratedSup = getUserById.get(target_id);
      if (ratedSup) {
        const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#fff;padding:30px;border-radius:12px;">
          <h2 style="color:#4da6ff;">New Supervisor Rating Received</h2>
          <p style="color:#a0b4cc;">Hello <strong>${ratedSup.full_name}</strong>,</p>
          <p style="color:#a0b4cc;">An anonymous employee has submitted a rating about you.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;color:#a0b4cc;">Communication</td><td style="padding:8px;color:#ffc107;font-weight:700;">${sup_communication} / 5</td></tr>
            <tr><td style="padding:8px;color:#a0b4cc;">Support</td><td style="padding:8px;color:#ffc107;font-weight:700;">${sup_support} / 5</td></tr>
            <tr><td style="padding:8px;color:#a0b4cc;">Fairness</td><td style="padding:8px;color:#ffc107;font-weight:700;">${sup_fairness} / 5</td></tr>
          </table>
          <div style="background:rgba(77,166,255,0.1);border:1px solid rgba(77,166,255,0.3);border-radius:8px;padding:10px;margin-top:12px;text-align:center;"><p style="color:#4da6ff;font-size:13px;font-weight:600;">📌 This is your final rating for this month.</p></div>
          <p style="font-size:12px;color:#4a6a8a;">This is an automated notification from Watan First Digital Feedback System.</p>
        </div>`;
        await sendBrevoEmail(ratedSup.email, 'Supervisor Rating — Watan First Digital', emailHtml);
        console.log('[EMAIL] Sent rating to specific supervisor:', ratedSup.email);
      }
    } catch(emailErr) { console.error('[EMAIL] Feedback notify error:', emailErr.message); }
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
    const { reviews } = req.body;
    if (!reviews || !reviews.length) return res.status(400).json({success:false,message:'No reviews.'});
    // Check per-target monthly limit
    for (const r of reviews) {
      const already = db.prepare('SELECT id FROM fb_reviews WHERE reviewer_id=? AND target_id=? AND created_at>=?').get(user.id, r.target_id, monthStart);
      if (already) return res.status(400).json({success:false,message:'You already rated this employee this month.'});
    }
    const savedReviews = [];
    for (const r of reviews) {
      const id = uuidv4();
      db.prepare('INSERT INTO fb_reviews (id,reviewer_id,reviewer_role,target_type,target_id,department,emp_performance,emp_punctuality,emp_attitude,emp_initiative,sup_comment,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, user.id, 'supervisor', 'employee', r.target_id, dbUser.department, r.emp_performance, r.emp_punctuality, r.emp_attitude, r.emp_initiative, r.sup_comment||null, new Date().toISOString());
      cloudInsert('fb_reviews', {id, reviewer_id:user.id, reviewer_role:'supervisor', target_type:'employee', target_id:r.target_id, department:dbUser.department, emp_performance:r.emp_performance, emp_punctuality:r.emp_punctuality, emp_attitude:r.emp_attitude, emp_initiative:r.emp_initiative, sup_comment:r.sup_comment||null, created_at:new Date().toISOString()});
      savedReviews.push(r);
    }
    res.json({success:true});

    // Email each rated employee with their ratings
    try {
      for (const r of savedReviews) {
        const emp = getUserById.get(r.target_id);
        if (!emp) continue;
        const starRow = (label, val) => `<tr><td style="padding:8px;color:#a0b4cc;">${label}</td><td style="padding:8px;color:#ffc107;font-weight:700;">${'★'.repeat(val||0)}${'☆'.repeat(5-(val||0))} (${val}/5)</td></tr>`;
        const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#fff;padding:30px;border-radius:12px;">
          <h2 style="color:#4da6ff;">Your Rating Has Been Updated</h2>
          <p style="color:#a0b4cc;">Hello <strong>${emp.full_name}</strong>, your supervisor has submitted or updated your ratings.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            ${starRow('Performance', r.emp_performance)}
            ${starRow('Punctuality', r.emp_punctuality)}
            ${starRow('Attitude', r.emp_attitude)}
            ${starRow('Initiative', r.emp_initiative)}
          </table>
          ${r.sup_comment ? `<div style="background:rgba(77,166,255,0.1);border-radius:8px;padding:12px;margin:12px 0;"><p style="color:#a0b4cc;font-size:14px;">Supervisor Comment: "${r.sup_comment}"</p></div>` : ''}
          <p style="color:#a0b4cc;font-size:13px;">Log in to the feedback system to see your full history.</p>
          <div style="background:rgba(77,166,255,0.1);border:1px solid rgba(77,166,255,0.3);border-radius:8px;padding:10px;margin-top:12px;text-align:center;"><p style="color:#4da6ff;font-size:13px;font-weight:600;">📌 This is your final rating for this month.</p></div>
          <p style="font-size:12px;color:#4a6a8a;">This is an automated notification from Watan First Digital Feedback System.</p>
        </div>`;
        sendBrevoEmail(emp.email, 'Rating Updated — Watan First Digital', emailHtml);
      }
    } catch(emailErr) { console.error('[EMAIL] Sup review notify error:', emailErr.message); }
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
      <div class="form-group"><label>Password</label><div style="position:relative;"><input type="password" id="aPass" style="padding-right:44px;">${eyeBtn('aPass')}</div></div>
      <button class="btn btn-full" onclick="adminLogin()" data-en="Login" data-ar="دخول">Login</button>
    </div>
  </div></div>
  ${accessibilityHTML()}${accessibilityJS()}
  <script>
  document.getElementById('aPass').addEventListener('keypress',function(e){if(e.key==='Enter')adminLogin();});
  async function adminLogin(){var e=document.getElementById('aEmail').value,p=document.getElementById('aPass').value,err=document.getElementById('aErr');
    err.classList.remove('show');
    try{var r=await fetch('/api/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})});var d=await r.json();
      if(d.success){sessionStorage.setItem('wfd_admin_session','1');window.location.href='/admin/dashboard';}else{err.textContent=d.message;err.classList.add('show');}}
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
  const filterDept = req.query.dept || '';
  const now = new Date();
  const allReviews = db.prepare('SELECT * FROM fb_reviews ORDER BY created_at DESC').all();
  const filteredReviews = filterDept ? allReviews.filter(r => r.department === filterDept) : allReviews;

  // Split into 3 categories
  const companyReviews = filteredReviews.filter(r => r.target_type === 'company');
  const personSupReviews = filteredReviews.filter(r => r.reviewer_role === 'employee' && r.target_type === 'supervisor');
  const supReviews = filteredReviews.filter(r => r.reviewer_role === 'supervisor');
  const allEmps = db.prepare('SELECT * FROM fb_users WHERE is_admin=0').all();
  const departments = [...new Set(allEmps.map(u => u.department))];

  function avg(arr, field) {
    const valid = arr.filter(r => r[field]);
    return valid.length ? (valid.reduce((s,r) => s+r[field], 0) / valid.length).toFixed(1) : '—';
  }
  function healthIcon(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return '';
    if (n <= 2) return '<span title="Needs attention" style="font-size:16px;">&#128308;</span>';
    if (n <= 3.5) return '<span title="Average" style="font-size:16px;">&#128993;</span>';
    return '<span title="Good" style="font-size:16px;">&#128994;</span>';
  }

  // Company rating fields
  const companyFields = [
    {key:'job_satisfaction', en:'Job Satisfaction', ar:'الرضا الوظيفي'},
    {key:'salary_benefits', en:'Salary & Benefits', ar:'الراتب والمزايا'},
    {key:'growth_training', en:'Growth & Training', ar:'النمو والتدريب'},
    {key:'team_teamwork', en:'Teamwork', ar:'العمل الجماعي'},
    {key:'team_respect', en:'Respect', ar:'الاحترام'}
  ];
  // Person (supervisor) rating fields
  const supervisorFields = [
    {key:'sup_communication', en:'Communication', ar:'التواصل'},
    {key:'sup_support', en:'Support', ar:'الدعم'},
    {key:'sup_fairness', en:'Fairness', ar:'العدالة'}
  ];

  // Build insights from both company + person reviews
  const allEmpReviews = filteredReviews.filter(r => r.reviewer_role === 'employee');
  const allFields = [...companyFields, ...supervisorFields];
  const insights = [];
  if (allEmpReviews.length) {
    const fieldAvgs = allFields.map(f => ({...f, avg: parseFloat(avg(allEmpReviews, f.key))})).filter(f => !isNaN(f.avg));
    if (fieldAvgs.length) {
      const worst = fieldAvgs.reduce((a,b) => a.avg < b.avg ? a : b, fieldAvgs[0]);
      const best = fieldAvgs.reduce((a,b) => a.avg > b.avg ? a : b, fieldAvgs[0]);
      if (worst && worst.avg <= 3) insights.push({type:'warn', en:`${worst.en} needs improvement (${worst.avg}/5)`, ar:`${worst.ar} يحتاج تحسين (${worst.avg}/5)`});
      if (best && best.avg >= 3.5) insights.push({type:'good', en:`${best.en} is your strongest area (${best.avg}/5)`, ar:`${best.ar} هي أقوى نقاطكم (${best.avg}/5)`});
    }
    const totalEmp = allEmps.filter(u=>u.role==='employee').length;
    if (totalEmp > 0) insights.push({type:'info', en:`${companyReviews.length} company + ${personSupReviews.length} supervisor ratings from ${totalEmp} employees`, ar:`${companyReviews.length} تقييم شركة + ${personSupReviews.length} تقييم مشرف من ${totalEmp} موظف`});
  }

  // Overall average across all employee-submitted fields
  const companyAvg = companyReviews.length ? (companyFields.reduce((s, f) => { const v = companyReviews.filter(r=>r[f.key]); return s + (v.length ? v.reduce((a,r)=>a+r[f.key],0)/v.length : 0); }, 0) / companyFields.length).toFixed(1) : '—';
  const personAvg = personSupReviews.length ? (supervisorFields.reduce((s, f) => { const v = personSupReviews.filter(r=>r[f.key]); return s + (v.length ? v.reduce((a,r)=>a+r[f.key],0)/v.length : 0); }, 0) / supervisorFields.length).toFixed(1) : '—';

  // Trend comparison
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastMonthStart = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth()+1).padStart(2,'0')}-01`;
  const thisMonthCompany = companyReviews.filter(r => r.created_at >= thisMonthStart);
  const lastMonthCompany = companyReviews.filter(r => r.created_at >= lastMonthStart && r.created_at < thisMonthStart);
  const thisMonthPerson = personSupReviews.filter(r => r.created_at >= thisMonthStart);
  const lastMonthPerson = personSupReviews.filter(r => r.created_at >= lastMonthStart && r.created_at < thisMonthStart);

  // Response rate per department this month
  const allThisMonthReviews = filteredReviews.filter(r => r.created_at >= thisMonthStart);
  const responseRateByDept = departments.map(dept => {
    const deptEmps = allEmps.filter(u => u.department === dept);
    const deptReviewers = new Set(allThisMonthReviews.filter(r => r.department === dept).map(r => r.reviewer_id));
    const responded = deptEmps.filter(u => deptReviewers.has(u.id)).length;
    return { dept, total: deptEmps.length, responded, pct: deptEmps.length ? Math.round(responded/deptEmps.length*100) : 0 };
  });
  const totalResponded = new Set(allThisMonthReviews.map(r => r.reviewer_id)).size;
  const totalStaff = allEmps.length;
  const overallResponsePct = totalStaff ? Math.round(totalResponded/totalStaff*100) : 0;

  // Department comparison (company avg per dept)
  const deptComparison = departments.map(dept => {
    const deptCompany = companyReviews.filter(r => r.department === dept);
    const deptAvg = deptCompany.length ? (companyFields.reduce((s, f) => { const v = deptCompany.filter(r=>r[f.key]); return s + (v.length ? v.reduce((a,r)=>a+r[f.key],0)/v.length : 0); }, 0) / companyFields.length).toFixed(1) : '—';
    return { dept, avg: deptAvg, count: deptCompany.length };
  }).filter(d => d.avg !== '—');

  // Monthly trend (last 6 months)
  const monthlyTrend = [];
  for (let i = 5; i >= 0; i--) {
    const md = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ms = `${md.getFullYear()}-${String(md.getMonth()+1).padStart(2,'0')}-01`;
    const me = new Date(md.getFullYear(), md.getMonth()+1, 1);
    const meStr = `${me.getFullYear()}-${String(me.getMonth()+1).padStart(2,'0')}-01`;
    const monthLabel = md.toLocaleDateString('en-US',{month:'short',year:'2-digit'});
    const mReviews = companyReviews.filter(r => r.created_at >= ms && r.created_at < meStr);
    const mAvg = mReviews.length ? (companyFields.reduce((s, f) => { const v = mReviews.filter(r=>r[f.key]); return s + (v.length ? v.reduce((a,r)=>a+r[f.key],0)/v.length : 0); }, 0) / companyFields.length).toFixed(1) : null;
    monthlyTrend.push({ label: monthLabel, avg: mAvg, count: mReviews.length });
  }
  function trendIcon(curr, prev) {
    if (!curr || !prev || curr === '—' || prev === '—') return '';
    const c = parseFloat(curr), p = parseFloat(prev);
    if (isNaN(c)||isNaN(p)) return '';
    const diff = (c - p).toFixed(1);
    if (c > p) return `<span style="color:#4ade80;font-size:12px;">↑ +${diff}</span>`;
    if (c < p) return `<span style="color:#ff6b7a;font-size:12px;">↓ ${diff}</span>`;
    return `<span style="color:#a0b4cc;font-size:12px;">→ 0</span>`;
  }

  // Employee of the Month
  const eotm = getEmployeeOfTheMonth();

  // Top 3 employees this month (for HR)
  const top3 = (() => {
    const supRatingsMonth = db.prepare("SELECT * FROM fb_reviews WHERE reviewer_role='supervisor' AND target_type='employee' AND target_id IS NOT NULL AND created_at>=?").all(thisMonthStart);
    if (supRatingsMonth.length === 0) return [];
    const scores = {};
    for (const r of supRatingsMonth) {
      if (!scores[r.target_id]) scores[r.target_id] = {total:0, count:0};
      const avg = ((r.emp_performance||0)+(r.emp_punctuality||0)+(r.emp_attitude||0)+(r.emp_initiative||0))/4;
      scores[r.target_id].total += avg; scores[r.target_id].count++;
    }
    return Object.entries(scores).map(([id, data]) => {
      const emp = getUserById.get(id);
      return emp ? {name:emp.full_name, department:emp.department, avg:(data.total/data.count).toFixed(1), ratings:data.count} : null;
    }).filter(Boolean).sort((a,b) => parseFloat(b.avg)-parseFloat(a.avg)).slice(0,3);
  })();

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
  <script>(function(){if(!sessionStorage.getItem('wfd_admin_session')){window.location.href='/admin/logout';return;}})();</script>
  <div class="container" style="max-width:1100px;">
    <h1 class="page-title" data-en="📊 HR Analytics" data-ar="📊 التحليلات">📊 HR Analytics</h1>

    <!-- Action Bar -->
    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;align-items:center;">
      <div style="flex:1;min-width:200px;">
        <label style="font-size:12px;color:#a0b4cc;display:block;margin-bottom:4px;" data-en="Filter by Department" data-ar="تصفية حسب القسم">Filter by Department</label>
        <select id="deptFilter" onchange="filterByDept()" style="width:100%;padding:10px;font-size:14px;color:#fff;background:#0f2035;border:1.5px solid rgba(77,166,255,0.2);border-radius:8px;font-family:inherit;">
          <option value="" data-en="All Departments" data-ar="جميع الأقسام">All Departments</option>
          ${departments.map(d => `<option value="${escapeHtml(d)}" ${filterDept===d?'selected':''}>${escapeHtml(d)}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
        <button class="btn" onclick="exportCSV()" style="padding:10px 18px;font-size:13px;" data-en="📥 Export CSV" data-ar="📥 تصدير CSV">📥 Export CSV</button>
        <button class="btn" onclick="exportReport()" style="padding:10px 18px;font-size:13px;background:linear-gradient(135deg,#6f42c1,#b08aef);" data-en="📄 Export Report" data-ar="📄 تصدير تقرير">📄 Export Report</button>
        <button class="btn" onclick="sendReminder()" style="padding:10px 18px;font-size:13px;background:linear-gradient(135deg,#ffc107,#e6a800);" data-en="📧 Send Monthly Reminder" data-ar="📧 إرسال تذكير شهري">📧 Send Monthly Reminder</button>
      </div>
    </div>

    <!-- Quick Insights -->
    ${insights.length ? `<div style="margin-bottom:20px;display:flex;flex-direction:column;gap:8px;">
      ${insights.map(ins => `<div style="background:${ins.type==='warn'?'rgba(255,193,7,0.1)':ins.type==='good'?'rgba(40,167,69,0.1)':'rgba(77,166,255,0.1)'};border:1px solid ${ins.type==='warn'?'rgba(255,193,7,0.3)':ins.type==='good'?'rgba(40,167,69,0.3)':'rgba(77,166,255,0.3)'};border-radius:10px;padding:12px 16px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:18px;">${ins.type==='warn'?'&#9888;&#65039;':ins.type==='good'?'&#9989;':'&#8505;&#65039;'}</span>
        <span style="font-size:14px;font-weight:600;color:${ins.type==='warn'?'#ffc107':ins.type==='good'?'#4ade80':'#4da6ff'};" data-en="${ins.en}" data-ar="${ins.ar}">${ins.en}</span>
      </div>`).join('')}
    </div>` : ''}

    <!-- Stats Cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin-bottom:24px;">
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #4da6ff;">
        <p style="font-size:28px;font-weight:700;color:#4da6ff;">${companyReviews.length}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="🏢 Company Ratings" data-ar="🏢 تقييمات الشركة">🏢 Company Ratings</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #b08aef;">
        <p style="font-size:28px;font-weight:700;color:#b08aef;">${personSupReviews.length}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="👤 Supervisor Ratings" data-ar="👤 تقييمات المشرفين">👤 Supervisor Ratings</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #6f42c1;">
        <p style="font-size:28px;font-weight:700;color:#b08aef;">${supReviews.length}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="👔 Employee Ratings" data-ar="👔 تقييمات الموظفين">👔 Employee Ratings</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #ffc107;">
        <p style="font-size:28px;font-weight:700;color:#ffc107;">${companyAvg}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="Company Avg" data-ar="معدل الشركة">Company Avg</p>
      </div>
      <div style="background:#132a45;border:1px solid rgba(77,166,255,0.2);border-radius:12px;padding:20px;text-align:center;border-left:4px solid #28a745;">
        <p style="font-size:28px;font-weight:700;color:#4ade80;">${allEmps.length}</p>
        <p style="font-size:12px;color:#a0b4cc;" data-en="Total Staff" data-ar="إجمالي الموظفين">Total Staff</p>
      </div>
    </div>

    <!-- Employee of the Month -->
    ${eotm ? `<div style="background:linear-gradient(135deg,rgba(255,193,7,0.12),rgba(255,215,0,0.06));border:2px solid rgba(255,193,7,0.3);border-radius:16px;padding:24px;margin-bottom:24px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:-15px;right:-15px;font-size:80px;opacity:0.08;">🏆</div>
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
        <div style="text-align:center;flex-shrink:0;">
          <div style="width:70px;height:70px;border-radius:50%;background:linear-gradient(135deg,#ffc107,#e6a800);display:flex;align-items:center;justify-content:center;font-size:32px;color:#fff;font-weight:700;box-shadow:0 4px 15px rgba(255,193,7,0.4);margin:0 auto;">${escapeHtml(eotm.name.charAt(0).toUpperCase())}</div>
          <p style="font-size:28px;margin-top:4px;">🏆</p>
        </div>
        <div style="flex:1;">
          <p style="font-size:11px;color:#ffc107;font-weight:700;text-transform:uppercase;letter-spacing:2px;" data-en="Employee of the Month — ${escapeHtml(eotm.month)}" data-ar="موظف الشهر — ${escapeHtml(eotm.month)}">Employee of the Month — ${escapeHtml(eotm.month)}</p>
          <h3 style="font-size:24px;font-weight:800;color:#ffc107;margin-top:4px;">${escapeHtml(eotm.name)}</h3>
          <p style="font-size:14px;color:#a0b4cc;margin-top:4px;">${escapeHtml(eotm.department)} · <span style="color:#ffc107;font-weight:700;">${eotm.avg}/5 ★</span> · ${eotm.ratings} supervisor rating(s)</p>
        </div>
      </div>
      ${top3.length >= 2 ? `<div style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,193,7,0.2);">
        <p style="font-size:12px;color:#a0b4cc;margin-bottom:10px;font-weight:600;" data-en="Top Performers This Month:" data-ar="أفضل الأداء هذا الشهر:">Top Performers This Month:</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          ${top3.map((t,i) => `<div style="flex:1;min-width:140px;background:rgba(255,193,7,${i===0?'0.1':'0.04'});border:1px solid rgba(255,193,7,${i===0?'0.3':'0.15'});border-radius:10px;padding:12px;text-align:center;">
            <span style="font-size:18px;">${i===0?'🥇':i===1?'🥈':'🥉'}</span>
            <p style="font-size:14px;font-weight:700;color:${i===0?'#ffc107':'#a0b4cc'};margin-top:4px;">${escapeHtml(t.name)}</p>
            <p style="font-size:11px;color:#4a6a8a;">${escapeHtml(t.department)}</p>
            <p style="font-size:16px;font-weight:700;color:#ffc107;margin-top:4px;">${t.avg}/5 ★</p>
          </div>`).join('')}
        </div>
      </div>` : ''}
    </div>` : ''}

    <!-- Response Rate Tracker -->
    <div class="card" style="border-left:4px solid #4ade80;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">📊</span>
        <span data-en="Response Rate — This Month" data-ar="معدل الاستجابة — هذا الشهر">Response Rate — This Month</span>
      </h2>
      <div style="text-align:center;margin-bottom:20px;">
        <p style="font-size:48px;font-weight:800;color:${overallResponsePct>=70?'#4ade80':overallResponsePct>=40?'#ffc107':'#ff6b7a'};">${overallResponsePct}%</p>
        <p style="font-size:14px;color:#a0b4cc;" data-en="${totalResponded} of ${totalStaff} employees submitted feedback" data-ar="${totalResponded} من ${totalStaff} موظف أرسلوا تقييماتهم">${totalResponded} of ${totalStaff} employees submitted feedback</p>
      </div>
      ${responseRateByDept.length > 0 ? `<div style="display:flex;flex-direction:column;gap:10px;">
        ${responseRateByDept.map(d => `<div>
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:13px;color:#a0b4cc;">${escapeHtml(d.dept)}</span><span style="font-size:13px;font-weight:700;color:${d.pct>=70?'#4ade80':d.pct>=40?'#ffc107':'#ff6b7a'};">${d.responded}/${d.total} (${d.pct}%)</span></div>
          <div style="height:10px;background:#0f2035;border-radius:5px;overflow:hidden;"><div style="height:100%;width:${d.pct}%;background:${d.pct>=70?'#4ade80':d.pct>=40?'#ffc107':'#ff6b7a'};border-radius:5px;transition:width .5s;"></div></div>
        </div>`).join('')}
      </div>` : '<p style="color:#4a6a8a;text-align:center;">No departments found.</p>'}
    </div>

    <!-- Department Comparison Chart -->
    ${deptComparison.length >= 2 ? `<div class="card" style="border-left:4px solid #ffc107;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">📈</span>
        <span data-en="Department Comparison" data-ar="مقارنة الأقسام">Department Comparison</span>
      </h2>
      <p style="font-size:12px;color:#a0b4cc;margin-bottom:16px;" data-en="Average company rating by department" data-ar="متوسط تقييم الشركة حسب القسم">Average company rating by department</p>
      <div style="display:flex;flex-direction:column;gap:14px;">
        ${deptComparison.sort((a,b) => parseFloat(b.avg)-parseFloat(a.avg)).map((d,i) => {
          const pct = Math.round(parseFloat(d.avg)*20);
          const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
          return `<div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;align-items:center;"><span style="font-size:14px;color:#fff;font-weight:600;">${medal} ${escapeHtml(d.dept)}</span><span style="font-size:14px;font-weight:700;color:#ffc107;">${d.avg}/5 ★ <span style="font-size:11px;color:#4a6a8a;">(${d.count} ratings)</span></span></div>
            <div style="height:12px;background:#0f2035;border-radius:6px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,${pct<40?'#dc3545':pct<70?'#ffc107':'#4ade80'},${pct<40?'#ff6b7a':pct<70?'#ffd43b':'#28a745'});border-radius:6px;transition:width .5s;"></div></div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- Monthly Rating Trend (Last 6 Months) -->
    ${monthlyTrend.some(m => m.avg) ? `<div class="card" style="border-left:4px solid #4da6ff;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">📉</span>
        <span data-en="Rating Trend (Last 6 Months)" data-ar="اتجاه التقييمات (آخر 6 أشهر)">Rating Trend (Last 6 Months)</span>
      </h2>
      <p style="font-size:12px;color:#a0b4cc;margin-bottom:16px;" data-en="Average company rating over time" data-ar="متوسط تقييم الشركة عبر الوقت">Average company rating over time</p>
      <div style="display:flex;align-items:flex-end;gap:8px;height:160px;padding:0 10px;">
        ${monthlyTrend.map(m => {
          if (!m.avg) return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;"><span style="font-size:10px;color:#4a6a8a;">—</span><div style="width:100%;height:4px;background:#1a3050;border-radius:4px;margin-top:4px;"></div><span style="font-size:10px;color:#4a6a8a;margin-top:6px;">${m.label}</span></div>`;
          const pct = Math.round(parseFloat(m.avg)*20);
          const barColor = pct<40?'#dc3545':pct<70?'#ffc107':'#4ade80';
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;"><span style="font-size:11px;font-weight:700;color:${barColor};">${m.avg}</span><div style="width:100%;height:${pct}%;background:${barColor};border-radius:4px 4px 0 0;margin-top:4px;min-height:8px;transition:height .5s;"></div><span style="font-size:10px;color:#a0b4cc;margin-top:6px;">${m.label}</span></div>`;
        }).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:12px;padding:0 10px;"><span style="font-size:10px;color:#4a6a8a;">0</span><span style="font-size:10px;color:#4a6a8a;">5.0</span></div>
    </div>` : ''}

    <!-- Section 1: Company Ratings (Anonymous) -->
    <div class="card" style="border-left:4px solid #4da6ff;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">🏢</span>
        <span data-en="Company Ratings (Anonymous)" data-ar="تقييمات الشركة (مجهولة)">Company Ratings (Anonymous)</span>
      </h2>
      <p style="font-size:12px;color:#a0b4cc;margin-bottom:16px;" data-en="General workplace feedback — not targeted at any person" data-ar="تقييم عام عن بيئة العمل — ليس عن شخص محدد">General workplace feedback — not targeted at any person</p>
      ${companyReviews.length === 0 ? '<p style="text-align:center;color:#a0b4cc;padding:20px;" data-en="No company ratings yet." data-ar="لا توجد تقييمات شركة بعد.">No company ratings yet.</p>' : `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px;">
        ${companyFields.map(f => `<div style="background:rgba(77,166,255,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="${f.en}" data-ar="${f.ar}">${f.en}</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(companyReviews,f.key)} ★ ${healthIcon(avg(companyReviews,f.key))}</p><p style="margin-top:4px;">${lastMonthCompany.length ? `${trendIcon(avg(thisMonthCompany,f.key),avg(lastMonthCompany,f.key))} <span style="font-size:10px;color:#4a6a8a;" data-en="vs last month" data-ar="مقارنة بالشهر الماضي">vs last month</span>` : `<span style="font-size:10px;color:#4da6ff;" data-en="🆕 First month" data-ar="🆕 الشهر الأول">🆕 First month</span>`}</p></div>`).join('')}
      </div>
      <h3 style="font-size:14px;color:#a0b4cc;margin-bottom:12px;" data-en="Anonymous Comments:" data-ar="التعليقات المجهولة:">Anonymous Comments:</h3>
      ${companyReviews.filter(r=>r.comment).map(r => `<div style="background:rgba(77,166,255,0.05);border-radius:8px;padding:12px;margin-bottom:8px;"><p style="font-size:13px;color:#e0eaff;">💬 ${escapeHtml(r.comment)}</p><span style="font-size:11px;color:#4a6a8a;">${r.department} · ${fmtDate(r.created_at)}</span></div>`).join('')||'<p style="color:#4a6a8a;font-size:13px;">No comments.</p>'}
      `}
    </div>

    <!-- Section 2: Employee → Supervisor Ratings (Anonymous) -->
    <div class="card" style="border-left:4px solid #b08aef;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">👤</span>
        <span data-en="Employee → Supervisor Ratings (Anonymous)" data-ar="تقييم الموظف → المشرف (مجهول)">Employee → Supervisor Ratings (Anonymous)</span>
      </h2>
      <p style="font-size:12px;color:#a0b4cc;margin-bottom:16px;" data-en="Employees rate specific supervisors — anonymous to HR" data-ar="الموظفون يقيّمون مشرفين محددين — مجهول للموارد البشرية">Employees rate specific supervisors — anonymous to HR</p>
      ${personSupReviews.length === 0 ? '<p style="text-align:center;color:#a0b4cc;padding:20px;" data-en="No supervisor ratings yet." data-ar="لا توجد تقييمات مشرفين بعد.">No supervisor ratings yet.</p>' : `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px;">
        ${supervisorFields.map(f => `<div style="background:rgba(176,138,239,0.08);border-radius:10px;padding:14px;text-align:center;"><p style="font-size:11px;color:#a0b4cc;" data-en="${f.en}" data-ar="${f.ar}">${f.en}</p><p style="font-size:22px;font-weight:700;color:#ffc107;">${avg(personSupReviews,f.key)} ★ ${healthIcon(avg(personSupReviews,f.key))}</p><p style="margin-top:4px;">${lastMonthPerson.length ? `${trendIcon(avg(thisMonthPerson,f.key),avg(lastMonthPerson,f.key))} <span style="font-size:10px;color:#4a6a8a;" data-en="vs last month" data-ar="مقارنة بالشهر الماضي">vs last month</span>` : `<span style="font-size:10px;color:#4da6ff;" data-en="🆕 First month" data-ar="🆕 الشهر الأول">🆕 First month</span>`}</p></div>`).join('')}
      </div>
      <h3 style="font-size:14px;color:#a0b4cc;margin-bottom:12px;" data-en="Anonymous Comments:" data-ar="التعليقات المجهولة:">Anonymous Comments:</h3>
      ${personSupReviews.filter(r=>r.comment).map(r => { const tgt = r.target_id ? getUserById.get(r.target_id) : null; return `<div style="background:rgba(176,138,239,0.05);border-radius:8px;padding:12px;margin-bottom:8px;"><p style="font-size:13px;color:#e0eaff;">💬 ${escapeHtml(r.comment)}</p><span style="font-size:11px;color:#4a6a8a;">${r.department} · ${tgt?escapeHtml(tgt.full_name):''} · ${fmtDate(r.created_at)}</span></div>`; }).join('')||'<p style="color:#4a6a8a;font-size:13px;">No comments.</p>'}
      `}
    </div>

    <!-- Section 3: Supervisor → Employee Ratings -->
    <div class="card" style="border-left:4px solid #6f42c1;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">👔</span>
        <span data-en="Supervisor → Employee Ratings" data-ar="تقييم المشرف → الموظف">Supervisor → Employee Ratings</span>
      </h2>
      ${supReviews.length === 0 ? '<p style="text-align:center;color:#a0b4cc;padding:20px;" data-en="No supervisor ratings yet." data-ar="لا توجد تقييمات بعد.">No supervisor ratings yet.</p>' :
        supReviews.map(r => {
          const emp = getUserById.get(r.target_id);
          return `<div class="emp-card">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div><h3 style="font-size:15px;">${emp?escapeHtml(emp.full_name):'Unknown'}</h3><span class="badge badge-emp">${escapeHtml(r.department)}</span></div>
              <span style="font-size:12px;color:#4a6a8a;">${fmtDate(r.created_at)}</span>
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

    <!-- Section 4: Anonymous Suggestions -->
    <div class="card" style="border-left:4px solid #ffc107;">
      <h2 class="section-title" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:22px;">💡</span>
        <span data-en="Anonymous Suggestions" data-ar="الاقتراحات المجهولة">Anonymous Suggestions</span>
      </h2>
      ${(() => {
        autoConfirmDrafts(); // Auto-confirm any drafts older than 1 hour
        const allSuggestions = filterDept
          ? db.prepare("SELECT * FROM fb_suggestions WHERE department=? AND status!='draft' ORDER BY created_at DESC").all(filterDept)
          : db.prepare("SELECT * FROM fb_suggestions WHERE status!='draft' ORDER BY created_at DESC").all();
        if (allSuggestions.length === 0) return '<p style="text-align:center;color:#a0b4cc;padding:20px;" data-en="No suggestions yet." data-ar="لا توجد اقتراحات بعد.">No suggestions yet.</p>';
        return allSuggestions.slice(0,30).map(s => {
          const statusBadge = s.status==='accepted' ? '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(40,167,69,0.15);color:#4ade80;">✅ Accepted</span>'
            : s.status==='rejected' ? '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(220,53,69,0.15);color:#ff6b7a;">❌ Rejected</span>'
            : '<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(255,193,7,0.15);color:#ffc107;">🟡 Pending</span>';
          const borderColor = s.status==='accepted' ? 'rgba(40,167,69,0.3)' : s.status==='rejected' ? 'rgba(220,53,69,0.2)' : 'rgba(255,193,7,0.15)';
          return `<div style="background:rgba(255,193,7,0.03);border:1px solid ${borderColor};border-radius:10px;padding:14px;margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;">${statusBadge}<span style="font-size:11px;color:#4a6a8a;">${escapeHtml(s.department)} · ${fmtDate(s.created_at)}</span></div>
            <p style="font-size:14px;color:#e0eaff;line-height:1.5;">💡 ${escapeHtml(s.suggestion)}</p>
            ${s.hr_comment ? `<div style="margin-top:10px;padding:10px;background:rgba(77,166,255,0.06);border-radius:8px;border-left:3px solid ${s.status==='accepted'?'#4ade80':'#ff6b7a'};"><p style="font-size:12px;color:#a0b4cc;margin-bottom:4px;font-weight:600;">HR Response:</p><p style="font-size:13px;color:#e0eaff;">${escapeHtml(s.hr_comment)}</p></div>` : ''}
            ${s.status==='pending' ? `<div id="actions_${s.id}" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
              <button onclick="showRespondBox('${s.id}','accepted')" style="padding:6px 16px;background:rgba(40,167,69,0.15);border:1px solid rgba(40,167,69,0.4);border-radius:8px;color:#4ade80;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;">✅ Accept</button>
              <button onclick="showRespondBox('${s.id}','rejected')" style="padding:6px 16px;background:rgba(220,53,69,0.15);border:1px solid rgba(220,53,69,0.4);border-radius:8px;color:#ff6b7a;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;">❌ Reject</button>
            </div>
            <div id="respond_${s.id}" style="display:none;margin-top:12px;padding:14px;background:rgba(77,166,255,0.05);border-radius:10px;">
              <p id="respondLabel_${s.id}" style="font-size:13px;font-weight:600;margin-bottom:8px;"></p>
              <textarea id="respondComment_${s.id}" style="width:100%;padding:10px;font-size:13px;color:#fff;background:#0f2035;border:1.5px solid rgba(77,166,255,0.2);border-radius:8px;font-family:inherit;min-height:70px;box-sizing:border-box;" placeholder="Your comment..."></textarea>
              <div style="margin-top:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#a0b4cc;"><input type="checkbox" id="sendAll_${s.id}" style="accent-color:#4da6ff;"> <span data-en="Send email to ALL departments" data-ar="إرسال بريد لجميع الأقسام">Send email to ALL departments</span></label>
                <button onclick="submitResponse('${s.id}')" class="btn" style="padding:8px 20px;font-size:13px;">Submit</button>
                <button onclick="document.getElementById('respond_${s.id}').style.display='none';document.getElementById('actions_${s.id}').style.display='flex';" style="padding:8px 16px;background:#4a6a8a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit;">Cancel</button>
              </div>
            </div>` : s.status==='rejected' ? `<div style="margin-top:10px;"><button onclick="hrDeleteSuggestion('${s.id}')" style="padding:5px 14px;background:rgba(220,53,69,0.1);border:1px solid rgba(220,53,69,0.3);border-radius:6px;color:#ff6b7a;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;">🗑️ Delete Rejected</button></div>` : ''}
          </div>`;
        }).join('');
      })()}
    </div>
  </div>
  ${footerHTML()}
  <script>
  var currentRespondStatus={};
  function showRespondBox(id,status){
    currentRespondStatus[id]=status;
    document.getElementById('actions_'+id).style.display='none';
    var box=document.getElementById('respond_'+id);box.style.display='block';
    var label=document.getElementById('respondLabel_'+id);
    if(status==='accepted'){label.textContent='✅ Accept — How long will it take to implement?';label.style.color='#4ade80';}
    else{label.textContent='❌ Reject — Why is this suggestion not feasible?';label.style.color='#ff6b7a';}
    document.getElementById('respondComment_'+id).focus();
  }
  async function submitResponse(id){
    var status=currentRespondStatus[id];
    var comment=document.getElementById('respondComment_'+id).value.trim();
    if(!comment){wfdAlert('Please write a comment.','error');return;}
    var sendAll=document.getElementById('sendAll_'+id).checked;
    try{var r=await fetch('/api/admin/respond-suggestion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,status:status,hr_comment:comment,send_all:sendAll})});var d=await r.json();
      if(d.success){wfdAlert('Response submitted!'+(status==='accepted'?' Email sent to department.':''),'success',function(){location.reload();});}
      else{wfdAlert(d.message||'Error.','error');}}
    catch(e){wfdAlert('Network error.','error');}
  }
  function filterByDept(){
    var dept=document.getElementById('deptFilter').value;
    window.location.href='/admin/dashboard'+(dept?'?dept='+encodeURIComponent(dept):'');
  }
  function exportCSV(){
    var dept=document.getElementById('deptFilter').value;
    window.location.href='/api/export/feedback-csv'+(dept?'?dept='+encodeURIComponent(dept):'');
  }
  function exportReport(){
    var dept=document.getElementById('deptFilter').value;
    window.location.href='/api/export/hr-report'+(dept?'?dept='+encodeURIComponent(dept):'');
  }
  async function hrDeleteSuggestion(id){
    var ov=document.createElement('div');ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99998;';
    var t=document.createElement('div');t.style.cssText='position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#132a45;border:1px solid #dc3545;border-radius:12px;padding:14px 24px;display:flex;flex-direction:column;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,0.4);max-width:500px;width:90%;animation:wfdSlideDown .3s;';
    t.innerHTML='<span style="font-size:28px;">🗑️</span><p style="font-size:14px;color:#fff;text-align:center;">Delete this rejected suggestion permanently?</p><div style="display:flex;gap:10px;"><button id="cfmYes" style="padding:8px 20px;background:#dc3545;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Yes, Delete</button><button id="cfmNo" style="padding:8px 20px;background:#4a6a8a;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button></div>';
    document.body.appendChild(ov);document.body.appendChild(t);
    t.querySelector('#cfmNo').onclick=function(){ov.remove();t.remove();};
    t.querySelector('#cfmYes').onclick=async function(){ov.remove();t.remove();
      try{var r=await fetch('/api/admin/delete-suggestion/'+id,{method:'DELETE'});var d=await r.json();
        if(d.success){wfdAlert('Rejected suggestion deleted.','success',function(){location.reload();});}
        else{wfdAlert(d.message,'error');}}
      catch(e){wfdAlert('Network error.','error');}
    };
  }
  async function sendReminder(){
    if(!confirm('Send reminder emails to all employees who have not submitted feedback this month?'))return;
    try{
      var r=await fetch('/api/admin/send-reminder',{method:'POST',headers:{'Content-Type':'application/json'}});
      var d=await r.json();
      if(d.success){wfdAlert(d.message||'Reminders sent!','success');}
      else{wfdAlert(d.message||'Error sending reminders.','error');}
    }catch(e){wfdAlert('Network error.','error');}
  }
  </script>
  </body></html>`);
});

// ── MANAGE USERS ────────────────────────────────────────────
app.get('/admin/manage', requireAdmin, (req, res) => {
  const allUsers = db.prepare('SELECT * FROM fb_users WHERE is_admin=0 ORDER BY department,role,full_name').all();
  const departments = db.prepare('SELECT name FROM fb_departments ORDER BY name').all().map(d => d.name);
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
  <script>(function(){if(!sessionStorage.getItem('wfd_admin_session')){window.location.href='/admin/logout';return;}})();</script>
  <div class="container" style="max-width:900px;">
    <h1 class="page-title" data-en="👥 Manage Users" data-ar="👥 إدارة المستخدمين">👥 Manage Users</h1>

    <!-- Add User Form -->
    <div class="card">
      <h2 class="section-title" data-en="➕ Add New Employee / Supervisor" data-ar="➕ إضافة موظف / مشرف جديد">➕ Add New Employee / Supervisor</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group"><label data-en="Full Name" data-ar="الاسم الكامل">Full Name</label><input type="text" id="aName"></div>
        <div class="form-group"><label data-en="Email" data-ar="البريد">Email</label><input type="email" id="aEmailAdd"></div>
        <div class="form-group"><label data-en="Password" data-ar="كلمة المرور">Password</label><input type="text" id="aPassAdd" placeholder="e.g. Employee123$"></div>
        <div class="form-group"><label data-en="Department" data-ar="القسم">Department</label>
          <select id="aDept">
            ${departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label data-en="Role" data-ar="الدور">Role</label>
          <select id="aRole"><option value="employee">Employee</option><option value="supervisor">Supervisor</option></select>
        </div>
      </div>
      <button class="btn" onclick="addUser()" data-en="Add User" data-ar="إضافة مستخدم">Add User</button>
      <div id="addMsg" style="display:none;margin-top:10px;padding:10px;border-radius:8px;font-size:13px;"></div>
    </div>

    <!-- Manage Departments -->
    <div class="card">
      <h2 class="section-title" data-en="🏢 Manage Departments" data-ar="🏢 إدارة الأقسام">🏢 Manage Departments</h2>
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <input type="text" id="newDept" placeholder="New department name..." style="flex:1;min-width:200px;padding:10px;font-size:14px;color:#fff;background:#0f2035;border:1.5px solid rgba(77,166,255,0.2);border-radius:8px;font-family:inherit;">
        <button class="btn" onclick="addDept()" style="padding:10px 20px;font-size:13px;" data-en="➕ Add" data-ar="➕ إضافة">➕ Add</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${departments.map(d => `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(77,166,255,0.08);border:1px solid rgba(77,166,255,0.2);border-radius:20px;padding:6px 14px;">
          <span style="font-size:13px;color:#fff;">${escapeHtml(d)}</span>
          <button onclick="removeDept('${escapeHtml(d).replace(/'/g,"\\'")}')" style="background:none;border:none;color:#ff6b7a;cursor:pointer;font-size:14px;padding:0 2px;" title="Remove">✕</button>
        </div>`).join('')}
        ${departments.length===0?'<p style="color:#a0b4cc;font-size:13px;" data-en="No departments yet. Add one above." data-ar="لا توجد أقسام. أضف واحداً أعلاه.">No departments yet. Add one above.</p>':''}
      </div>
    </div>

    <!-- User List -->
    <div class="card">
      <h2 class="section-title" data-en="👥 All Users (${allUsers.length})" data-ar="👥 جميع المستخدمين (${allUsers.length})">👥 All Users (${allUsers.length})</h2>
      <div style="margin-bottom:16px;"><input type="text" id="userSearch" oninput="filterUsers()" placeholder="🔍 Search by name or email..." style="width:100%;padding:10px 14px;font-size:14px;color:#fff;background:#0f2035;border:1.5px solid rgba(77,166,255,0.2);border-radius:8px;font-family:inherit;"></div>
      ${allUsers.length===0?'<p style="text-align:center;color:#a0b4cc;">No users yet. Add employees above.</p>':
        allUsers.map(u => `<div class="emp-card user-row" data-name="${escapeHtml(u.full_name.toLowerCase())}" data-email="${escapeHtml(u.email.toLowerCase())}" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <h3 style="font-size:15px;">${escapeHtml(u.full_name)}</h3>
            <span style="font-size:12px;color:#a0b4cc;">${escapeHtml(u.email)}</span>
            <div style="margin-top:4px;display:flex;align-items:center;gap:6px;">
              <span style="font-size:11px;color:#4a6a8a;">🔑</span>
              <span id="pw_${u.id}" style="font-size:12px;color:#4a6a8a;letter-spacing:2px;">••••••</span>
              <button onclick="togglePwEye('${u.id}',this,'${escapeHtml(u.plain_password||'N/A').replace(/'/g,"\\'")}')" style="background:none;border:none;color:#4da6ff;cursor:pointer;padding:0;display:inline-flex;align-items:center;vertical-align:middle;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></button>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="badge ${u.role==='supervisor'?'badge-sup':'badge-emp'}">${u.role}</span>
            <span class="badge" style="background:rgba(255,255,255,0.05);color:#a0b4cc;">${escapeHtml(u.department)}</span>
            <button onclick="editName('${u.id}','${escapeHtml(u.full_name)}')" style="padding:4px 10px;background:rgba(255,193,7,0.15);color:#ffc107;border:1px solid rgba(255,193,7,0.3);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;" data-en="✏️ Name" data-ar="✏️ الاسم">✏️ Name</button>
            <button onclick="editDept('${u.id}','${escapeHtml(u.full_name)}','${escapeHtml(u.department)}')" style="padding:4px 10px;background:rgba(40,167,69,0.15);color:#4ade80;border:1px solid rgba(40,167,69,0.3);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;" data-en="✏️ Dept" data-ar="✏️ القسم">✏️ Dept</button>
            <button onclick="resetPass('${u.id}','${escapeHtml(u.full_name)}')" style="padding:4px 10px;background:rgba(77,166,255,0.15);color:#4da6ff;border:1px solid rgba(77,166,255,0.3);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;" data-en="🔑 Reset" data-ar="🔑 تغيير">🔑 Reset</button>
            <button onclick="deleteUser('${u.id}','${escapeHtml(u.full_name)}')" style="padding:4px 10px;background:rgba(220,53,69,0.15);color:#ff6b7a;border:1px solid rgba(220,53,69,0.3);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;">🗑️</button>
          </div>
        </div>`).join('')}
    </div>
  </div>
  ${footerHTML()}
  <script>
  function filterUsers(){var q=document.getElementById('userSearch').value.toLowerCase();document.querySelectorAll('.user-row').forEach(function(el){var n=el.getAttribute('data-name')||'';var e=el.getAttribute('data-email')||'';el.style.display=(n.includes(q)||e.includes(q))?'flex':'none';});}
  async function addUser(confirmDup){var n=document.getElementById('aName').value.trim(),e=document.getElementById('aEmailAdd').value.trim(),p=document.getElementById('aPassAdd').value,d=document.getElementById('aDept').value,r=document.getElementById('aRole').value;
    if(!n||!e||!p){wfdAlert('All fields required.','error');return;}
    try{var res=await fetch('/api/admin/add-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,email:e,password:p,department:d,role:r,confirmDuplicate:confirmDup||false})});var data=await res.json();
      if(data.success){wfdAlert('User added!','success',function(){location.reload();});}
      else if(data.duplicate){if(confirm(data.message+'\\n\\nAdd anyway?')){addUser(true);};}
      else{wfdAlert(data.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}
  }
  async function deleteUser(id,name){if(!confirm('Delete user "'+name+'"? This cannot be undone.'))return;
    try{var r=await fetch('/api/admin/delete-user/'+id,{method:'DELETE'});var d=await r.json();
      if(d.success){wfdAlert('User deleted.','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}
  }
  async function editName(id,currentName,confirmDup){
    if(!confirmDup){var nn=prompt('Enter new name for "'+currentName+'":',currentName);if(!nn||!nn.trim())return;if(nn.trim()===currentName){wfdAlert('Same name.','error');return;}window._editNameVal=nn.trim();}
    var nameVal=window._editNameVal;
    try{var r=await fetch('/api/admin/change-name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:id,newName:nameVal,confirmDuplicate:confirmDup||false})});var d=await r.json();
      if(d.success){wfdAlert('Name changed!','success',function(){location.reload();});}
      else if(d.duplicate){if(confirm(d.message+'\\n\\nChange anyway?')){editName(id,currentName,true);};}
      else{wfdAlert(d.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}
  }
  async function editDept(id,name,currentDept){
    var depts=${JSON.stringify(departments)};
    var opts=depts.map(function(d,i){return (i+1)+'. '+d;}).join('\\n');
    var pick=prompt('Change department for "'+name+'"\\nCurrent: '+currentDept+'\\n\\nType the number:\\n'+opts);
    if(!pick)return;
    var idx=parseInt(pick)-1;
    if(isNaN(idx)||idx<0||idx>=depts.length){wfdAlert('Invalid selection.','error');return;}
    var newDept=depts[idx];
    if(newDept===currentDept){wfdAlert('Same department selected.','error');return;}
    try{var r=await fetch('/api/admin/change-department',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:id,department:newDept})});var d=await r.json();
      if(d.success){wfdAlert('Department changed to '+newDept+'!','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}
  }
  async function resetPass(id,name){var np=prompt('Enter new password for "'+name+'":');
    if(!np||np.length<6){if(np!==null)wfdAlert('Password must be at least 6 characters.','error');return;}
    try{var r=await fetch('/api/admin/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:id,newPassword:np})});var d=await r.json();
      if(d.success){wfdAlert('Password reset! New password: '+np,'success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}
  }
  async function addDept(){var n=document.getElementById('newDept').value.trim();
    if(!n){wfdAlert('Please enter a department name.','error');return;}
    try{var r=await fetch('/api/admin/add-department',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});var d=await r.json();
      if(d.success){wfdAlert('Department added!','success',function(){location.reload();});}
      else{wfdAlert(d.message,'error');}}
    catch(x){wfdAlert('Network error.','error');}
  }
  async function removeDept(name){if(!confirm('Remove department "'+name+'"? Existing users in this department will NOT be affected.'))return;
    try{var r=await fetch('/api/admin/delete-department/'+encodeURIComponent(name),{method:'DELETE'});var d=await r.json();
      if(d.success){wfdAlert('Department removed.','success',function(){location.reload();});}
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
    const nameExists = db.prepare('SELECT id FROM fb_users WHERE LOWER(full_name)=LOWER(?) AND is_admin=0').get(name.trim());
    if (nameExists && !req.body.confirmDuplicate) return res.status(409).json({success:false,message:'Another user named "'+name.trim()+'" already exists. Consider adding a last name to avoid confusion.',duplicate:true});
    const id = uuidv4(), hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO fb_users (id,full_name,email,password_hash,department,role,is_admin,plain_password) VALUES (?,?,?,?,?,?,0,?)')
      .run(id, name.trim(), email.toLowerCase(), hash, department, role||'employee', password);
    cloudInsert('fb_users', {id, full_name:name.trim(), email:email.toLowerCase(), password_hash:hash, department, role:role||'employee', is_admin:0, plain_password:password, created_at:new Date().toISOString()});
    res.json({success:true});
    // Send welcome email with login credentials
    try {
      const welcomeHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#fff;padding:30px;border-radius:12px;">
        <h2 style="color:#4da6ff;">Welcome to Watan First Digital!</h2>
        <p style="color:#a0b4cc;">Hello <strong>${name.trim()}</strong>,</p>
        <p style="color:#a0b4cc;">Your account has been created on the Employee Feedback System. Here are your login details:</p>
        <div style="background:rgba(77,166,255,0.1);border-radius:8px;padding:16px;margin:16px 0;">
          <p style="color:#fff;margin-bottom:8px;">📧 <strong>Email:</strong> ${email.toLowerCase()}</p>
          <p style="color:#fff;margin-bottom:8px;">🔑 <strong>Password:</strong> ${password}</p>
          <p style="color:#fff;">🏢 <strong>Department:</strong> ${department}</p>
        </div>
        <p style="color:#a0b4cc;">Please change your password after your first login for security.</p>
        <p style="font-size:12px;color:#4a6a8a;margin-top:16px;">This is an automated message from Watan First Digital Feedback System.</p>
      </div>`;
      sendBrevoEmail(email.toLowerCase(), 'Welcome to Watan First Digital — Your Login Details', welcomeHtml);
    } catch(emailErr) { console.error('[EMAIL] Welcome email error:', emailErr.message); }
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

// Reset password API (HR sets new password for any user)
app.post('/api/admin/reset-password', requireAdmin, (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId||!newPassword) return res.status(400).json({success:false,message:'User ID and new password required.'});
    if (newPassword.length < 6) return res.status(400).json({success:false,message:'Password must be at least 6 characters.'});
    const user = getUserById.get(userId);
    if (!user||user.is_admin) return res.status(400).json({success:false,message:'User not found.'});
    const newHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE fb_users SET password_hash=?, plain_password=? WHERE id=?').run(newHash, newPassword, userId);
    cloudUpdate('fb_users', userId, {password_hash: newHash, plain_password: newPassword});
    console.log(`[ADMIN] Password reset for user ${userId}`);
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

// Change name API
app.post('/api/admin/change-name', requireAdmin, (req, res) => {
  try {
    const { userId, newName } = req.body;
    if (!userId||!newName||!newName.trim()) return res.status(400).json({success:false,message:'User ID and name required.'});
    const user = getUserById.get(userId);
    if (!user||user.is_admin) return res.status(400).json({success:false,message:'User not found.'});
    const nameExists = db.prepare('SELECT id FROM fb_users WHERE LOWER(full_name)=LOWER(?) AND id!=? AND is_admin=0').get(newName.trim(), userId);
    if (nameExists && !req.body.confirmDuplicate) return res.status(409).json({success:false,message:'Another user named "'+newName.trim()+'" already exists. Consider adding a last name to avoid confusion.',duplicate:true});
    db.prepare('UPDATE fb_users SET full_name=? WHERE id=?').run(newName.trim(), userId);
    cloudUpdate('fb_users', userId, {full_name: newName.trim()});
    console.log(`[ADMIN] Name changed for ${userId}: ${user.full_name} → ${newName.trim()}`);
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

// Change department API
app.post('/api/admin/change-department', requireAdmin, (req, res) => {
  try {
    const { userId, department } = req.body;
    if (!userId||!department) return res.status(400).json({success:false,message:'User ID and department required.'});
    const user = getUserById.get(userId);
    if (!user||user.is_admin) return res.status(400).json({success:false,message:'User not found.'});
    db.prepare('UPDATE fb_users SET department=? WHERE id=?').run(department, userId);
    cloudUpdate('fb_users', userId, {department});
    console.log(`[ADMIN] Department changed for ${userId}: ${user.department} → ${department}`);
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

// ── DEPARTMENT MANAGEMENT ──────────────────────────────────
app.post('/api/admin/add-department', requireAdmin, (req, res) => {
  try {
    const { name } = req.body;
    if (!name||!name.trim()) return res.status(400).json({success:false,message:'Department name required.'});
    const deptName = name.trim();
    const existing = db.prepare('SELECT name FROM fb_departments WHERE name=?').get(deptName);
    if (existing) return res.status(400).json({success:false,message:'Department already exists.'});
    db.prepare('INSERT INTO fb_departments (name,created_at) VALUES (?,?)').run(deptName, new Date().toISOString());
    // Try cloud sync (table may not exist yet)
    try { supabase.from('fb_departments').upsert({name:deptName, created_at:new Date().toISOString()},{onConflict:'name'}).then(()=>{}); } catch(e) {}
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

app.delete('/api/admin/delete-department/:name', requireAdmin, (req, res) => {
  try {
    const deptName = decodeURIComponent(req.params.name);
    db.prepare('DELETE FROM fb_departments WHERE name=?').run(deptName);
    try { supabase.from('fb_departments').delete().eq('name', deptName).then(()=>{}); } catch(e) {}
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:'Server error.'}); }
});

// ── EXPORT CSV ─────────────────────────────────────────────
app.get('/api/export/feedback-csv', requireAdmin, (req, res) => {
  try {
    const filterDept = req.query.dept || '';
    let reviews = db.prepare('SELECT * FROM fb_reviews ORDER BY created_at DESC').all();
    if (filterDept) reviews = reviews.filter(r => r.department === filterDept);

    const headers = ['Date','Department','Reviewer Role','Target Type','Job Satisfaction','Salary Benefits','Growth Training','Sup Communication','Sup Support','Sup Fairness','Team Teamwork','Team Respect','Emp Performance','Emp Punctuality','Emp Attitude','Emp Initiative','Comment','Sup Comment'];
    const csvRows = [headers.join(',')];
    for (const r of reviews) {
      const row = [
        r.created_at, r.department, r.reviewer_role, r.target_type,
        r.job_satisfaction||'', r.salary_benefits||'', r.growth_training||'',
        r.sup_communication||'', r.sup_support||'', r.sup_fairness||'',
        r.team_teamwork||'', r.team_respect||'',
        r.emp_performance||'', r.emp_punctuality||'', r.emp_attitude||'', r.emp_initiative||'',
        `"${(r.comment||'').replace(/"/g,'""')}"`, `"${(r.sup_comment||'').replace(/"/g,'""')}"`
      ];
      csvRows.push(row.join(','));
    }
    const csv = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="feedback_export_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(e) { console.error('[ERROR] CSV export:', e); res.status(500).json({success:false,message:'Export failed.'}); }
});

// ── EXPORT HR REPORT (Printable HTML) ──────────────────────
app.get('/api/export/hr-report', requireAdmin, (req, res) => {
  try {
    const filterDept = req.query.dept || '';
    const now = new Date();
    const reportDate = now.toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const allReviews = db.prepare('SELECT * FROM fb_reviews ORDER BY created_at DESC').all();
    const filteredReviews = filterDept ? allReviews.filter(r => r.department === filterDept) : allReviews;
    const companyReviews = filteredReviews.filter(r => r.target_type === 'company');
    const personSupReviews = filteredReviews.filter(r => r.reviewer_role === 'employee' && r.target_type === 'supervisor');
    const supReviews = filteredReviews.filter(r => r.reviewer_role === 'supervisor');
    const allEmps = db.prepare('SELECT * FROM fb_users WHERE is_admin=0').all();
    const departments = [...new Set(allEmps.map(u => u.department))];
    const thisMonthReviews = filteredReviews.filter(r => r.created_at >= monthStart);
    const totalResponded = new Set(thisMonthReviews.map(r => r.reviewer_id)).size;
    const responsePct = allEmps.length ? Math.round(totalResponded/allEmps.length*100) : 0;

    function avg(arr, field) { const v=arr.filter(r=>r[field]); return v.length?(v.reduce((s,r)=>s+r[field],0)/v.length).toFixed(1):'—'; }

    const companyFields = [{k:'job_satisfaction',l:'Job Satisfaction'},{k:'salary_benefits',l:'Salary & Benefits'},{k:'growth_training',l:'Growth & Training'},{k:'team_teamwork',l:'Teamwork'},{k:'team_respect',l:'Respect'}];
    const supFields = [{k:'sup_communication',l:'Communication'},{k:'sup_support',l:'Support'},{k:'sup_fairness',l:'Fairness'}];

    const companyAvg = companyReviews.length ? (companyFields.reduce((s,f)=>{const v=companyReviews.filter(r=>r[f.k]);return s+(v.length?v.reduce((a,r)=>a+r[f.k],0)/v.length:0);},0)/companyFields.length).toFixed(1) : '—';
    const personAvg = personSupReviews.length ? (supFields.reduce((s,f)=>{const v=personSupReviews.filter(r=>r[f.k]);return s+(v.length?v.reduce((a,r)=>a+r[f.k],0)/v.length:0);},0)/supFields.length).toFixed(1) : '—';

    // Department breakdown
    const deptRows = departments.map(dept => {
      const dc = companyReviews.filter(r => r.department === dept);
      const dAvg = dc.length ? (companyFields.reduce((s,f)=>{const v=dc.filter(r=>r[f.k]);return s+(v.length?v.reduce((a,r)=>a+r[f.k],0)/v.length:0);},0)/companyFields.length).toFixed(1) : '—';
      const dEmps = allEmps.filter(u => u.department === dept).length;
      const dResp = new Set(thisMonthReviews.filter(r => r.department === dept).map(r => r.reviewer_id)).size;
      return `<tr><td>${escapeHtml(dept)}</td><td>${dEmps}</td><td>${dAvg}</td><td>${dEmps?Math.round(dResp/dEmps*100):0}%</td></tr>`;
    }).join('');

    // Recent anonymous comments
    const recentComments = filteredReviews.filter(r => r.comment).slice(0,10).map(r =>
      `<tr><td>${new Date(r.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</td><td>${escapeHtml(r.department)}</td><td>${r.target_type}</td><td>${escapeHtml(r.comment)}</td></tr>`
    ).join('');

    // Employee of the Month
    const eotm = getEmployeeOfTheMonth();

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>HR Feedback Report — ${reportDate}</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;color:#222;padding:40px;max-width:900px;margin:0 auto;font-size:14px;}
      h1{font-size:24px;color:#1a3a6b;border-bottom:3px solid #1a3a6b;padding-bottom:8px;margin-bottom:4px;}
      h2{font-size:18px;color:#1a3a6b;margin:24px 0 10px;border-bottom:1px solid #ddd;padding-bottom:4px;}
      .meta{font-size:12px;color:#666;margin-bottom:24px;}
      .stats{display:flex;gap:16px;margin:16px 0;flex-wrap:wrap;}
      .stat{flex:1;min-width:120px;border:1px solid #ddd;border-radius:8px;padding:14px;text-align:center;}
      .stat .num{font-size:28px;font-weight:700;color:#1a3a6b;}.stat .lbl{font-size:11px;color:#666;margin-top:4px;}
      table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px;}
      th{background:#1a3a6b;color:#fff;padding:8px 10px;text-align:left;font-size:12px;}
      td{padding:8px 10px;border-bottom:1px solid #eee;}
      tr:nth-child(even){background:#f8f9fa;}
      .eotm{background:#fff8e1;border:1px solid #ffc107;border-radius:8px;padding:14px;margin:10px 0;text-align:center;}
      .eotm .name{font-size:18px;font-weight:700;color:#e6a800;}
      .footer{margin-top:30px;padding-top:10px;border-top:1px solid #ddd;font-size:11px;color:#999;text-align:center;}
      @media print{body{padding:20px;}.no-print{display:none;}}
    </style></head><body>
    <button class="no-print" onclick="window.print()" style="float:right;padding:10px 20px;background:#1a3a6b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">🖨️ Print / Save PDF</button>
    <h1>HR Feedback Report</h1>
    <p class="meta">Generated: ${reportDate} ${filterDept ? '| Department: '+escapeHtml(filterDept) : '| All Departments'} | Watan First Digital</p>

    <h2>Overview</h2>
    <div class="stats">
      <div class="stat"><div class="num">${companyReviews.length}</div><div class="lbl">Company Ratings</div></div>
      <div class="stat"><div class="num">${personSupReviews.length}</div><div class="lbl">Supervisor Ratings</div></div>
      <div class="stat"><div class="num">${supReviews.length}</div><div class="lbl">Employee Ratings</div></div>
      <div class="stat"><div class="num">${allEmps.length}</div><div class="lbl">Total Staff</div></div>
      <div class="stat"><div class="num">${responsePct}%</div><div class="lbl">Response Rate</div></div>
    </div>

    <h2>Average Ratings</h2>
    <div class="stats">
      <div class="stat"><div class="num">${companyAvg}</div><div class="lbl">Company Avg (out of 5)</div></div>
      <div class="stat"><div class="num">${personAvg}</div><div class="lbl">Supervisor Avg (out of 5)</div></div>
    </div>
    <table><thead><tr><th>Category</th><th>Average</th></tr></thead><tbody>
      ${companyFields.map(f => `<tr><td>🏢 ${f.l}</td><td>${avg(companyReviews,f.k)}</td></tr>`).join('')}
      ${supFields.map(f => `<tr><td>👤 ${f.l}</td><td>${avg(personSupReviews,f.k)}</td></tr>`).join('')}
    </tbody></table>

    ${eotm ? `<h2>Employee of the Month — ${escapeHtml(eotm.month)}</h2>
    <div class="eotm">🏆 <span class="name">${escapeHtml(eotm.name)}</span> — ${escapeHtml(eotm.department)} — ${eotm.avg}/5 ★ (${eotm.ratings} rating(s))</div>` : ''}

    <h2>Department Breakdown</h2>
    <table><thead><tr><th>Department</th><th>Staff</th><th>Avg Rating</th><th>Response Rate</th></tr></thead><tbody>${deptRows || '<tr><td colspan="4">No data</td></tr>'}</tbody></table>

    ${recentComments ? `<h2>Recent Anonymous Comments</h2>
    <table><thead><tr><th>Date</th><th>Dept</th><th>Type</th><th>Comment</th></tr></thead><tbody>${recentComments}</tbody></table>` : ''}

    <div class="footer">Watan First Digital — Employee Feedback System — Confidential HR Report</div>
    </body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) { console.error('[ERROR] HR Report export:', e); res.status(500).json({success:false,message:'Report export failed.'}); }
});

// ── SEND MONTHLY REMINDER ──────────────────────────────────
app.post('/api/admin/send-reminder', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const allEmps = db.prepare("SELECT * FROM fb_users WHERE is_admin=0").all();
    const submittedIds = db.prepare("SELECT DISTINCT reviewer_id FROM fb_reviews WHERE created_at>=?").all(monthStart).map(r => r.reviewer_id);
    const pending = allEmps.filter(u => !submittedIds.includes(u.id));

    if (pending.length === 0) {
      return res.json({success:true, message:'All employees have already submitted feedback this month! No reminders needed.'});
    }

    let sentCount = 0;
    const monthName = now.toLocaleString('en-US', {month:'long', year:'numeric'});
    for (const emp of pending) {
      const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#fff;padding:30px;border-radius:12px;">
        <h2 style="color:#4da6ff;">Monthly Feedback Reminder</h2>
        <p style="color:#a0b4cc;">Hello <strong>${emp.full_name}</strong>,</p>
        <p style="color:#a0b4cc;">This is a friendly reminder that you have not yet submitted your anonymous feedback for <strong>${monthName}</strong>.</p>
        <p style="color:#a0b4cc;">Your honest feedback helps improve the workplace for everyone. It only takes 2 minutes and is completely anonymous.</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="display:inline-block;padding:14px 30px;background:linear-gradient(135deg,#4da6ff,#2b8fef);color:#fff;border-radius:8px;font-weight:700;font-size:15px;">Log in to submit your feedback</span>
        </div>
        <p style="font-size:12px;color:#4a6a8a;">This is an automated reminder from Watan First Digital Feedback System.</p>
      </div>`;
      await sendBrevoEmail(emp.email, `Feedback Reminder — ${monthName}`, emailHtml);
      sentCount++;
    }
    res.json({success:true, message:`Reminders sent to ${sentCount} employee(s) who haven't submitted feedback this month.`});
  } catch(e) { console.error('[ERROR] Send reminder:', e); res.status(500).json({success:false,message:'Failed to send reminders.'}); }
});

// ── RESPOND TO SUGGESTION (HR Accept/Reject) ──────────────
app.post('/api/admin/respond-suggestion', requireAdmin, async (req, res) => {
  try {
    const { id, status, hr_comment, send_all } = req.body;
    if (!id || !status || !hr_comment) return res.status(400).json({success:false,message:'Missing fields.'});
    if (status !== 'accepted' && status !== 'rejected') return res.status(400).json({success:false,message:'Invalid status.'});
    const suggestion = db.prepare('SELECT * FROM fb_suggestions WHERE id=?').get(id);
    if (!suggestion) return res.status(404).json({success:false,message:'Suggestion not found.'});
    const respondedAt = new Date().toISOString();
    db.prepare('UPDATE fb_suggestions SET status=?, hr_comment=?, responded_at=? WHERE id=?').run(status, hr_comment, respondedAt, id);
    cloudUpdate('fb_suggestions', id, {status, hr_comment, responded_at: respondedAt});
    res.json({success:true});
    console.log(`[SUGGESTION] ${status} suggestion ${id} from ${suggestion.department}`);

    // Send email to department (or all) on ACCEPT only
    if (status === 'accepted') {
      try {
        const recipients = send_all
          ? db.prepare('SELECT * FROM fb_users WHERE is_admin=0').all()
          : db.prepare('SELECT * FROM fb_users WHERE department=? AND is_admin=0').all(suggestion.department);
        const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#fff;padding:30px;border-radius:12px;">
          <h2 style="color:#4ade80;">💡 Suggestion Accepted!</h2>
          <p style="color:#a0b4cc;">A suggestion from the <strong>${suggestion.department}</strong> department has been approved:</p>
          <div style="background:#0f2035;border:1px solid rgba(74,222,128,0.3);border-radius:10px;padding:16px;margin:16px 0;">
            <p style="font-size:15px;color:#e0eaff;line-height:1.5;font-style:italic;">"${suggestion.suggestion}"</p>
          </div>
          <div style="background:rgba(74,222,128,0.08);border-radius:8px;padding:12px;margin:12px 0;">
            <p style="font-size:12px;color:#4ade80;font-weight:600;margin-bottom:4px;">HR Response:</p>
            <p style="font-size:14px;color:#e0eaff;">${hr_comment}</p>
          </div>
          <p style="color:#a0b4cc;font-size:13px;margin-top:16px;">Visit the Suggestion Box to see all updates.</p>
          <p style="font-size:12px;color:#4a6a8a;margin-top:16px;">Watan First Digital Feedback System</p>
        </div>`;
        let sent = 0;
        for (const emp of recipients) {
          await sendBrevoEmail(emp.email, 'Suggestion Accepted — Watan First Digital', emailHtml);
          sent++;
        }
        console.log(`[EMAIL] Suggestion accepted email sent to ${sent} people (${send_all?'all departments':suggestion.department})`);
      } catch(emailErr) { console.error('[EMAIL] Suggestion notify error:', emailErr.message); }
    }
  } catch(e) { console.error('[ERROR] Respond suggestion:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── DELETE REJECTED SUGGESTION (HR only) ───────────────────
app.delete('/api/admin/delete-suggestion/:id', requireAdmin, async (req, res) => {
  try {
    const suggestion = db.prepare('SELECT * FROM fb_suggestions WHERE id=?').get(req.params.id);
    if (!suggestion) return res.status(404).json({success:false,message:'Suggestion not found.'});
    if (suggestion.status !== 'rejected') return res.status(400).json({success:false,message:'Only rejected suggestions can be deleted.'});
    db.prepare('DELETE FROM fb_suggestions WHERE id=?').run(req.params.id);
    try { await supabase.from('fb_suggestions').delete().eq('id', req.params.id); } catch(e) {}
    console.log('[SUGGESTION] HR deleted rejected suggestion', req.params.id);
    res.json({success:true});
  } catch(e) { console.error('[ERROR] Delete suggestion:', e); res.status(500).json({success:false,message:'Server error.'}); }
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n=============================================`);
  console.log(`  Watan First Digital — Feedback System v5`);
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
  // Seed default departments if none exist
  const deptCount = db.prepare('SELECT COUNT(*) as c FROM fb_departments').get().c;
  if (deptCount === 0) {
    const defaults = ['Design','Development','Digital Marketing','Business Development','Administration'];
    for (const d of defaults) {
      db.prepare('INSERT OR IGNORE INTO fb_departments (name,created_at) VALUES (?,?)').run(d, new Date().toISOString());
      try { supabase.from('fb_departments').upsert({name:d,created_at:new Date().toISOString()},{onConflict:'name'}).then(()=>{}); } catch(e) {}
    }
    console.log('[OK] Default departments seeded');
  }
  console.log(`=============================================\n`);
});
