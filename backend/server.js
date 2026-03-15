require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const EventEmitter = require('events');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const limiter = rateLimit({ windowMs: 60000, max: 200 });
app.use(limiter);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
['sessions','memory','skills','automations','missions','agents'].forEach(d =>
  fs.ensureDirSync(path.join(DATA_DIR, d))
);
fs.ensureDirSync(path.join(__dirname, 'uploads'));

function loadJSON(fp, def = {}) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return def; }
}
function saveJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

// ─── MEMORY ENGINE ────────────────────────────────────────────────────────────
const memoryFile = path.join(DATA_DIR, 'memory', 'global.json');
let globalMemory = loadJSON(memoryFile, { facts:[], preferences:[], projects:[], notes:[], skills_learned:[] });
function saveMemory() { saveJSON(memoryFile, globalMemory); }
function addMemory(type, content, sessionId) {
  const entry = { id: uuidv4(), content, timestamp: new Date().toISOString(), sessionId };
  if (!globalMemory[type]) globalMemory[type] = [];
  if (!globalMemory[type].some(i => i.content === content)) {
    globalMemory[type].push(entry);
    if (globalMemory[type].length > 500) globalMemory[type] = globalMemory[type].slice(-500);
    saveMemory();
  }
  return entry;
}
function searchMemory(query) {
  const q = query.toLowerCase();
  const results = [];
  for (const [type, items] of Object.entries(globalMemory)) {
    if (Array.isArray(items)) {
      items.forEach(item => {
        if (item.content && item.content.toLowerCase().includes(q)) results.push({ type, ...item });
      });
    }
  }
  return results.slice(-20);
}

// ─── SKILLS ENGINE ────────────────────────────────────────────────────────────
const skillsFile = path.join(DATA_DIR, 'skills', 'registry.json');
let skillsRegistry = loadJSON(skillsFile, {});
function saveSkill(name, description, code) {
  skillsRegistry[name] = { name, description, code, created: new Date().toISOString() };
  saveJSON(skillsFile, skillsRegistry);
}

// ─── MISSION / AGENT SYSTEM ───────────────────────────────────────────────────
const missionsFile = path.join(DATA_DIR, 'missions', 'missions.json');
let missions = loadJSON(missionsFile, {});
function saveMissions() { saveJSON(missionsFile, missions); }

const AGENT_ROLES = [
  { id:'orchestrator', icon:'🧠', label:'Orchestrator', tier:'global' },
  { id:'researcher', icon:'🔍', label:'Researcher', tier:'specialist' },
  { id:'architect', icon:'🏗️', label:'Architect', tier:'specialist' },
  { id:'code_writer', icon:'💻', label:'Code Writer', tier:'specialist' },
  { id:'code_reviewer', icon:'🔎', label:'Reviewer', tier:'specialist' },
  { id:'test_engineer', icon:'🧪', label:'Test Eng', tier:'specialist' },
  { id:'security_auditor', icon:'🔒', label:'Security', tier:'specialist' },
  { id:'data_analyst', icon:'📊', label:'Analyst', tier:'specialist' },
  { id:'browser_agent', icon:'🌐', label:'Browser', tier:'specialist' },
  { id:'api_agent', icon:'🔌', label:'API Agent', tier:'specialist' },
  { id:'deployer', icon:'🚀', label:'Deployer', tier:'specialist' },
  { id:'validator', icon:'✅', label:'Validator', tier:'specialist' },
  { id:'optimizer', icon:'⚡', label:'Optimizer', tier:'specialist' },
  { id:'planner', icon:'📝', label:'Planner', tier:'specialist' },
  { id:'self_optimizer', icon:'🔄', label:'Self Opt', tier:'meta' },
];

