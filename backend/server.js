/* ═══════════════════════════════════════════════════════════════════════════
   AGII v13.3 — Production AI Agent Platform
   Multi-agent orchestration, persistent memory, real tools, self-improvement
   ═══════════════════════════════════════════════════════════════════════════ */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { v4: uuidv4 } = require('uuid');
const Groq     = require('groq-sdk');
const axios    = require('axios');
const fs       = require('fs-extra');
const path     = require('path');
const multer   = require('multer');
const rateLimit = require('express-rate-limit');
const cron     = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(rateLimit({ windowMs: 60000, max: 500, standardHeaders: true, legacyHeaders: false }));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Rate-limit aware Groq wrapper ───────────────────────────────────────────
// Groq free tier: ~6000 TPM per model. We queue calls and retry on 429.
const groqQueue = [];
let groqActive  = 0;
const MAX_CONCURRENT = 2;

async function groqCall(params, retries = 4) {
  // Wait for a concurrency slot
  while (groqActive >= MAX_CONCURRENT) await new Promise(r => setTimeout(r, 200));
  groqActive++;
  try {
    // Actual Groq API call
    const result = await groq.chat.completions.create(params);
    return result;
  } catch(e) {
    const msg = e?.message || String(e);
    if ((msg.includes('429') || msg.includes('rate_limit_exceeded')) && retries > 0) {
      // Parse the exact wait time from Groq error message
      const waitMatch = msg.match(/try again in ([0-9.]+)s/i);
      const wait = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) + 1000 : 12000;
      sysLog('warn', 'groq', `Rate limited on ${params.model} — waiting ${Math.round(wait/1000)}s (retries: ${retries})`);
      groqActive = Math.max(0, groqActive - 1); // release slot while waiting
      await new Promise(r => setTimeout(r, wait));
      return await groqCall(params, retries - 1);
    }
    throw e;
  } finally {
    groqActive = Math.max(0, groqActive - 1);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// DATA LAYER
// ─────────────────────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, 'data');
const DIRS = ['sessions','memory','skills','automations','files','personas',
              'agents','tasks','logs','knowledge','experiments','metrics'];
DIRS.forEach(d => fs.ensureDirSync(path.join(DATA, d)));
fs.ensureDirSync(path.join(__dirname, 'uploads'));

function jload(p, def = {})  { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function jsave(p, v)         { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); }

function sysLog(level, src, msg, data = null) {
  try {
    const lf   = path.join(DATA, 'logs', new Date().toISOString().slice(0,10) + '.json');
    const logs = jload(lf, []);
    logs.push({ id: uuidv4(), ts: new Date().toISOString(), level, src, msg, data });
    if (logs.length > 3000) logs.splice(0, logs.length - 3000);
    jsave(lf, logs);
  } catch {}
}

// Strip non-Groq fields from message objects before sending to API
function cleanMsg(m) {
  const out = { role: m.role, content: m.content ?? null };
  if (m.tool_calls)    out.tool_calls    = m.tool_calls;
  if (m.tool_call_id)  out.tool_call_id  = m.tool_call_id;
  if (m.name)          out.name          = m.name;
  return out;
}
function parseArgs(raw) { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } }

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const MEM_FILE = path.join(DATA, 'memory', 'global.json');
let MEM = jload(MEM_FILE, { facts:[], preferences:[], projects:[], notes:[], people:[], knowledge:[], decisions:[] });