// Agent pool — 100 agents total
const agentPool = [];
const roleCounts = {
  orchestrator:1, researcher:8, architect:3, code_writer:10, code_reviewer:5,
  test_engineer:5, security_auditor:3, data_analyst:5, browser_agent:5,
  api_agent:5, deployer:3, validator:4, optimizer:3, planner:5,
  self_optimizer:2, terminal_agent:5, file_agent:5, memory_agent:3,
  monitor:3, communicator:3, coordinator:3,
};
let agentIdCounter = 0;
for (const [role, count] of Object.entries(roleCounts)) {
  const def = AGENT_ROLES.find(r => r.id === role) || { icon:'🤖', label:role };
  for (let i = 0; i < count; i++) {
    agentPool.push({
      id: `${role}_${String(agentIdCounter++).padStart(3,'0')}`,
      role, icon: def.icon, label: def.label,
      state: 'idle', // idle | busy | error | offline
      tasksCompleted: 0, tasksFailed: 0, totalMs: 0,
      currentTask: null,
    });
  }
}

function getAvailableAgent(role) {
  return agentPool.find(a => a.role === role && a.state === 'idle');
}
function getAgentStats() {
  const byState = { idle:0, busy:0, error:0, offline:0 };
  const byRole = {};
  agentPool.forEach(a => {
    byState[a.state] = (byState[a.state]||0)+1;
    if (!byRole[a.role]) byRole[a.role] = { total:0, idle:0, busy:0, completed:0 };
    byRole[a.role].total++;
    byRole[a.role][a.state] = (byRole[a.role][a.state]||0)+1;
    byRole[a.role].completed += a.tasksCompleted;
  });
  return { total: agentPool.length, byState, byRole };
}

// Mission planning
function planMission(missionId, title, objective) {
  const phases = [
    { title:'Research & Analysis', role:'researcher', deps:[] },
    { title:'Architecture Design', role:'architect', deps:['t0'] },
    { title:'Core Implementation', role:'code_writer', deps:['t1'] },
    { title:'API Layer', role:'code_writer', deps:['t1'] },
    { title:'Frontend/UI', role:'code_writer', deps:['t1'] },
    { title:'Test Suite', role:'test_engineer', deps:['t2','t3'] },
    { title:'Security Audit', role:'security_auditor', deps:['t2','t3'] },
    { title:'Code Review', role:'code_reviewer', deps:['t2','t3','t4'] },
    { title:'E2E Validation', role:'validator', deps:['t5','t6','t7'] },
    { title:'Deployment', role:'deployer', deps:['t8'] },
  ];
  const tasks = phases.map((p, i) => ({
    id: `t${i}`, title: p.title, role: p.role,
    deps: p.deps, status:'pending',
    agentId: null, result:null, startedAt:null, completedAt:null,
  }));
  missions[missionId] = {
    id: missionId, title, objective,
    status:'in_progress', tasks,
    createdAt: new Date().toISOString(), completedAt: null,
  };
  saveMissions();
  return missions[missionId];
}

async function executeMissionTask(missionId, taskId) {
  const mission = missions[missionId];
  if (!mission) return;
  const task = mission.tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'pending') return;

  // Find available agent
  const agent = getAvailableAgent(task.role);
  if (!agent) return; // no available agent — will retry

  agent.state = 'busy';
  agent.currentTask = task.title;
  task.status = 'in_progress';
  task.agentId = agent.id;
  task.startedAt = new Date().toISOString();
  saveMissions();

  // Simulate real LLM-powered execution
  const startMs = Date.now();
  try {
    const systemPrompt = `You are ${agent.label} agent in a distributed AI platform. 
Execute the assigned task concisely and return a structured result.`;
    
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role:'system', content: systemPrompt },
        { role:'user', content: `Mission: "${mission.title}"\nTask: "${task.title}"\nObjective: ${mission.objective}\n\nExecute this task and return a concise result summary.` }
      ],
      max_tokens: 512,
      temperature: 0.4,
    });

    const elapsed = Date.now() - startMs;
    task.result = response.choices[0].message.content;
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    agent.state = 'idle';
    agent.currentTask = null;
    agent.tasksCompleted++;
    agent.totalMs += elapsed;

    // Check if mission is done
    if (mission.tasks.every(t => t.status === 'completed')) {
      mission.status = 'completed';
      mission.completedAt = new Date().toISOString();
    }
    saveMissions();

    // Trigger next ready tasks
    triggerReadyTasks(missionId);
  } catch (err) {
    task.status = 'failed';
    task.result = `Error: ${err.message}`;
    agent.state = 'error';
    agent.currentTask = null;
    agent.tasksFailed++;
    setTimeout(() => { agent.state = 'idle'; }, 5000);
    saveMissions();
  }
}