function saveMem()            { jsave(MEM_FILE, MEM); }
function memAdd(type, content) {
  if (!MEM[type]) MEM[type] = [];
  if (MEM[type].some(i => i.content === content)) return null;
  const e = { id: uuidv4(), content, ts: new Date().toISOString() };
  MEM[type].push(e);
  if (MEM[type].length > 1000) MEM[type] = MEM[type].slice(-1000);
  saveMem();
  return e;
}
function memSearch(q) {
  const ql = q.toLowerCase(), res = [];
  Object.entries(MEM).forEach(([type, items]) => {
    if (!Array.isArray(items)) return;
    items.forEach(i => { if (i.content?.toLowerCase().includes(ql)) res.push({ type, ...i }); });
  });
  return res.slice(0, 25);
}
function memCtx() {
  return Object.entries(MEM)
    .filter(([,v]) => Array.isArray(v) && v.length)
    .map(([k,v]) => `[${k}]: ${v.slice(-5).map(i => i.content).join(' | ')}`)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH
// ─────────────────────────────────────────────────────────────────────────────
const KG_FILE = path.join(DATA, 'knowledge', 'graph.json');
let KG = jload(KG_FILE, { nodes: [], edges: [] });
function kgSave() { jsave(KG_FILE, KG); }
function kgAddNode(label, type) {
  if (KG.nodes.find(n => n.label === label && n.type === type)) return;
  KG.nodes.push({ id: uuidv4(), label, type, ts: new Date().toISOString() });
  if (KG.nodes.length > 5000) KG.nodes.splice(0, KG.nodes.length - 5000);
  kgSave();
}
function kgAddEdge(from, to, rel) {
  KG.edges.push({ id: uuidv4(), from, to, rel, ts: new Date().toISOString() });
  if (KG.edges.length > 10000) KG.edges.splice(0, KG.edges.length - 10000);
  kgSave();
}

// ─────────────────────────────────────────────────────────────────────────────
// SKILLS ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const SKILLS_FILE = path.join(DATA, 'skills', 'registry.json');
let SKILLS = jload(SKILLS_FILE, {});
function skillSave() { jsave(SKILLS_FILE, SKILLS); }

// ─────────────────────────────────────────────────────────────────────────────
// AGENT REGISTRY — 11 built-in specialized agents
// ─────────────────────────────────────────────────────────────────────────────
const AGENT_DEFS = {
  orchestrator: { name:'Orchestrator',   emoji:'🧠', role:'orchestrator',   model:'llama-3.1-8b-instant',    desc:'Coordinates all agents. Decomposes complex goals into subtasks and delegates to specialists.' },
  researcher:   { name:'Researcher',     emoji:'🔍', role:'researcher',     model:'gemma2-9b-it',             desc:'Web search, data gathering, fact verification, literature review.' },
  coder:        { name:'Code Engineer',  emoji:'💻', role:'coder',          model:'llama-3.3-70b-versatile',  desc:'Writes, reviews, debugs and optimizes code in any programming language.' },
  analyst:      { name:'Analyst',        emoji:'📊', role:'analyst',        model:'mixtral-8x7b-32768',       desc:'Data analysis, pattern recognition, statistical insights, visualization.' },
  writer:       { name:'Writer',         emoji:'✍️', role:'writer',         model:'llama-3.3-70b-versatile',  desc:'Content creation, copywriting, documentation, structured reports.' },
  planner:      { name:'Planner',        emoji:'📋', role:'planner',        model:'gemma2-9b-it',             desc:'Strategic task decomposition, dependency mapping, timeline estimation.' },
  critic:       { name:'Critic',         emoji:'🎯', role:'critic',         model:'mixtral-8x7b-32768',       desc:'Quality assurance, error detection, improvement suggestions.' },
  memory_agent: { name:'Memory Agent',   emoji:'💾', role:'memory_agent',   model:'llama-3.1-8b-instant',    desc:'Knowledge storage, retrieval, context compression.' },
  executor:     { name:'Executor',       emoji:'⚡', role:'executor',       model:'gemma2-9b-it',             desc:'Runs tools, executes tasks, manages file operations.' },
  monitor:      { name:'Monitor',        emoji:'📡', role:'monitor',        model:'llama-3.1-8b-instant',    desc:'System health, performance metrics, anomaly detection.' },
  optimizer:    { name:'Optimizer',      emoji:'🔧', role:'optimizer',      model:'mixtral-8x7b-32768',       desc:'Performance analysis, architecture improvements, self-optimization.' },
};

const AGENTS_FILE = path.join(DATA, 'agents', 'registry.json');
let AGENTS = jload(AGENTS_FILE, {});
(function seedAgents() {
  let changed = false;
  Object.entries(AGENT_DEFS).forEach(([role, def]) => {
    if (!AGENTS[role]) {
      AGENTS[role] = { id: uuidv4(), ...def, status: 'idle', tasksCompleted: 0, tasksRunning: 0, errors: 0, created: new Date().toISOString(), lastActive: null };
      changed = true;
    }
  });
  if (changed) jsave(AGENTS_FILE, AGENTS);
})();

function agentList() {
  return Object.values(AGENTS).map(a => ({
    id: a.id, role: a.role, name: a.name, emoji: a.emoji, desc: a.desc,
    status: a.status, tasksCompleted: a.tasksCompleted, tasksRunning: a.tasksRunning,
    errors: a.errors, lastActive: a.lastActive, model: a.model
  }));
}
function agentUpdate(role, upd) {
  if (AGENTS[role]) { Object.assign(AGENTS[role], upd, { lastActive: new Date().toISOString() }); jsave(AGENTS_FILE, AGENTS); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
const TASKS_FILE = path.join(DATA, 'tasks', 'registry.json');
let TASKS = jload(TASKS_FILE, {});
function taskSave() { jsave(TASKS_FILE, TASKS); }
function taskMake(missionId, role, desc, priority = 'normal') {
  const t = { id: uuidv4(), missionId, role, desc, priority, status: 'pending', result: null, error: null, created: new Date().toISOString(), started: null, completed: null, toolsUsed: [] };
  TASKS[t.id] = t;
  taskSave();
  return t;
}
function taskList() { return Object.values(TASKS).sort((a,b) => new Date(b.created) - new Date(a.created)).slice(0, 100); }

// ─────────────────────────────────────────────────────────────────────────────
// EXPERIMENT ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const EXP_FILE = path.join(DATA, 'experiments', 'registry.json');
let EXPERIMENTS = jload(EXP_FILE, {});
function expSave() { jsave(EXP_FILE, EXPERIMENTS); }
function expAdd(name, hypothesis, params) {
  const e = { id: uuidv4(), name, hypothesis, params, status: 'pending', results: null, score: null, created: new Date().toISOString() };
  EXPERIMENTS[e.id] = e;
  expSave();
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// METRICS ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const METRICS_FILE = path.join(DATA, 'metrics', 'history.json');
let METRICS = jload(METRICS_FILE, []);
function metricsRecord(data) {
  METRICS.push({ ts: new Date().toISOString(), ...data });
  if (METRICS.length > 10000) METRICS = METRICS.slice(-10000);
  jsave(METRICS_FILE, METRICS);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATIONS ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const AUTO_FILE = path.join(DATA, 'automations', 'registry.json');
let AUTOS = jload(AUTO_FILE, {});
const CRONS = {};
function autoSave() { jsave(AUTO_FILE, AUTOS); }
function autoSchedule(a) {
  if (CRONS[a.id]) { CRONS[a.id].stop(); delete CRONS[a.id]; }
  if (!a.active || !a.cron) return;
  try {
    CRONS[a.id] = cron.schedule(a.cron, async () => {
      a.lastRun   = new Date().toISOString();
      a.runCount  = (a.runCount || 0) + 1;
      autoSave();
      sysLog('info', 'cron', `Running automation: ${a.name}`);
      const sid = uuidv4();
      const sess = sessionGet(sid);
      sess.messages.push({ role: 'user', content: a.task, ts: new Date().toISOString() });
      try {
        const result = await agentLoop(sess, sid, null, 'orchestrator');
        a.lastResult = result.slice(0, 500);
      } catch (e) { a.lastResult = `Error: ${e.message}`; }
      autoSave();
    });
  } catch (e) { sysLog('error', 'cron', `Schedule failed: ${e.message}`); }
}
Object.values(AUTOS).forEach(a => autoSchedule(a));

// ─────────────────────────────────────────────────────────────────────────────
// SESSIONS
// ─────────────────────────────────────────────────────────────────────────────
const SESSIONS = {};
function sessionGet(id) {
  if (!SESSIONS[id]) {
    const f = path.join(DATA, 'sessions', `${id}.json`);
    SESSIONS[id] = jload(f, { id, messages: [], title: 'New Conversation', created: new Date().toISOString(), model: 'llama-3.1-8b-instant', personaId: 'default' });
  }
  return SESSIONS[id];
}
function sessionSave(id) {
  const s = SESSIONS[id];
  if (s) jsave(path.join(DATA, 'sessions', `${id}.json`), s);
}
function sessionList() {
  try {
    return fs.readdirSync(path.join(DATA, 'sessions'))
      .filter(f => f.endsWith('.json'))
      .map(f => { const d = jload(path.join(DATA, 'sessions', f)); return { id: d.id, title: d.title, created: d.created, messageCount: d.messages?.length || 0, model: d.model }; })
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, 100);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSONAS
// ─────────────────────────────────────────────────────────────────────────────
const PERSONA_FILE = path.join(DATA, 'personas', 'registry.json');
let PERSONAS = jload(PERSONA_FILE, {
  default: { id: 'default', name: 'AGII', avatar: '🤖', model: 'llama-3.1-8b-instant', temperature: 0.7,
    systemPrompt: `You are AGII — a production-grade multi-agent AI platform. You are precise, powerful, and genuinely capable.\n\nYou coordinate specialized agents, maintain persistent memory, and execute real tools to complete any task.\n\nFor complex goals:\n- Use spawn_agent to delegate to specialists (researcher, coder, analyst, writer, planner, critic, executor)\n- Each agent runs independently with its own tools\n- Synthesize results into a coherent final answer\n\nAlways use tools proactively. Be thorough but concise. Never make up data — search for it.`
  }
});
function personaSave() { jsave(PERSONA_FILE, PERSONAS); }

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  { type:'function', function:{ name:'web_search',       description:'Search internet for real-time information, news, facts, prices.',           parameters:{ type:'object', properties:{ query:{type:'string'}, count:{type:'number',description:'results 1-10, default 5'} }, required:['query'] } } },
  { type:'function', function:{ name:'fetch_url',        description:'Fetch and read full text of any webpage URL.',                               parameters:{ type:'object', properties:{ url:{type:'string'} }, required:['url'] } } },
  { type:'function', function:{ name:'execute_code',     description:'Execute JavaScript code for math, algorithms, data processing.',             parameters:{ type:'object', properties:{ code:{type:'string'}, description:{type:'string'} }, required:['code','description'] } } },
  { type:'function', function:{ name:'remember',         description:'Save important information to persistent long-term memory.',                  parameters:{ type:'object', properties:{ type:{type:'string',enum:['facts','preferences','projects','notes','people','knowledge','decisions']}, content:{type:'string'} }, required:['type','content'] } } },
  { type:'function', function:{ name:'recall',           description:'Search long-term persistent memory by keyword.',                             parameters:{ type:'object', properties:{ query:{type:'string'} }, required:['query'] } } },
  { type:'function', function:{ name:'write_file',       description:'Create a downloadable text, code, CSV, JSON, or markdown file.',             parameters:{ type:'object', properties:{ filename:{type:'string'}, content:{type:'string'} }, required:['filename','content'] } } },
  { type:'function', function:{ name:'read_file',        description:'Read content of a previously created file.',                                 parameters:{ type:'object', properties:{ filename:{type:'string'} }, required:['filename'] } } },
  { type:'function', function:{ name:'list_files',       description:'List all created files.',                                                    parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'create_skill',     description:'Save a reusable JavaScript function as a named skill.',                      parameters:{ type:'object', properties:{ name:{type:'string'}, description:{type:'string'}, code:{type:'string'} }, required:['name','description','code'] } } },
  { type:'function', function:{ name:'run_skill',        description:'Execute a previously saved skill by name.',                                  parameters:{ type:'object', properties:{ name:{type:'string'}, args:{type:'object'} }, required:['name'] } } },
  { type:'function', function:{ name:'list_skills',      description:'List all saved skills.',                                                     parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'spawn_agent',      description:'Delegate a task to a specialized agent. Roles: researcher, coder, analyst, writer, planner, critic, executor, memory_agent, optimizer', parameters:{ type:'object', properties:{ role:{type:'string'}, task:{type:'string'} }, required:['role','task'] } } },
  { type:'function', function:{ name:'reason_and_plan',  description:'Deep structured reasoning for complex problems. Creates step-by-step plan.', parameters:{ type:'object', properties:{ problem:{type:'string'} }, required:['problem'] } } },
  { type:'function', function:{ name:'analyze_image_url',description:'Analyze an image from a URL with optional question.',                        parameters:{ type:'object', properties:{ url:{type:'string'}, question:{type:'string'} }, required:['url'] } } },
  { type:'function', function:{ name:'calculate',        description:'Evaluate a math expression precisely.',                                      parameters:{ type:'object', properties:{ expression:{type:'string'} }, required:['expression'] } } },
  { type:'function', function:{ name:'get_current_time', description:'Get current date, time, and timezone.',                                      parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'create_automation',description:'Schedule a recurring AI task with a cron expression.',                       parameters:{ type:'object', properties:{ name:{type:'string'}, task:{type:'string'}, cron:{type:'string',description:'Standard cron e.g. "0 9 * * *"'} }, required:['name','task','cron'] } } },
  { type:'function', function:{ name:'get_system_stats', description:'Get platform performance statistics.',                                       parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'add_knowledge',    description:'Add a node to the knowledge graph.',                                         parameters:{ type:'object', properties:{ label:{type:'string'}, type:{type:'string'}, relatesTo:{type:'string'} }, required:['label','type'] } } },
  { type:'function', function:{ name:'run_benchmark',    description:'Run a performance benchmark test.',                                          parameters:{ type:'object', properties:{ test:{type:'string',enum:['reasoning','coding','planning','search','memory']}, prompt:{type:'string'} }, required:['test','prompt'] } } },
];

// Sub-agent tools (no spawn_agent to avoid infinite recursion)
const SUB_TOOLS = TOOLS.filter(t => t.function.name !== 'spawn_agent');

// ─────────────────────────────────────────────────────────────────────────────
// TOOL EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────
async function execTool(name, args, sessionId, depth = 0) {
  sysLog('debug', 'tool', `exec:${name}`, args);
  try {
    switch (name) {

      case 'web_search': {
        const res = await axios.get(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AGII/13)' }, timeout: 12000 }
        );
        const cheerio = require('cheerio');
        const $ = cheerio.load(res.data);
        const results = [];
        $('.result').slice(0, Math.min(args.count || 5, 10)).each((i, el) => {
          const title   = $(el).find('.result__title').text().trim();
          const snippet = $(el).find('.result__snippet').text().trim();
          const url     = $(el).find('.result__url').text().trim();
          if (title) results.push({ title, snippet, url });
        });
        return { success: true, query: args.query, count: results.length, results };
      }

      case 'fetch_url': {
        const res = await axios.get(args.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AGII/13)' },
          timeout: 12000, maxContentLength: 1000000
        });
        const cheerio = require('cheerio');
        const $ = cheerio.load(res.data);
        $('script,style,nav,footer,header,iframe,ads,noscript').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 10000);
        return { success: true, url: args.url, length: text.length, content: text };
      }

      case 'execute_code': {
        try {
          const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
          const logs = [];
          const mockConsole = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR:'+a.join(' ')) };
          const fn = new AsyncFn('Math','Date','JSON','Array','Object','String','Number','console','Promise', args.code);
          const result = await fn(Math,Date,JSON,Array,Object,String,Number,mockConsole,Promise);
          return { success: true, result: String(result ?? 'undefined'), logs, description: args.description };
        } catch (e) { return { success: false, error: e.message }; }
      }

      case 'remember':  { const e = memAdd(args.type, args.content); return { success: true, stored: !!e, type: args.type, content: args.content }; }
      case 'recall':    { const r = memSearch(args.query); return { success: true, found: r.length, results: r }; }

      case 'write_file': {
        const fp = path.join(DATA, 'files', path.basename(args.filename));
        fs.writeFileSync(fp, args.content, 'utf8');
        return { success: true, filename: args.filename, bytes: args.content.length, downloadUrl: `/api/files/${args.filename}` };
      }
      case 'read_file': {
        const fp = path.join(DATA, 'files', path.basename(args.filename));
        if (!fs.existsSync(fp)) return { success: false, error: 'File not found' };
        return { success: true, filename: args.filename, content: fs.readFileSync(fp, 'utf8').slice(0, 50000) };
      }
      case 'list_files': {
        const dir = path.join(DATA, 'files');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).map(f => {
          const s = fs.statSync(path.join(dir, f));
          return { name: f, size: s.size, created: s.birthtime };
        }) : [];
        return { success: true, count: files.length, files };
      }

      case 'create_skill': {
        SKILLS[args.name] = { name: args.name, description: args.description, code: args.code, created: new Date().toISOString(), runCount: 0 };
        skillSave();
        return { success: true, saved: args.name };
      }
      case 'run_skill': {
        const sk = SKILLS[args.name];
        if (!sk) return { success: false, error: `Skill "${args.name}" not found. Available: ${Object.keys(SKILLS).join(', ') || 'none'}` };
        try {
          sk.runCount = (sk.runCount || 0) + 1; skillSave();
          const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFn('args','Math','Date','JSON', sk.code);
          const result = await fn(args.args || {}, Math, Date, JSON);
          return { success: true, skill: args.name, result: String(result ?? '') };
        } catch (e) { return { success: false, skill: args.name, error: e.message }; }
      }
      case 'list_skills': {
        return { success: true, count: Object.keys(SKILLS).length, skills: Object.values(SKILLS).map(s => ({ name: s.name, description: s.description, runCount: s.runCount || 0 })) };
      }

      case 'spawn_agent': {
        if (depth >= 2) return { success: false, error: 'Max agent depth reached' };
        const role = args.role || 'researcher';
        const agent = AGENTS[role];
        if (!agent) return { success: false, error: `Unknown agent role: ${role}` };
        const task = taskMake(sessionId, role, args.task);
        const result = await runAgentTask(task, sessionId, null, depth + 1);
        return { success: true, role, agentName: agent.name, result: result.result || result.error || 'No result' };
      }

      case 'reason_and_plan': {
        const c = await groqCall({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: 'You are a deep reasoning engine. Think step by step and produce structured plans.' },
            { role: 'user',   content: `Problem: ${args.problem}\n\nProvide:\n1. Problem analysis\n2. Key constraints\n3. Step-by-step plan\n4. Risk assessment\n5. Success criteria` }
          ],
          temperature: 0.2, max_tokens: 2048
        });
        return { success: true, reasoning: c.choices[0].message.content };
      }

      case 'analyze_image_url': {
        const c = await groqCall({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: args.url } },
            { type: 'text', text: args.question || 'Describe this image in complete detail.' }
          ]}],
          max_tokens: 1024
        });
        return { success: true, analysis: c.choices[0].message.content };
      }

      case 'calculate': {
        try {
          const result = Function('"use strict"; return (' + args.expression + ')')();
          return { success: true, expression: args.expression, result };
        } catch (e) { return { success: false, expression: args.expression, error: e.message }; }
      }

      case 'get_current_time': {
        const n = new Date();
        return { success: true, iso: n.toISOString(), utc: n.toUTCString(), unix: n.getTime(), date: n.toDateString(), time: n.toTimeString() };
      }

      case 'create_automation': {
        const id  = uuidv4();
        const au  = { id, name: args.name, task: args.task, cron: args.cron, active: true, created: new Date().toISOString(), runCount: 0, lastRun: null, lastResult: null };
        AUTOS[id] = au; autoSave(); autoSchedule(au);
        sysLog('info', 'automation', `Created: ${args.name}`);
        return { success: true, id, name: args.name, cron: args.cron };
      }

      case 'get_system_stats': {
        const sessions = sessionList();
        const totalMsgs = sessions.reduce((s, x) => s + (x.messageCount || 0), 0);
        const memTotal  = Object.values(MEM).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
        return {
          success: true,
          sessions: sessions.length, totalMessages: totalMsgs,
          memoryItems: memTotal, skills: Object.keys(SKILLS).length,
          automations: Object.keys(AUTOS).length, agents: Object.keys(AGENTS).length,
          tasks: Object.keys(TASKS).length, knowledgeNodes: KG.nodes.length,
          uptime: Math.floor(process.uptime()), version: '13.3'
        };
      }

      case 'add_knowledge': {
        kgAddNode(args.label, args.type);
        if (args.relatesTo) kgAddEdge(args.label, args.relatesTo, 'relates_to');
        return { success: true, added: args.label, type: args.type };
      }

      case 'run_benchmark': {
        const start = Date.now();
        const c = await groqCall({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: `You are being benchmarked on ${args.test}. Give your best answer.` },
            { role: 'user',   content: args.prompt }
          ],
          temperature: 0.1, max_tokens: 1024
        });
        const latency = Date.now() - start;
        const tokens  = c.usage?.total_tokens || 0;
        const result  = { test: args.test, latency_ms: latency, tokens, answer: c.choices[0].message.content, timestamp: new Date().toISOString() };
        metricsRecord({ type: 'benchmark', ...result });
        return { success: true, ...result };
      }

      default: return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    sysLog('error', 'tool', `${name} failed: ${e.message}`);
    return { success: false, tool: name, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT TASK RUNNER — runs a sub-agent on a specific task
// Uses SUB_TOOLS (no spawn_agent) to prevent infinite recursion
// ─────────────────────────────────────────────────────────────────────────────
async function runAgentTask(task, sessionId, send, depth = 1) {
  const agent = AGENTS[task.role] || AGENTS['researcher'];
  task.status  = 'running';
  task.started = new Date().toISOString();
  taskSave();
  agentUpdate(task.role, { status: 'working', tasksRunning: (agent.tasksRunning || 0) + 1 });

  if (send) send({ type: 'agent_start', role: task.role, name: agent.name, emoji: agent.emoji, task: task.desc });

  const messages = [
    { role: 'system', content: `You are ${agent.name} (${agent.emoji}). ${agent.desc}\n\nCurrent date: ${new Date().toISOString()}\n\nExecute your task precisely. Use tools proactively. Return a complete, thorough result.` },
    { role: 'user',   content: task.desc }
  ];

  let result = '';
  let itr    = 0;
  const maxItr = 6;

  try {
    while (itr < maxItr) {
      itr++;
      const comp   = await groqCall({ model: agent.model || 'llama-3.3-70b-versatile', messages, tools: SUB_TOOLS, tool_choice: 'auto', temperature: 0.4, max_tokens: 2000 });
      const choice = comp.choices[0];
      const msg    = choice.message;
      messages.push(cleanMsg(msg));

      if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const targs = parseArgs(tc.function.arguments);
          if (send) send({ type: 'agent_tool', role: task.role, name: agent.name, emoji: agent.emoji, tool: tc.function.name });
          task.toolsUsed.push(tc.function.name);
          const tres = await execTool(tc.function.name, targs, sessionId, depth);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(tres) });
        }
      } else {
        result = msg.content || '';
        break;
      }
    }
    task.status    = 'completed';
    task.result    = result;
    task.completed = new Date().toISOString();
    taskSave();
    agentUpdate(task.role, { status: 'idle', tasksCompleted: (agent.tasksCompleted || 0) + 1, tasksRunning: Math.max(0, (agent.tasksRunning || 1) - 1) });
    if (send) send({ type: 'agent_done', role: task.role, name: agent.name, emoji: agent.emoji, result: result.slice(0, 300) });
    return { success: true, result };
  } catch (e) {
    task.status = 'failed';
    task.error  = e.message;
    taskSave();
    agentUpdate(task.role, { status: 'idle', errors: (agent.errors || 0) + 1, tasksRunning: Math.max(0, (agent.tasksRunning || 1) - 1) });
    sysLog('error', 'agent', `${agent.name} failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN AGENT LOOP — the orchestrator's core reasoning loop
// ─────────────────────────────────────────────────────────────────────────────
async function agentLoop(session, sessionId, send, role = 'orchestrator') {
  const agent   = AGENTS[role] || AGENTS['orchestrator'];
  const persona = PERSONAS[session.personaId] || PERSONAS['default'];
  const mem     = memCtx();

  const systemPrompt = `${persona.systemPrompt}

Agent: ${agent.name} (${agent.emoji})
Current date/time: ${new Date().toISOString()}
${mem ? `\nPersistent memory:\n${mem}` : ''}

Available agents you can delegate to via spawn_agent:
${agentList().map(a => `- ${a.role}: ${a.desc}`).join('\n')}

Always use tools when they add value. For multi-step work, delegate to agents.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.messages.slice(-40).map(cleanMsg)
  ];

  let finalText = '';
  let itr       = 0;
  const maxItr  = 10;

  const FALLBACK_MODELS = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'mixtral-8x7b-32768'];
  let modelIdx = 0;
  const preferredModel = session.model || persona.model || 'llama-3.1-8b-instant';
  // Put preferred model first
  const modelOrder = [preferredModel, ...FALLBACK_MODELS.filter(m => m !== preferredModel)];

  while (itr < maxItr) {
    itr++;
    let comp;
    let lastErr;
    // Try models in order until one works
    for (const tryModel of modelOrder) {
      try {
        comp = await groqCall({
          model:       tryModel,
          messages,
          tools:       TOOLS,
          tool_choice: 'auto',
          temperature: persona.temperature || 0.7,
          max_tokens:  4096
        });
        break; // success
      } catch(modelErr) {
        lastErr = modelErr;
        sysLog('warn', 'loop', `Model ${tryModel} failed: ${modelErr.message.slice(0,100)}, trying next`);
        // If it's a tool_use_failed, remove last tool message and retry without tools
        if (modelErr.message && modelErr.message.includes('tool_use_failed')) {
          // Try without tools as final fallback
          try {
            comp = await groqCall({
              model: 'llama-3.1-8b-instant',
              messages: messages.filter(m => m.role !== 'tool'),
              temperature: 0.7,
              max_tokens: 4096
            });
            break;
          } catch(e2) { lastErr = e2; }
        }
      }
    }
    if (!comp) throw lastErr || new Error('All models failed');
    const choice = comp.choices[0];
    const msg    = choice.message;
    messages.push(cleanMsg(msg));

    if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const targs = parseArgs(tc.function.arguments);
        if (send) send({ type: 'tool_start', tool: tc.function.name, args: targs });
        const tres = await execTool(tc.function.name, targs, sessionId, 0);
        if (send) send({ type: 'tool_result', tool: tc.function.name, result: tres });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(tres) });
      }
    } else {
      finalText = msg.content || '';
      break;
    }
  }
  return finalText;
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '13.3', uptime: Math.floor(process.uptime()), agents: Object.keys(AGENTS).length, timestamp: new Date().toISOString() });
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/api/sessions', (req, res) => res.json(sessionList()));
app.delete('/api/sessions/:id', (req, res) => {
  const f = path.join(DATA, 'sessions', `${req.params.id}.json`);
  if (fs.existsSync(f)) fs.removeSync(f);
  delete SESSIONS[req.params.id];
  res.json({ success: true });
});
app.patch('/api/sessions/:id', (req, res) => {
  const s = sessionGet(req.params.id);
  Object.assign(s, req.body);
  sessionSave(req.params.id);
  res.json({ success: true, session: s });
});
app.get('/api/sessions/:id', (req, res) => {
  const s = sessionGet(req.params.id);
  res.json(s);
});

// ── Chat (SSE streaming) ──────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, model, personaId, imageUrl, role } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: 'message and sessionId required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sse = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

  try {
    const session = sessionGet(sessionId);
    if (model)     session.model     = model;
    if (personaId) session.personaId = personaId;

    let userContent = message;
    if (imageUrl) userContent = [{ type:'image_url', image_url:{ url:imageUrl } }, { type:'text', text:message }];
    session.messages.push({ role:'user', content:userContent, ts:new Date().toISOString() });

    if (session.messages.length === 1 || session.title === 'New Conversation') {
      session.title = message.slice(0, 70) + (message.length > 70 ? '…' : '');
    }

    sse({ type: 'start', sessionId, title: session.title });

    const finalText = await agentLoop(session, sessionId, sse, role || 'orchestrator');

    // Stream response word by word
    const words = finalText.split(' ');
    for (let i = 0; i < words.length; i++) {
      sse({ type: 'token', text: (i === 0 ? '' : ' ') + words[i] });
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 1));
    }

    session.messages.push({ role: 'assistant', content: finalText, ts: new Date().toISOString() });
    sessionSave(sessionId);

    sse({ type: 'done', sessionId, title: session.title });
    res.end();
    sysLog('info', 'chat', `Session ${sessionId}: ${message.slice(0,80)}`);
  } catch (e) {
    sysLog('error', 'chat', e.message);
    sse({ type: 'error', message: e.message });
    res.end();
  }
});