function triggerReadyTasks(missionId) {
  const mission = missions[missionId];
  if (!mission || mission.status !== 'in_progress') return;
  const completedIds = new Set(mission.tasks.filter(t=>t.status==='completed').map(t=>t.id));
  const readyTasks = mission.tasks.filter(t =>
    t.status === 'pending' && t.deps.every(d => completedIds.has(d))
  );
  readyTasks.forEach(task => {
    setTimeout(() => executeMissionTask(missionId, task.id), 500 + Math.random()*1000);
  });
}

// ─── SESSION MANAGER ──────────────────────────────────────────────────────────
const sessions = {};
function getSession(sessionId) {
  if (!sessions[sessionId]) {
    const sf = path.join(DATA_DIR, 'sessions', `${sessionId}.json`);
    sessions[sessionId] = loadJSON(sf, {
      id: sessionId, messages: [], title: 'New Conversation',
      created: new Date().toISOString(), model: 'llama-3.3-70b-versatile'
    });
  }
  return sessions[sessionId];
}
function saveSession(sid) {
  const s = sessions[sid];
  if (s) saveJSON(path.join(DATA_DIR, 'sessions', `${sid}.json`), s);
}
function listSessions() {
  try {
    return fs.readdirSync(path.join(DATA_DIR, 'sessions'))
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const d = loadJSON(path.join(DATA_DIR, 'sessions', f));
        return { id:d.id, title:d.title, created:d.created, messageCount:d.messages?.length||0 };
      })
      .sort((a,b) => new Date(b.created)-new Date(a.created));
  } catch { return []; }
}