// ── Mission endpoint (multi-agent orchestrated task) ─────────────────────────
app.post('/api/mission', async (req, res) => {
  const { goal, agents: requestedAgents } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal required' });

  const missionId = uuidv4();
  const agentRoles = requestedAgents || ['planner', 'researcher', 'coder', 'writer', 'critic'];

  // Planner decomposes the goal
  const planTask = taskMake(missionId, 'planner', `Decompose this goal into ${agentRoles.length} clear subtasks for: ${goal}`);
  const planResult = await runAgentTask(planTask, missionId, null);

  // Parse subtasks from planner output
  const subtaskLines = (planResult.result || goal).split('\n')
    .filter(l => l.trim().length > 10 && !l.startsWith('#'))
    .slice(0, agentRoles.length);

  // Run each agent
  const tasks = [];
  for (let i = 0; i < Math.min(agentRoles.length, subtaskLines.length); i++) {
    const role = agentRoles[i];
    const desc = subtaskLines[i] || `Handle part ${i+1} of: ${goal}`;
    const t    = taskMake(missionId, role, desc.replace(/^[\d\.\-\*]+\s*/, ''));
    tasks.push(t);
  }

  const results = await Promise.allSettled(tasks.map(t => runAgentTask(t, missionId, null)));

  // Critic reviews all results
  const allResults = results.map((r, i) => `${tasks[i].role}: ${r.status === 'fulfilled' ? r.value?.result?.slice(0,300) : r.reason}`).join('\n\n');
  const synthesis  = await groqCall({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: 'You are a synthesis agent. Combine the following agent outputs into one coherent, complete response.' },
      { role: 'user',   content: `Goal: ${goal}\n\nAgent outputs:\n${allResults}\n\nSynthesize into a final comprehensive response.` }
    ],
    temperature: 0.3, max_tokens: 3000
  });

  res.json({
    id: missionId, goal,
    status: 'completed',
    tasks: tasks.map(t => ({ id: t.id, role: t.role, status: t.status, result: t.result?.slice(0,200) })),
    synthesis: synthesis.choices[0].message.content,
    created: new Date().toISOString()
  });
});

// ── Models ────────────────────────────────────────────────────────────────────
app.get('/api/models', (req, res) => res.json([
  { id:'llama-3.3-70b-versatile',                    name:'Llama 3.3 70B',      description:'Best overall — fast & powerful',  badge:'Recommended' },
  { id:'llama-3.1-8b-instant',                       name:'Llama 3.1 8B',       description:'Ultra-fast, efficient',           badge:'Fast' },
  { id:'meta-llama/llama-4-scout-17b-16e-instruct',  name:'Llama 4 Scout',      description:'Vision + long context',           badge:'Vision' },
  { id:'deepseek-r1-distill-llama-70b',              name:'DeepSeek R1',        description:'Deep chain-of-thought reasoning', badge:'Reasoning' },
  { id:'qwen-qwq-32b',                               name:'Qwen QwQ 32B',       description:'Advanced math & reasoning',       badge:'Reasoning' },
  { id:'mixtral-8x7b-32768',                         name:'Mixtral 8x7B',       description:'32K context window',             badge:'Long Context' },
  { id:'gemma2-9b-it',                               name:'Gemma 2 9B',         description:'Google — efficient & capable',    badge:'Google' },
]));

// ── Agents ────────────────────────────────────────────────────────────────────
app.get('/api/agents',       (req, res) => res.json(agentList()));
app.post('/api/agents',      (req, res) => {
  const { role, name, emoji, desc, model, systemPrompt } = req.body;
  if (!role || !name) return res.status(400).json({ error: 'role and name required' });
  AGENTS[role] = { id:uuidv4(), role, name, emoji:emoji||'🤖', desc:desc||'', model:model||'llama-3.3-70b-versatile', systemPrompt, status:'idle', tasksCompleted:0, tasksRunning:0, errors:0, created:new Date().toISOString(), lastActive:null };
  jsave(AGENTS_FILE, AGENTS);
  res.json({ success: true, agent: AGENTS[role] });
});
app.delete('/api/agents/:role', (req, res) => {
  if (AGENT_DEFS[req.params.role]) return res.status(400).json({ error: 'Cannot delete built-in agent' });
  delete AGENTS[req.params.role];
  jsave(AGENTS_FILE, AGENTS);
  res.json({ success: true });
});