// ─── TOOLS ────────────────────────────────────────────────────────────────────
const TOOLS = [
  { type:'function', function:{
    name:'web_search',
    description:'Search the internet for real-time information, current events, facts, news. ALWAYS use for anything time-sensitive.',
    parameters:{ type:'object', properties:{
      query:{ type:'string', description:'Search query' },
      count:{ type:'number', description:'Number of results (default 5)' }
    }, required:['query'] }
  }},
  { type:'function', function:{
    name:'remember',
    description:'Store important info in long-term memory. Only when user explicitly asks or shares key personal details.',
    parameters:{ type:'object', properties:{
      type:{ type:'string', enum:['facts','preferences','projects','notes'] },
      content:{ type:'string' }
    }, required:['type','content'] }
  }},
  { type:'function', function:{
    name:'recall',
    description:'Search long-term memory. Use when user asks what you remember.',
    parameters:{ type:'object', properties:{
      query:{ type:'string' }
    }, required:['query'] }
  }},
  { type:'function', function:{
    name:'execute_code',
    description:'Execute JavaScript for calculations, algorithms, data processing.',
    parameters:{ type:'object', properties:{
      code:{ type:'string', description:'JS code — must return a value' },
      description:{ type:'string' }
    }, required:['code','description'] }
  }},
  { type:'function', function:{
    name:'fetch_url',
    description:'Fetch and read text content from any URL.',
    parameters:{ type:'object', properties:{
      url:{ type:'string' }
    }, required:['url'] }
  }},
  { type:'function', function:{
    name:'create_mission',
    description:'Create a multi-step mission executed by the 100-agent distributed system. Use for complex development, research, or automation tasks.',
    parameters:{ type:'object', properties:{
      title:{ type:'string', description:'Mission title' },
      objective:{ type:'string', description:'Clear objective' },
    }, required:['title','objective'] }
  }},
  { type:'function', function:{
    name:'get_mission_status',
    description:'Get the status of a running mission.',
    parameters:{ type:'object', properties:{
      mission_id:{ type:'string' }
    }, required:['mission_id'] }
  }},
  { type:'function', function:{
    name:'reason_and_plan',
    description:'Break down a complex problem into clear steps.',
    parameters:{ type:'object', properties:{
      problem:{ type:'string' },
      context:{ type:'string' }
    }, required:['problem'] }
  }},
  { type:'function', function:{
    name:'create_skill',
    description:'Save a reusable JS function as a named skill.',
    parameters:{ type:'object', properties:{
      name:{ type:'string' },
      description:{ type:'string' },
      code:{ type:'string' }
    }, required:['name','description','code'] }
  }},
  { type:'function', function:{
    name:'run_skill',
    description:'Run a previously saved skill.',
    parameters:{ type:'object', properties:{
      name:{ type:'string' },
      args:{ type:'object' }
    }, required:['name'] }
  }},
  { type:'function', function:{
    name:'write_file',
    description:'Create a file for download.',
    parameters:{ type:'object', properties:{
      filename:{ type:'string' },
      content:{ type:'string' }
    }, required:['filename','content'] }
  }},
  { type:'function', function:{
    name:'get_current_time',
    description:'Get current date and time.',
    parameters:{ type:'object', properties:{} }
  }},
  { type:'function', function:{
    name:'analyze_image',
    description:'Analyze an uploaded image.',
    parameters:{ type:'object', properties:{
      filename:{ type:'string', description:'Uploaded filename' },
      question:{ type:'string', description:'What to analyze' }
    }, required:['filename'] }
  }},
];

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────
async function executeTool(name, args, sessionId) {
  try {
    switch (name) {
      case 'web_search': {
        const cheerio = require('cheerio');
        const resp = await axios.get(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
          { headers:{'User-Agent':'Mozilla/5.0 (compatible; AGII/11.0)'}, timeout:8000 }
        );
        const $ = cheerio.load(resp.data);
        const results = [];
        $('.result').slice(0, args.count||5).each((i, el) => {
          const title = $(el).find('.result__title').text().trim();
          const snippet = $(el).find('.result__snippet').text().trim();
          const url = $(el).find('.result__url').text().trim();
          if (title) results.push({ title, snippet, url });
        });
        return { success:true, query:args.query, results, count:results.length };
      }

      case 'remember':
        return { success:true, stored:true, entry: addMemory(args.type, args.content, sessionId) };

      case 'recall':
        return { success:true, found: searchMemory(args.query).length, results: searchMemory(args.query) };

      case 'execute_code': {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const logs = [];
        const fn = new AsyncFunction('Math','Date','JSON','console', args.code);
        const result = await fn(Math, Date, JSON, { log:(...a)=>logs.push(a.join(' ')), error:(...a)=>logs.push('ERR:'+a.join(' ')) });
        return { success:true, result, logs, description: args.description };
      }

      case 'fetch_url': {
        const cheerio = require('cheerio');
        const resp = await axios.get(args.url, {
          headers:{'User-Agent':'Mozilla/5.0'},
          timeout:10000, maxContentLength:500000
        });
        const $ = cheerio.load(resp.data);
        $('script,style,nav,footer,header').remove();
        const text = $('body').text().replace(/\s+/g,' ').trim().slice(0,3000);
        return { success:true, url:args.url, content:text };
      }

      case 'create_mission': {
        const missionId = `mission_${uuidv4().slice(0,8)}`;
        const mission = planMission(missionId, args.title, args.objective);
        // Kick off first ready tasks
        setTimeout(() => triggerReadyTasks(missionId), 1000);
        return { success:true, mission_id:missionId, title:args.title, task_count:mission.tasks.length,
          message:`Mission "${args.title}" launched with ${mission.tasks.length} tasks across specialist agents.` };
      }

      case 'get_mission_status': {
        const m = missions[args.mission_id];
        if (!m) return { success:false, error:'Mission not found' };
        const completed = m.tasks.filter(t=>t.status==='completed').length;
        const total = m.tasks.length;
        return { success:true, id:m.id, title:m.title, status:m.status,
          progress:`${completed}/${total}`, tasks:m.tasks.map(t=>({id:t.id,title:t.title,status:t.status,role:t.role})) };
      }

      case 'reason_and_plan': {
        const resp = await groq.chat.completions.create({
          model:'llama-3.3-70b-versatile',
          messages:[
            { role:'system', content:'You are a strategic planning AI. Break problems into numbered, actionable steps.' },
            { role:'user', content:`Problem: ${args.problem}\n${args.context?'Context: '+args.context:''}` }
          ],
          max_tokens:1024, temperature:0.4,
        });
        return { success:true, plan: resp.choices[0].message.content };
      }

      case 'create_skill':
        saveSkill(args.name, args.description, args.code);
        return { success:true, saved:args.name };

      case 'run_skill': {
        const skill = skillsRegistry[args.name];
        if (!skill) return { success:false, error:`Skill "${args.name}" not found. Available: ${Object.keys(skillsRegistry).join(', ')||'none'}` };
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const fn = new AsyncFunction('args','Math','Date','JSON', skill.code);
        const result = await fn(args.args||{}, Math, Date, JSON);
        return { success:true, skill:args.name, result };
      }

      case 'write_file': {
        const fp = path.join(__dirname, 'uploads', args.filename);
        fs.writeFileSync(fp, args.content);
        return { success:true, filename:args.filename, downloadUrl:`/download/${args.filename}`, size:args.content.length };
      }

      case 'get_current_time': {
        const now = new Date();
        return { success:true, utc:now.toUTCString(), iso:now.toISOString(), unix:now.getTime() };
      }

      case 'analyze_image':
        return { success:true, message:`Image "${args.filename}" received. Vision analysis requires multimodal model — noting for context.` };

      default:
        return { success:false, error:`Unknown tool: ${name}` };
    }
  } catch (err) {
    return { success:false, error: err.message };
  }
}