// Agent direct task
app.post('/api/agents/:role/run', async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: 'task required' });
  const t = taskMake(uuidv4(), req.params.role, task);
  const result = await runAgentTask(t, uuidv4(), null);
  res.json({ success: true, role: req.params.role, result: result.result, taskId: t.id });
});

// ── Tasks ─────────────────────────────────────────────────────────────────────
app.get('/api/tasks',     (req, res) => res.json(taskList()));
app.get('/api/tasks/:id', (req, res) => { const t = TASKS[req.params.id]; if (!t) return res.status(404).json({error:'Not found'}); res.json(t); });

// ── Memory ────────────────────────────────────────────────────────────────────
app.get('/api/memory',           (req, res) => res.json(MEM));
app.post('/api/memory',          (req, res) => { const e = memAdd(req.body.type, req.body.content); res.json({ success: true, entry: e }); });
app.delete('/api/memory/:type/:id', (req, res) => {
  if (MEM[req.params.type]) MEM[req.params.type] = MEM[req.params.type].filter(i => i.id !== req.params.id);
  saveMem(); res.json({ success: true });
});
app.delete('/api/memory', (req, res) => {
  MEM = { facts:[], preferences:[], projects:[], notes:[], people:[], knowledge:[], decisions:[] };
  saveMem(); res.json({ success: true });
});