// ─── MODELS ───────────────────────────────────────────────────────────────────
const MODELS = {
  'llama-3.3-70b-versatile': 'LLaMA 3.3 70B',
  'llama-3.1-8b-instant': 'LLaMA 3.1 8B Fast',
  'mixtral-8x7b-32768': 'Mixtral 8x7B',
  'gemma2-9b-it': 'Gemma 2 9B',
  'deepseek-r1-distill-llama-70b': 'DeepSeek R1 70B',
};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const memSummary = Object.entries(globalMemory)
    .map(([k,v]) => Array.isArray(v)&&v.length ? `${k}: ${v.slice(-5).map(i=>i.content).join(' | ')}` : '')
    .filter(Boolean).join('\n');
  const skillsList = Object.keys(skillsRegistry).join(', ') || 'none';
  const activeMissions = Object.values(missions).filter(m=>m.status==='in_progress').length;

  return `You are AGII — a distributed AI Agent Operating System powered by 100 specialized agents.

## CRITICAL RULES
- For simple greetings (hi, hello, how are you, thanks, ok, etc.) — reply DIRECTLY, NO tools.
- Only call tools when genuinely needed.
- Never call "remember" for small talk.
- Be direct and sharp — no filler words.

## Your Agent Capabilities
- 100 specialist agents across 20+ roles (orchestrator, researchers, coders, testers, deployers...)
- Create missions: complex multi-step tasks executed in parallel by specialist agents
- Web search, code execution, URL fetching, file creation, planning
- Persistent memory and skills engine

## System Status
- Active missions: ${activeMissions}
- Agent pool: ${agentPool.filter(a=>a.state==='idle').length} idle / ${agentPool.filter(a=>a.state==='busy').length} busy
- Saved skills: ${skillsList}

## Long-term Memory
${memSummary || 'Empty — nothing stored yet.'}

## Date
${new Date().toUTCString()}

You are AGII — sharp, capable, built for real execution. Not a chatbot.`;
}

// ─── AGENTIC LOOP ─────────────────────────────────────────────────────────────
async function runAgentLoop(sessionId, userMessage, model, onChunk) {
  const session = getSession(sessionId);
  session.messages.push({ role:'user', content:userMessage });
  if (session.messages.filter(m=>m.role==='user').length===1) {
    session.title = userMessage.slice(0,60) + (userMessage.length>60?'...':'');
  }

  let fullResponse = '';
  const thinkingSteps = [];
  let iterations = 0;
  const MAX_ITER = 8;

  const messages = [
    { role:'system', content:buildSystemPrompt() },
    ...session.messages.slice(-24)
  ];

  while (iterations < MAX_ITER) {
    iterations++;
    const response = await groq.chat.completions.create({
      model, messages, tools:TOOLS, tool_choice:'auto',
      max_tokens:4096, temperature:0.7
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      fullResponse = assistantMsg.content || '';
      onChunk({ type:'content', content:fullResponse });
      break;
    }

    messages.push(assistantMsg);
    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs = {};
      try { toolArgs = JSON.parse(toolCall.function.arguments); } catch {}

      const step = { tool:toolName, args:toolArgs, timestamp:new Date().toISOString() };
      thinkingSteps.push(step);
      onChunk({ type:'thinking', step });

      const result = await executeTool(toolName, toolArgs, sessionId);
      step.result = result;
      onChunk({ type:'tool_result', tool:toolName, result });

      messages.push({ role:'tool', tool_call_id:toolCall.id, content:JSON.stringify(result) });
    }
    if (choice.finish_reason === 'stop') break;
  }

  session.messages.push({ role:'assistant', content:fullResponse });
  saveSession(sessionId);
  onChunk({ type:'done', thinkingSteps, sessionId, title:session.title });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/health', (req,res) => res.json({
  status:'AGII Online', version:'11.0',
  timestamp:new Date().toISOString(),
  agents:getAgentStats(),
  activeMissions:Object.values(missions).filter(m=>m.status==='in_progress').length,
}));
app.get('/models', (req,res) => res.json(MODELS));
app.get('/sessions', (req,res) => res.json(listSessions()));
app.get('/sessions/:id', (req,res) => res.json(getSession(req.params.id)));
app.delete('/sessions/:id', (req,res) => {
  fs.removeSync(path.join(DATA_DIR,'sessions',`${req.params.id}.json`));
  delete sessions[req.params.id];
  res.json({ success:true });
});
app.get('/memory', (req,res) => res.json(globalMemory));
app.get('/skills', (req,res) => res.json(skillsRegistry));
app.get('/missions', (req,res) => res.json(Object.values(missions)));
app.get('/missions/:id', (req,res) => {
  const m = missions[req.params.id];
  if (!m) return res.status(404).json({ error:'Not found' });
  res.json(m);
});
app.post('/missions', (req,res) => {
  const { title, objective } = req.body;
  if (!title||!objective) return res.status(400).json({ error:'title and objective required' });
  const missionId = `mission_${uuidv4().slice(0,8)}`;
  const mission = planMission(missionId, title, objective);
  setTimeout(() => triggerReadyTasks(missionId), 500);
  res.json({ success:true, mission_id:missionId, task_count:mission.tasks.length });
});
app.get('/agents', (req,res) => res.json({ pool:agentPool, stats:getAgentStats() }));
app.post('/upload', upload.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  res.json({ success:true, filename:req.file.filename, originalname:req.file.originalname });
});
app.get('/download/:filename', (req,res) => {
  const fp = path.join(__dirname,'uploads',req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error:'Not found' });
  res.download(fp);
});

// Main chat SSE
app.post('/chat', async (req,res) => {
  const { message, sessionId=uuidv4(), model='llama-3.3-70b-versatile' } = req.body;
  if (!message) return res.status(400).json({ error:'Message required' });

  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('Access-Control-Allow-Origin','*');
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await runAgentLoop(sessionId, message, model, send);
  } catch(err) {
    try {
      const fb = await groq.chat.completions.create({
        model:'llama-3.1-8b-instant',
        messages:[
          { role:'system', content:buildSystemPrompt() },
          { role:'user', content:message }
        ],
        max_tokens:2048, temperature:0.7
      });
      send({ type:'content', content:fb.choices[0].message.content });
      send({ type:'done', thinkingSteps:[], sessionId });
    } catch(e2) {
      send({ type:'error', error:e2.message });
    }
  }
  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 AGII v11 running on port ${PORT}`));