// ── Skills ────────────────────────────────────────────────────────────────────
app.get('/api/skills',       (req, res) => res.json(Object.values(SKILLS)));
app.delete('/api/skills/:name', (req, res) => { delete SKILLS[req.params.name]; skillSave(); res.json({ success: true }); });
app.post('/api/skills/:name/run', async (req, res) => {
  const result = await execTool('run_skill', { name: req.params.name, args: req.body.args || {} }, 'api');
  res.json(result);
});

// ── Automations ───────────────────────────────────────────────────────────────
app.get('/api/automations', (req, res) => res.json(Object.values(AUTOS)));
app.post('/api/automations', (req, res) => {
  const { name, task, cron: c } = req.body;
  if (!name || !task || !c) return res.status(400).json({ error: 'name, task, cron required' });
  const id = uuidv4();
  AUTOS[id] = { id, name, task, cron: c, active: true, created: new Date().toISOString(), runCount: 0, lastRun: null, lastResult: null };
  autoSave(); autoSchedule(AUTOS[id]);
  res.json({ success: true, automation: AUTOS[id] });
});
app.post('/api/automations/:id/toggle', (req, res) => {
  const a = AUTOS[req.params.id];
  if (!a) return res.status(404).json({ error: 'Not found' });
  a.active = !a.active; autoSave(); autoSchedule(a);
  res.json({ success: true, active: a.active });
});
app.delete('/api/automations/:id', (req, res) => {
  if (CRONS[req.params.id]) { CRONS[req.params.id].stop(); delete CRONS[req.params.id]; }
  delete AUTOS[req.params.id]; autoSave();
  res.json({ success: true });
});

// ── Personas ──────────────────────────────────────────────────────────────────
app.get('/api/personas',     (req, res) => res.json(Object.values(PERSONAS)));
app.post('/api/personas',    (req, res) => {
  const id = uuidv4();
  PERSONAS[id] = { id, created: new Date().toISOString(), ...req.body };
  personaSave(); res.json({ success: true, persona: PERSONAS[id] });
});
app.put('/api/personas/:id', (req, res) => {
  if (!PERSONAS[req.params.id]) return res.status(404).json({ error: 'Not found' });
  Object.assign(PERSONAS[req.params.id], req.body); personaSave();
  res.json({ success: true });
});
app.delete('/api/personas/:id', (req, res) => {
  if (req.params.id === 'default') return res.status(400).json({ error: 'Cannot delete default' });
  delete PERSONAS[req.params.id]; personaSave();
  res.json({ success: true });
});

// ── Knowledge Graph ───────────────────────────────────────────────────────────
app.get('/api/knowledge', (req, res) => res.json({ nodes: KG.nodes.slice(-200), edges: KG.edges.slice(-200) }));
app.post('/api/knowledge', (req, res) => {
  kgAddNode(req.body.label, req.body.type || 'concept');
  if (req.body.relatesTo) kgAddEdge(req.body.label, req.body.relatesTo, req.body.relation || 'relates_to');
  res.json({ success: true });
});

// ── Experiments ───────────────────────────────────────────────────────────────
app.get('/api/experiments',  (req, res) => res.json(Object.values(EXPERIMENTS).sort((a,b) => new Date(b.created)-new Date(a.created)).slice(0,50)));
app.post('/api/experiments', (req, res) => {
  const e = expAdd(req.body.name, req.body.hypothesis, req.body.params);
  res.json({ success: true, experiment: e });
});

// Run experiment — evaluates a prompt variant
app.post('/api/experiments/:id/run', async (req, res) => {
  const exp = EXPERIMENTS[req.params.id];
  if (!exp) return res.status(404).json({ error: 'Not found' });
  exp.status = 'running'; expSave();
  try {
    const benchmarks = ['reasoning','coding','planning','search','memory'];
    const results = {};
    for (const b of benchmarks) {
      const r = await execTool('run_benchmark', { test: b, prompt: exp.params?.prompt || exp.hypothesis }, 'experiment');
      results[b] = { latency: r.latency_ms, tokens: r.tokens };
    }
    exp.results = results;
    exp.score   = Object.values(results).reduce((s, x) => s + (1000 / (x.latency || 1000)), 0);
    exp.status  = 'completed';
    exp.completed = new Date().toISOString();
    expSave();
    res.json({ success: true, experiment: exp });
  } catch (e) { exp.status = 'failed'; exp.error = e.message; expSave(); res.status(500).json({ error: e.message }); }
});

// ── Metrics ───────────────────────────────────────────────────────────────────
app.get('/api/metrics', (req, res) => res.json(METRICS.slice(-500)));

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  try {
    const today  = new Date().toISOString().slice(0,10);
    const logs   = jload(path.join(DATA, 'logs', `${today}.json`), []);
    res.json(logs.slice(-200).reverse());
  } catch { res.json([]); }
});

// ── Files ─────────────────────────────────────────────────────────────────────
app.get('/api/files', (req, res) => {
  try {
    const dir = path.join(DATA, 'files');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).map(f => {
      const s = fs.statSync(path.join(dir, f));
      return { name: f, size: s.size, created: s.birthtime, url: `/api/files/${f}` };
    }) : [];
    res.json(files);
  } catch { res.json([]); }
});
app.get('/api/files/:filename', (req, res) => {
  const fp = path.join(DATA, 'files', path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp);
});
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const dest = path.join(DATA, 'files', req.file.originalname);
  fs.moveSync(req.file.path, dest, { overwrite: true });
  res.json({ success: true, filename: req.file.originalname, url: `/api/files/${req.file.originalname}` });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const sessions  = sessionList();
  const totalMsgs = sessions.reduce((s, x) => s + (x.messageCount || 0), 0);
  const memTotal  = Object.values(MEM).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
  res.json({
    sessions: sessions.length, totalMessages: totalMsgs,
    memoryItems: memTotal, skills: Object.keys(SKILLS).length,
    automations: Object.keys(AUTOS).length, agents: Object.keys(AGENTS).length,
    tasks: Object.keys(TASKS).length, knowledgeNodes: KG.nodes.length,
    experiments: Object.keys(EXPERIMENTS).length,
    uptime: Math.floor(process.uptime()), version: '13.3'
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 AGII v13.3 running on port ${PORT}`);
  sysLog('info', 'server', `AGII v13.3 started on port ${PORT}`);
});
