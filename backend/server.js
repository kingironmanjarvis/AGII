/* ═══════════════════════════════════════════════════════════════════════════
   AGII v14.0 — Production AI Agent Platform
   Multi-agent orchestration · Real tools · Persistent memory · Python exec
═══════════════════════════════════════════════════════════════════════════ */
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const { v4: uuidv4 } = require('uuid');
const Groq      = require('groq-sdk');
const axios     = require('axios');
const fs        = require('fs-extra');
const path      = require('path');
const multer    = require('multer');
const rateLimit = require('express-rate-limit');
const cron      = require('node-cron');
const { exec }  = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(rateLimit({ windowMs: 60000, max: 1000, standardHeaders: true, legacyHeaders: false }));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Groq wrapper with retry + timeout ────────────────────────────────────
async function groqCall(params, retries = 4) {
  const TIMEOUT = 40000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await Promise.race([
        groq.chat.completions.create(params),
        new Promise((_,rej) => setTimeout(() => rej(new Error('Groq timeout 40s')), TIMEOUT))
      ]);
    } catch(e) {
      const msg = e?.message || '';
      const isRate    = msg.includes('429') || msg.includes('rate_limit');
      const isTimeout = msg.includes('timeout');
      const isToolErr = msg.includes('tool_use_failed') || msg.includes('Failed to call');
      if (isToolErr) throw e;
      if ((isRate || isTimeout) && attempt < retries) {
        const wait = isRate
          ? (() => { const m = msg.match(/try again in ([0-9.]+)s/i); return m ? Math.ceil(parseFloat(m[1])*1000)+600 : 10000; })()
          : 4000;
        sysLog('warn','groq',`${isRate?'Rate':'Timeout'} on ${params.model} wait ${Math.round(wait/1000)}s attempt ${attempt+1}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

// ─── Data layer ────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, 'data');
['sessions','memory','skills','automations','files','personas','agents','tasks','logs','knowledge','experiments','metrics']
  .forEach(d => fs.ensureDirSync(path.join(DATA, d)));
fs.ensureDirSync(path.join(__dirname, 'uploads'));

function jload(p, def={}) { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return def; } }
function jsave(p, v) { fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p, JSON.stringify(v,null,2)); }
function sysLog(level, src, msg, data=null) {
  try {
    const lf = path.join(DATA,'logs', new Date().toISOString().slice(0,10)+'.json');
    const logs = jload(lf, []);
    logs.push({ id:uuidv4(), ts:new Date().toISOString(), level, src, msg, data });
    if (logs.length > 5000) logs.splice(0, logs.length-5000);
    jsave(lf, logs);
  } catch {}
}
function cleanMsg(m) {
  const out = { role: m.role, content: m.content ?? null };
  if (m.tool_calls)   out.tool_calls   = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name)         out.name         = m.name;
  return out;
}
function parseArgs(raw) { try { return typeof raw==='string'?JSON.parse(raw):(raw||{}); } catch { return {}; } }
function formatUptime(s) { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60); return `${h}h ${m}m ${sec}s`; }

// ─── Memory ────────────────────────────────────────────────────────────────
const MEM_FILE = path.join(DATA,'memory','global.json');
let MEM = jload(MEM_FILE, {facts:[],preferences:[],projects:[],notes:[],people:[],knowledge:[],decisions:[]});
function saveMem() { jsave(MEM_FILE, MEM); }
function memAdd(type, content) {
  if (!MEM[type]) MEM[type]=[];
  if (MEM[type].some(i=>i.content===content)) return null;
  const e = {id:uuidv4(),content,ts:new Date().toISOString()};
  MEM[type].push(e);
  if (MEM[type].length>1000) MEM[type]=MEM[type].slice(-1000);
  saveMem(); return e;
}
function memSearch(q) {
  const ql=q.toLowerCase(),res=[];
  Object.entries(MEM).forEach(([type,items])=>{
    if (!Array.isArray(items)) return;
    items.forEach(i=>{ if(i.content?.toLowerCase().includes(ql)) res.push({type,...i}); });
  });
  return res.slice(0,25);
}
function memCtx() {
  return Object.entries(MEM).filter(([,v])=>Array.isArray(v)&&v.length)
    .map(([k,v])=>`[${k}]: ${v.slice(-5).map(i=>i.content).join(' | ')}`).join('\n');
}

// ─── Knowledge Graph ───────────────────────────────────────────────────────
const KG_FILE = path.join(DATA,'knowledge','graph.json');
let KG = jload(KG_FILE, {nodes:[],edges:[]});
function kgSave() { jsave(KG_FILE,KG); }
function kgAddNode(label, type) {
  if (KG.nodes.find(n=>n.label===label)) return;
  KG.nodes.push({id:uuidv4(),label,type,ts:new Date().toISOString()});
  if (KG.nodes.length>5000) KG.nodes.splice(0,KG.nodes.length-5000);
  kgSave();
}
function kgAddEdge(from,to,rel) {
  KG.edges.push({id:uuidv4(),from,to,rel,ts:new Date().toISOString()});
  if (KG.edges.length>10000) KG.edges.splice(0,KG.edges.length-10000);
  kgSave();
}

// ─── Skills ────────────────────────────────────────────────────────────────
const SKILLS_FILE = path.join(DATA,'skills','registry.json');
let SKILLS = jload(SKILLS_FILE, {});
function skillSave() { jsave(SKILLS_FILE,SKILLS); }

// ─── Agents ────────────────────────────────────────────────────────────────
const AGENT_DEFS = {
  orchestrator: { name:'Orchestrator',  emoji:'🧠', role:'orchestrator',  model:'llama-3.3-70b-versatile', desc:'Coordinates all agents. Decomposes complex goals and delegates to specialists.' },
  researcher:   { name:'Researcher',    emoji:'🔍', role:'researcher',    model:'llama-3.1-8b-instant',    desc:'Web search, data gathering, fact verification.' },
  coder:        { name:'Code Engineer', emoji:'💻', role:'coder',         model:'llama-3.3-70b-versatile', desc:'Writes, reviews, debugs, and optimizes code in any language.' },
  analyst:      { name:'Analyst',       emoji:'📊', role:'analyst',       model:'mixtral-8x7b-32768',      desc:'Data analysis, pattern recognition, statistical insights.' },
  writer:       { name:'Writer',        emoji:'✍️', role:'writer',        model:'llama-3.3-70b-versatile', desc:'Content creation, copywriting, documentation, reports.' },
  planner:      { name:'Planner',       emoji:'📋', role:'planner',       model:'llama-3.1-8b-instant',   desc:'Task decomposition, dependency mapping, timeline estimation.' },
  critic:       { name:'Critic',        emoji:'🎯', role:'critic',        model:'mixtral-8x7b-32768',      desc:'Quality assurance, error detection, improvement suggestions.' },
  memory_agent: { name:'Memory Agent',  emoji:'💾', role:'memory_agent',  model:'llama-3.1-8b-instant',   desc:'Knowledge storage, retrieval, context compression.' },
  executor:     { name:'Executor',      emoji:'⚡', role:'executor',      model:'llama-3.1-8b-instant',   desc:'Runs tools, executes tasks, manages file operations.' },
  monitor:      { name:'Monitor',       emoji:'📡', role:'monitor',       model:'llama-3.1-8b-instant',   desc:'System health, performance metrics, anomaly detection.' },
  optimizer:    { name:'Optimizer',     emoji:'🔧', role:'optimizer',     model:'mixtral-8x7b-32768',      desc:'Performance analysis, architecture improvements.' },
};
const AGENTS_FILE = path.join(DATA,'agents','registry.json');
let AGENTS = jload(AGENTS_FILE, {});
(function seedAgents(){
  let changed=false;
  Object.entries(AGENT_DEFS).forEach(([role,def])=>{
    if (!AGENTS[role]) { AGENTS[role]={id:uuidv4(),...def,status:'idle',tasksCompleted:0,tasksRunning:0,errors:0,created:new Date().toISOString(),lastActive:null}; changed=true; }
  });
  if (changed) jsave(AGENTS_FILE,AGENTS);
})();
function agentList() {
  return Object.values(AGENTS).map(a=>({id:a.id,role:a.role,name:a.name,emoji:a.emoji,desc:a.desc,status:a.status,tasksCompleted:a.tasksCompleted,tasksRunning:a.tasksRunning,errors:a.errors,lastActive:a.lastActive,model:a.model}));
}
function agentUpdate(role, upd) {
  if (AGENTS[role]) { Object.assign(AGENTS[role],upd,{lastActive:new Date().toISOString()}); jsave(AGENTS_FILE,AGENTS); }
}

// ─── Tasks ─────────────────────────────────────────────────────────────────
const TASKS_FILE = path.join(DATA,'tasks','registry.json');
let TASKS = jload(TASKS_FILE, {});
function taskSave() { jsave(TASKS_FILE,TASKS); }
function taskMake(missionId, role, desc, priority='normal') {
  const t={id:uuidv4(),missionId,role,desc,priority,status:'pending',result:null,error:null,created:new Date().toISOString(),started:null,completed:null,toolsUsed:[]};
  TASKS[t.id]=t; taskSave(); return t;
}
function taskList() { return Object.values(TASKS).sort((a,b)=>new Date(b.created)-new Date(a.created)).slice(0,200); }

// ─── Experiments ───────────────────────────────────────────────────────────
const EXP_FILE = path.join(DATA,'experiments','registry.json');
let EXPERIMENTS = jload(EXP_FILE, {});
function expSave() { jsave(EXP_FILE,EXPERIMENTS); }
function expAdd(name,hypothesis,params) {
  const e={id:uuidv4(),name,hypothesis,params,status:'pending',results:null,score:null,created:new Date().toISOString()};
  EXPERIMENTS[e.id]=e; expSave(); return e;
}

// ─── Metrics ───────────────────────────────────────────────────────────────
const METRICS_FILE = path.join(DATA,'metrics','history.json');
let METRICS = jload(METRICS_FILE, []);
function metricsRecord(data) {
  METRICS.push({ts:new Date().toISOString(),...data});
  if (METRICS.length>10000) METRICS=METRICS.slice(-10000);
  jsave(METRICS_FILE,METRICS);
}

// ─── Sessions ──────────────────────────────────────────────────────────────
const SESSIONS = {};
function sessionGet(id) {
  if (!SESSIONS[id]) {
    const f = path.join(DATA,'sessions',`${id}.json`);
    SESSIONS[id] = fs.existsSync(f)
      ? jload(f,{id,title:'New Conversation',messages:[],model:'llama-3.3-70b-versatile',personaId:'default',created:new Date().toISOString()})
      : {id,title:'New Conversation',messages:[],model:'llama-3.3-70b-versatile',personaId:'default',created:new Date().toISOString()};
  }
  return SESSIONS[id];
}
function sessionSave(id) {
  const s=SESSIONS[id]; if (!s) return;
  s.updatedAt=new Date().toISOString(); s.messageCount=s.messages.length;
  jsave(path.join(DATA,'sessions',`${id}.json`),s);
}
function sessionList() {
  const dir=path.join(DATA,'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f=>f.endsWith('.json'))
    .map(f=>jload(path.join(dir,f))).filter(s=>s.id)
    .sort((a,b)=>new Date(b.updatedAt||b.created)-new Date(a.updatedAt||a.created))
    .slice(0,100)
    .map(s=>({id:s.id,title:s.title,messageCount:s.messageCount||0,model:s.model,created:s.created,updatedAt:s.updatedAt}));
}

// ─── Personas ──────────────────────────────────────────────────────────────
const PERSONAS_FILE = path.join(DATA,'personas','registry.json');
const DEFAULT_PERSONAS = {
  default:    { id:'default',    name:'AGII',          emoji:'🤖', description:'General-purpose AI agent', model:'llama-3.3-70b-versatile', temperature:0.7,
    systemPrompt:`You are AGII, a powerful multi-agent AI platform. You are helpful, precise, proactive, and always use tools when they add value.\n\nCRITICAL RULES:\n- Use web_search for anything requiring current/real-time info\n- Use execute_code for calculations, algorithms, data processing (specify language: javascript or python)\n- Use spawn_agent to delegate specialized work\n- Use remember/recall for persistent information\n- Never make up facts — search instead\n- Be thorough and complete in every response` },
  researcher: { id:'researcher', name:'Research Mode', emoji:'🔍', description:'Deep research specialist', model:'llama-3.1-8b-instant', temperature:0.3,
    systemPrompt:'You are a research specialist. Always search the web for current information. Cite sources. Provide comprehensive, fact-based analysis.' },
  coder:      { id:'coder',      name:'Code Mode',     emoji:'💻', description:'Programming assistant',   model:'llama-3.3-70b-versatile', temperature:0.2,
    systemPrompt:'You are an expert software engineer. Write clean, production-ready code. Specify language in execute_code calls (javascript or python). Verify code works.' },
  analyst:    { id:'analyst',    name:'Analysis Mode', emoji:'📊', description:'Data analysis & insights', model:'mixtral-8x7b-32768', temperature:0.3,
    systemPrompt:'You are a data analyst. Break down complex problems, find patterns, provide actionable insights backed by calculations.' },
};
let PERSONAS = jload(PERSONAS_FILE, DEFAULT_PERSONAS);
if (!PERSONAS.default) PERSONAS = { ...DEFAULT_PERSONAS, ...PERSONAS };
function personaSave() { jsave(PERSONAS_FILE,PERSONAS); }

// ─── Code execution: Python via child_process ─────────────────────────────
function executePython(code) {
  return new Promise((resolve) => {
    const tmpFile = path.join('/tmp', `agii_py_${uuidv4().slice(0,8)}.py`);
    fs.writeFileSync(tmpFile, code, 'utf8');
    exec(`timeout 15 python3 "${tmpFile}"`, { timeout: 16000 }, (err, stdout, stderr) => {
      try { fs.removeSync(tmpFile); } catch {}
      if (err && !stdout) {
        resolve({ success: false, error: (stderr || err.message).slice(0,2000) });
      } else {
        resolve({ success: true, result: stdout.trim().slice(0,10000), stdout: stdout.trim(), stderr: (stderr||'').slice(0,500) });
      }
    });
  });
}

// ─── Code execution: JavaScript in secure sandbox ─────────────────────────
async function executeJS(code) {
  const logs = [];
  const con = {
    log:   (...a) => logs.push(a.map(x=>typeof x==='object'?JSON.stringify(x,null,2):String(x)).join(' ')),
    error: (...a) => logs.push('ERR: '+a.join(' ')),
    warn:  (...a) => logs.push('WARN: '+a.join(' ')),
    table: (...a) => logs.push(JSON.stringify(a)),
  };
  const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AsyncFn(
    'console','Math','Date','JSON','Array','Object','String','Number',
    'Boolean','parseInt','parseFloat','isNaN','isFinite','Promise',
    'Map','Set','RegExp','Error','Symbol','BigInt',
    code
  );
  const result = await Promise.race([
    fn(con,Math,Date,JSON,Array,Object,String,Number,Boolean,parseInt,parseFloat,isNaN,isFinite,Promise,Map,Set,RegExp,Error,Symbol,BigInt),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('JS execution timeout (10s)')),10000))
  ]);
  const output = logs.length > 0 ? logs.join('\n') : (result !== undefined ? String(result) : 'Executed successfully (no output)');
  return { success: true, result: output, logs };
}

// ─── Tools definition ─────────────────────────────────────────────────────
const TOOLS = [
  { type:'function', function:{ name:'web_search',       description:'Search the web for current information, news, facts, data. Use this whenever you need up-to-date or real-world information.', parameters:{ type:'object', properties:{ query:{type:'string'}, count:{type:'integer',default:8} }, required:['query'] } } },
  { type:'function', function:{ name:'fetch_url',        description:'Fetch and read the full content of a webpage or URL.', parameters:{ type:'object', properties:{ url:{type:'string'} }, required:['url'] } } },
  { type:'function', function:{ name:'execute_code',     description:'Execute JavaScript or Python code. ALWAYS specify language. Use for calculations, algorithms, data processing. Write complete runnable code.', parameters:{ type:'object', properties:{ code:{type:'string',description:'Complete runnable code'}, language:{type:'string',enum:['javascript','python']}, description:{type:'string'} }, required:['code','language','description'] } } },
  { type:'function', function:{ name:'remember',         description:'Store important information in persistent memory.', parameters:{ type:'object', properties:{ type:{type:'string',enum:['facts','preferences','projects','notes','people','knowledge','decisions']}, content:{type:'string'} }, required:['type','content'] } } },
  { type:'function', function:{ name:'recall',           description:'Search persistent memory for previously stored information.', parameters:{ type:'object', properties:{ query:{type:'string'} }, required:['query'] } } },
  { type:'function', function:{ name:'write_file',       description:'Create or write a file with content.', parameters:{ type:'object', properties:{ filename:{type:'string'}, content:{type:'string'} }, required:['filename','content'] } } },
  { type:'function', function:{ name:'read_file',        description:'Read content of a stored file.', parameters:{ type:'object', properties:{ filename:{type:'string'} }, required:['filename'] } } },
  { type:'function', function:{ name:'list_files',       description:'List all stored files.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'create_skill',     description:'Create a reusable skill/function for later use.', parameters:{ type:'object', properties:{ name:{type:'string'}, description:{type:'string'}, code:{type:'string'} }, required:['name','description','code'] } } },
  { type:'function', function:{ name:'run_skill',        description:'Run a previously created skill.', parameters:{ type:'object', properties:{ name:{type:'string'}, args:{type:'object'} }, required:['name'] } } },
  { type:'function', function:{ name:'list_skills',      description:'List all available skills.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'spawn_agent',      description:'Delegate a task to a specialist agent. Roles: orchestrator,researcher,coder,analyst,writer,planner,critic,memory_agent,executor,monitor,optimizer', parameters:{ type:'object', properties:{ role:{type:'string'}, task:{type:'string',description:'Detailed task description'} }, required:['role','task'] } } },
  { type:'function', function:{ name:'reason_and_plan',  description:'Deep step-by-step reasoning and structured planning for complex problems.', parameters:{ type:'object', properties:{ problem:{type:'string'} }, required:['problem'] } } },
  { type:'function', function:{ name:'analyze_image',    description:'Analyze an image from a URL using vision AI.', parameters:{ type:'object', properties:{ url:{type:'string'}, question:{type:'string'} }, required:['url'] } } },
  { type:'function', function:{ name:'calculate',        description:'Evaluate a precise mathematical expression.', parameters:{ type:'object', properties:{ expression:{type:'string'} }, required:['expression'] } } },
  { type:'function', function:{ name:'get_current_time', description:'Get current date and time.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'create_automation',description:'Create a scheduled cron automation.', parameters:{ type:'object', properties:{ name:{type:'string'}, task:{type:'string'}, cron:{type:'string',description:'Standard cron e.g. "0 9 * * 1-5"'} }, required:['name','task','cron'] } } },
  { type:'function', function:{ name:'get_system_stats', description:'Get AGII system stats and status.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'add_knowledge',    description:'Add a node to the knowledge graph.', parameters:{ type:'object', properties:{ label:{type:'string'}, type:{type:'string'}, relatesTo:{type:'string'} }, required:['label','type'] } } },
  { type:'function', function:{ name:'run_benchmark',    description:'Run a performance benchmark test.', parameters:{ type:'object', properties:{ test:{type:'string'}, prompt:{type:'string'} }, required:['test','prompt'] } } },
];
const SUB_TOOLS = TOOLS.filter(t=>t.function.name!=='spawn_agent');

// ─── Tool executor ─────────────────────────────────────────────────────────
async function execTool(name, args, sessionId, depth=0) {
  try {
    switch(name) {
      case 'web_search': {
        const q = encodeURIComponent(args.query);
        const count = args.count || 8;
        try {
          const { data } = await axios.get(`https://ddg-api.herokuapp.com/search?query=${q}&limit=${count}`, {timeout:10000});
          return { success:true, query:args.query, count:data.length, results:data };
        } catch {
          try {
            const cheerio = require('cheerio');
            const { data: html } = await axios.get(`https://html.duckduckgo.com/html/?q=${q}`, {
              timeout:12000, headers:{'User-Agent':'Mozilla/5.0 (compatible; AGII/14.0)'}
            });
            const $ = cheerio.load(html);
            const results = [];
            $('.result').slice(0,count).each((i,el)=>{
              const title   = $(el).find('.result__title').text().trim();
              const snippet = $(el).find('.result__snippet').text().trim();
              const url     = $(el).find('.result__url').text().trim();
              if (title) results.push({title,snippet,url});
            });
            return { success:true, query:args.query, count:results.length, results };
          } catch(e2) {
            return { success:true, query:args.query, count:1, results:[{title:`Search: ${args.query}`, snippet:'Search temporarily unavailable. Try fetch_url on a specific site.', url:`https://www.google.com/search?q=${q}`}] };
          }
        }
      }

      case 'fetch_url': {
        const cheerio = require('cheerio');
        const { data } = await axios.get(args.url, {
          timeout:15000, headers:{'User-Agent':'Mozilla/5.0 (compatible; AGII/14.0)'}, maxRedirects:5
        });
        const $ = cheerio.load(data);
        $('script,style,nav,footer,header,aside,.ad,.advertisement,.cookie-banner').remove();
        const text  = $('body').text().replace(/\s+/g,' ').trim().slice(0,15000);
        const title = $('title').text().trim();
        return { success:true, url:args.url, title, length:text.length, content:text };
      }

      case 'execute_code': {
        const lang = (args.language||'javascript').toLowerCase();
        try {
          if (lang==='python'||lang==='py') {
            const r = await executePython(args.code);
            return { ...r, language:'python', description:args.description };
          } else {
            const r = await executeJS(args.code);
            return { ...r, language:'javascript', description:args.description };
          }
        } catch(e) {
          return { success:false, error:e.message, language:lang };
        }
      }

      case 'remember':  { const e=memAdd(args.type,args.content); return {success:true,stored:!!e,type:args.type,content:args.content}; }
      case 'recall':    { const r=memSearch(args.query); return {success:true,found:r.length,results:r}; }

      case 'write_file': {
        const fp = path.join(DATA,'files',path.basename(args.filename));
        fs.writeFileSync(fp,args.content,'utf8');
        return {success:true,filename:args.filename,bytes:args.content.length,downloadUrl:`/api/files/${args.filename}`};
      }
      case 'read_file': {
        const fp = path.join(DATA,'files',path.basename(args.filename));
        if (!fs.existsSync(fp)) return {success:false,error:'File not found'};
        return {success:true,filename:args.filename,content:fs.readFileSync(fp,'utf8').slice(0,100000)};
      }
      case 'list_files': {
        const dir=path.join(DATA,'files');
        const files=fs.existsSync(dir)?fs.readdirSync(dir).map(f=>{const s=fs.statSync(path.join(dir,f));return{name:f,size:s.size,created:s.birthtime};}):[]; 
        return {success:true,count:files.length,files};
      }

      case 'create_skill': {
        SKILLS[args.name]={name:args.name,description:args.description,code:args.code,created:new Date().toISOString(),runCount:0};
        skillSave(); return {success:true,name:args.name};
      }
      case 'run_skill': {
        const sk=SKILLS[args.name];
        if (!sk) return {success:false,error:`Skill '${args.name}' not found`};
        try {
          sk.runCount=(sk.runCount||0)+1; skillSave();
          const AsyncFn=Object.getPrototypeOf(async function(){}).constructor;
          const logs=[];
          const con={log:(...a)=>logs.push(a.join(' ')),error:(...a)=>logs.push('ERR:'+a.join(' '))};
          const fn=new AsyncFn('args','Math','Date','JSON','console',sk.code);
          const result=await fn(args.args||{},Math,Date,JSON,con);
          return {success:true,skill:args.name,result:String(result??''),logs};
        } catch(e) { return {success:false,skill:args.name,error:e.message}; }
      }
      case 'list_skills': {
        return {success:true,count:Object.keys(SKILLS).length,skills:Object.values(SKILLS).map(s=>({name:s.name,description:s.description,runCount:s.runCount||0}))};
      }

      case 'spawn_agent': {
        if (depth>=2) return {success:false,error:'Max agent depth reached. Complete directly.'};
        const role=args.role||'researcher';
        const agent=AGENTS[role];
        if (!agent) return {success:false,error:`Unknown role: ${role}. Valid: ${Object.keys(AGENT_DEFS).join(', ')}`};
        const task=taskMake(sessionId,role,args.task);
        const result=await runAgentTask(task,sessionId,null,depth+1);
        return {success:true,role,agentName:agent.name,emoji:agent.emoji,result:result.result||result.error||'No result'};
      }

      case 'reason_and_plan': {
        const c=await groqCall({
          model:'llama-3.3-70b-versatile',
          messages:[
            {role:'system',content:'You are a deep reasoning engine. Think step by step. Produce clear structured plans with specific action items.'},
            {role:'user',content:`Problem: ${args.problem}\n\nProvide:\n1. Problem analysis\n2. Key constraints\n3. Step-by-step plan\n4. Risk assessment\n5. Success criteria`}
          ],
          temperature:0.2, max_tokens:3000
        });
        return {success:true,reasoning:c.choices[0].message.content};
      }

      case 'analyze_image': {
        const c=await groqCall({
          model:'meta-llama/llama-4-scout-17b-16e-instruct',
          messages:[{role:'user',content:[
            {type:'image_url',image_url:{url:args.url}},
            {type:'text',text:args.question||'Describe this image in complete detail.'}
          ]}],
          max_tokens:2048
        });
        return {success:true,analysis:c.choices[0].message.content};
      }

      case 'calculate': {
        try {
          const safe = args.expression.replace(/[^0-9+\-*/().^%,\s]/g,'');
          const result = Function('"use strict"; return ('+safe+')')();
          return {success:true,expression:args.expression,result,formatted:result.toLocaleString()};
        } catch(e) { return {success:false,expression:args.expression,error:e.message}; }
      }

      case 'get_current_time': {
        const n=new Date();
        return {success:true,iso:n.toISOString(),utc:n.toUTCString(),unix:n.getTime(),date:n.toDateString(),time:n.toTimeString()};
      }

      case 'create_automation': {
        if (!cron.validate(args.cron)) return {success:false,error:`Invalid cron: ${args.cron}`};
        const id=uuidv4();
        const au={id,name:args.name,task:args.task,cron:args.cron,active:true,created:new Date().toISOString(),runCount:0,lastRun:null,lastResult:null};
        AUTOS[id]=au; autoSave(); autoSchedule(au);
        return {success:true,id,name:args.name,cron:args.cron};
      }

      case 'get_system_stats': {
        const sessions=sessionList();
        const totalMsgs=sessions.reduce((s,x)=>s+(x.messageCount||0),0);
        const memTotal=Object.values(MEM).reduce((s,a)=>s+(Array.isArray(a)?a.length:0),0);
        return {
          success:true, version:'14.0',
          uptime:formatUptime(process.uptime()),
          sessions:sessions.length, totalMessages:totalMsgs,
          memoryItems:memTotal, skills:Object.keys(SKILLS).length,
          automations:Object.keys(AUTOS).length, agents:Object.keys(AGENTS).length,
          tasks:Object.keys(TASKS).length, knowledgeNodes:KG.nodes.length,
          experiments:Object.keys(EXPERIMENTS).length,
          memory_mb:Math.round(process.memoryUsage().heapUsed/1024/1024),
        };
      }

      case 'add_knowledge': {
        kgAddNode(args.label,args.type||'concept');
        if (args.relatesTo) kgAddEdge(args.label,args.relatesTo,'relates_to');
        return {success:true,added:args.label,type:args.type};
      }

      case 'run_benchmark': {
        const start=Date.now();
        const c=await groqCall({
          model:'llama-3.1-8b-instant',
          messages:[
            {role:'system',content:`You are being benchmarked on ${args.test}.`},
            {role:'user',content:args.prompt}
          ],
          temperature:0.1, max_tokens:1024
        });
        const latency=Date.now()-start;
        const tokens=c.usage?.total_tokens||0;
        const result={test:args.test,latency_ms:latency,tokens,tps:Math.round(tokens/(latency/1000)),answer:c.choices[0].message.content,timestamp:new Date().toISOString()};
        metricsRecord({type:'benchmark',...result});
        return {success:true,...result};
      }

      default: return {success:false,error:`Unknown tool: ${name}`};
    }
  } catch(e) {
    sysLog('error','tool',`${name}: ${e.message}`);
    return {success:false,tool:name,error:e.message};
  }
}

// ─── Automations ───────────────────────────────────────────────────────────
const AUTO_FILE = path.join(DATA,'automations','registry.json');
let AUTOS = jload(AUTO_FILE, {});
const CRONS = {};
function autoSave() { jsave(AUTO_FILE,AUTOS); }
function autoSchedule(a) {
  if (CRONS[a.id]) { CRONS[a.id].stop(); delete CRONS[a.id]; }
  if (!a.active||!a.cron) return;
  try {
    CRONS[a.id]=cron.schedule(a.cron, async()=>{
      a.lastRun=new Date().toISOString(); a.runCount=(a.runCount||0)+1; autoSave();
      sysLog('info','cron',`Running: ${a.name}`);
      const sid=uuidv4(); const sess=sessionGet(sid);
      sess.messages.push({role:'user',content:a.task,ts:new Date().toISOString()});
      try { const r=await agentLoop(sess,sid,null,'orchestrator'); a.lastResult=r.slice(0,500); }
      catch(e) { a.lastResult=`Error: ${e.message}`; }
      autoSave();
    });
  } catch(e) { sysLog('error','cron',`Failed to schedule ${a.name}: ${e.message}`); }
}
Object.values(AUTOS).filter(a=>a.active).forEach(autoSchedule);

// ─── Sub-agent runner ──────────────────────────────────────────────────────
async function runAgentTask(task, sessionId, send, depth=1) {
  const agent=AGENTS[task.role]||AGENTS['researcher'];
  task.status='running'; task.started=new Date().toISOString(); taskSave();
  agentUpdate(task.role,{status:'working',tasksRunning:(agent.tasksRunning||0)+1});
  if (send) send({type:'agent_start',role:task.role,name:agent.name,emoji:agent.emoji,task:task.desc});

  const messages=[
    {role:'system',content:`You are ${agent.name} ${agent.emoji}. ${agent.desc}\nDate: ${new Date().toISOString()}\nComplete your task thoroughly. Use tools proactively.`},
    {role:'user',content:task.desc}
  ];
  let result=''; let itr=0;
  try {
    while (itr<8) {
      itr++;
      let comp;
      try {
        comp=await groqCall({model:agent.model||'llama-3.1-8b-instant',messages,tools:SUB_TOOLS,tool_choice:'auto',temperature:0.4,max_tokens:3000});
      } catch(e) {
        if (e.message?.includes('tool_use_failed')||e.message?.includes('Failed to call')) {
          comp=await groqCall({model:'llama-3.1-8b-instant',messages:messages.filter(m=>m.role!=='tool'),temperature:0.4,max_tokens:2000});
        } else throw e;
      }
      const choice=comp.choices[0]; const msg=choice.message;
      messages.push(cleanMsg(msg));
      if (choice.finish_reason==='tool_calls'&&msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const targs=parseArgs(tc.function.arguments);
          if (send) send({type:'agent_tool',role:task.role,name:agent.name,emoji:agent.emoji,tool:tc.function.name});
          task.toolsUsed.push(tc.function.name);
          const tres=await execTool(tc.function.name,targs,sessionId,depth);
          messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(tres).slice(0,8000)});
        }
      } else { result=msg.content||''; break; }
    }
    task.status='completed'; task.result=result; task.completed=new Date().toISOString(); taskSave();
    agentUpdate(task.role,{status:'idle',tasksCompleted:(agent.tasksCompleted||0)+1,tasksRunning:Math.max(0,(agent.tasksRunning||1)-1)});
    if (send) send({type:'agent_done',role:task.role,name:agent.name,emoji:agent.emoji,result:result.slice(0,300)});
    return {success:true,result};
  } catch(e) {
    task.status='failed'; task.error=e.message; taskSave();
    agentUpdate(task.role,{status:'idle',errors:(agent.errors||0)+1,tasksRunning:Math.max(0,(agent.tasksRunning||1)-1)});
    sysLog('error','agent',`${agent.name}: ${e.message}`);
    return {success:false,error:e.message};
  }
}

// ─── Main agent loop ───────────────────────────────────────────────────────
async function agentLoop(session, sessionId, send, role='orchestrator') {
  const agent  = AGENTS[role]||AGENTS['orchestrator'];
  const persona= PERSONAS[session.personaId]||PERSONAS['default'];
  const mem    = memCtx();
  const sysPrompt = `${persona.systemPrompt}\n\nAgent: ${agent.name} ${agent.emoji}\nTime: ${new Date().toISOString()}${mem?'\n\nMemory:\n'+mem:''}\n\nAgents available via spawn_agent:\n${agentList().map(a=>`• ${a.role}: ${a.desc}`).join('\n')}`;
  const messages = [{role:'system',content:sysPrompt}, ...session.messages.slice(-50).map(cleanMsg)];
  let finalText=''; let itr=0;
  const preferred = session.model||persona.model||'llama-3.3-70b-versatile';
  const modelOrder = [preferred,...['llama-3.1-8b-instant','mixtral-8x7b-32768','gemma2-9b-it'].filter(m=>m!==preferred)];

  while (itr<12) {
    itr++;
    let comp; let lastErr;
    for (const tryModel of modelOrder) {
      try {
        comp=await groqCall({model:tryModel,messages,tools:TOOLS,tool_choice:'auto',temperature:persona.temperature||0.7,max_tokens:4096});
        break;
      } catch(e) {
        lastErr=e;
        sysLog('warn','loop',`Model ${tryModel} failed: ${e.message?.slice(0,100)}`);
        if (e.message?.includes('tool_use_failed')||e.message?.includes('Failed to call')) {
          try {
            comp=await groqCall({model:'llama-3.1-8b-instant',messages:messages.filter(m=>m.role!=='tool'),temperature:0.7,max_tokens:4096});
            break;
          } catch(e2) { lastErr=e2; }
        }
      }
    }
    if (!comp) throw lastErr||new Error('All models failed');
    const choice=comp.choices[0]; const msg=choice.message;
    messages.push(cleanMsg(msg));
    if (choice.finish_reason==='tool_calls'&&msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const targs=parseArgs(tc.function.arguments);
        if (send) send({type:'tool_start',tool:tc.function.name,args:targs});
        const tres=await execTool(tc.function.name,targs,sessionId,0);
        if (send) send({type:'tool_result',tool:tc.function.name,result:tres});
        messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(tres).slice(0,10000)});
      }
    } else { finalText=msg.content||''; break; }
  }
  return finalText;
}

// ─── API Routes ────────────────────────────────────────────────────────────
app.get('/health', (req,res)=>res.json({status:'ok',version:'14.0',uptime:Math.floor(process.uptime()),agents:Object.keys(AGENTS).length,timestamp:new Date().toISOString()}));
app.get('/',       (req,res)=>res.json({name:'AGII',version:'14.0',status:'running',agents:Object.keys(AGENTS).length}));

// Sessions
app.get('/api/sessions',           (req,res)=>res.json(sessionList()));
app.get('/api/sessions/:id',       (req,res)=>res.json(sessionGet(req.params.id)));
app.patch('/api/sessions/:id',     (req,res)=>{ const s=sessionGet(req.params.id); Object.assign(s,req.body); sessionSave(req.params.id); res.json({success:true,session:s}); });
app.delete('/api/sessions/:id',    (req,res)=>{ const f=path.join(DATA,'sessions',`${req.params.id}.json`); if(fs.existsSync(f))fs.removeSync(f); delete SESSIONS[req.params.id]; res.json({success:true}); });

// Chat SSE
app.post('/api/chat', async(req,res)=>{
  const {message,sessionId,model,personaId,imageUrl,role}=req.body;
  if (!message||!sessionId) return res.status(400).json({error:'message and sessionId required'});
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  const sse=(data)=>{ try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
  try {
    const session=sessionGet(sessionId);
    if (model)     session.model=model;
    if (personaId) session.personaId=personaId;
    let userContent=message;
    if (imageUrl) userContent=[{type:'image_url',image_url:{url:imageUrl}},{type:'text',text:message}];
    session.messages.push({role:'user',content:userContent,ts:new Date().toISOString()});
    if (!session.title||session.title==='New Conversation') session.title=message.slice(0,80)+(message.length>80?'…':'');
    sse({type:'start',sessionId,title:session.title});
    const finalText=await agentLoop(session,sessionId,sse,role||'orchestrator');
    const words=finalText.split(/(\s+)/);
    for (let i=0;i<words.length;i++) { sse({type:'token',text:words[i]}); if(i%8===0) await new Promise(r=>setImmediate(r)); }
    session.messages.push({role:'assistant',content:finalText,ts:new Date().toISOString()});
    sessionSave(sessionId);
    sysLog('info','chat',`${sessionId.slice(0,8)}: ${message.slice(0,80)}`);
    sse({type:'done',sessionId,title:session.title});
    res.end();
  } catch(e) {
    sysLog('error','chat',e.message);
    sse({type:'error',message:e.message});
    res.end();
  }
});

// Mission
app.post('/api/mission', async(req,res)=>{
  const {goal,agents:requestedAgents}=req.body;
  if (!goal) return res.status(400).json({error:'goal required'});
  const missionId=uuidv4();
  const agentRoles=requestedAgents||['planner','researcher','coder','writer','critic'];
  try {
    const planTask=taskMake(missionId,'planner',`Decompose into ${agentRoles.length} specific numbered subtasks for: ${goal}`);
    const planResult=await runAgentTask(planTask,missionId,null);
    const subtasks=(planResult.result||goal).split('\n').filter(l=>l.trim().length>10).map(l=>l.replace(/^[\d\.\-\*\)]+\s*/,'').trim()).filter(l=>l.length>5).slice(0,agentRoles.length);
    const tasks=agentRoles.slice(0,subtasks.length).map((role,i)=>taskMake(missionId,role,subtasks[i]||`Handle part ${i+1} of: ${goal}`));
    const results=await Promise.allSettled(tasks.map(t=>runAgentTask(t,missionId,null)));
    const allResults=results.map((r,i)=>`**${tasks[i].role}:** ${r.status==='fulfilled'?r.value?.result?.slice(0,500):'Failed: '+r.reason}`).join('\n\n---\n\n');
    const synthesis=await groqCall({
      model:'llama-3.3-70b-versatile',
      messages:[
        {role:'system',content:'Synthesize these agent outputs into one coherent, comprehensive, well-structured response. Do not just list them — combine into a unified answer.'},
        {role:'user',content:`Goal: ${goal}\n\nAgent outputs:\n${allResults}\n\nFinal synthesis:`}
      ],
      temperature:0.3, max_tokens:4000
    });
    res.json({id:missionId,goal,status:'completed',tasks:tasks.map(t=>({id:t.id,role:t.role,status:t.status,result:t.result?.slice(0,300)})),synthesis:synthesis.choices[0].message.content,created:new Date().toISOString()});
  } catch(e) { sysLog('error','mission',e.message); res.status(500).json({error:e.message}); }
});

// Models
app.get('/api/models',(req,res)=>res.json([
  {id:'llama-3.3-70b-versatile',name:'Llama 3.3 70B',description:'Best overall — powerful & fast',badge:'Recommended',context:8192},
  {id:'llama-3.1-8b-instant',name:'Llama 3.1 8B',description:'Ultra-fast, efficient',badge:'Fast',context:8192},
  {id:'meta-llama/llama-4-scout-17b-16e-instruct',name:'Llama 4 Scout',description:'Vision + long context',badge:'Vision',context:131072},
  {id:'deepseek-r1-distill-llama-70b',name:'DeepSeek R1',description:'Deep chain-of-thought reasoning',badge:'Reasoning',context:8192},
  {id:'qwen-qwq-32b',name:'Qwen QwQ 32B',description:'Advanced math & reasoning',badge:'Math',context:32768},
  {id:'mixtral-8x7b-32768',name:'Mixtral 8x7B',description:'32K context window',badge:'Long Context',context:32768},
  {id:'gemma2-9b-it',name:'Gemma 2 9B',description:'Google — efficient & capable',badge:'Google',context:8192},
]));

// Agents
app.get('/api/agents',(req,res)=>res.json(agentList()));
app.post('/api/agents',(req,res)=>{
  const {role,name,emoji,desc,model}=req.body;
  if (!role||!name) return res.status(400).json({error:'role and name required'});
  AGENTS[role]={id:uuidv4(),role,name,emoji:emoji||'🤖',desc:desc||'',model:model||'llama-3.3-70b-versatile',status:'idle',tasksCompleted:0,tasksRunning:0,errors:0,created:new Date().toISOString(),lastActive:null};
  jsave(AGENTS_FILE,AGENTS); res.json({success:true,agent:AGENTS[role]});
});
app.delete('/api/agents/:role',(req,res)=>{
  if (AGENT_DEFS[req.params.role]) return res.status(400).json({error:'Cannot delete built-in agent'});
  delete AGENTS[req.params.role]; jsave(AGENTS_FILE,AGENTS); res.json({success:true});
});
app.post('/api/agents/:role/run',async(req,res)=>{
  const {task}=req.body;
  if (!task) return res.status(400).json({error:'task required'});
  const t=taskMake(uuidv4(),req.params.role,task);
  const result=await runAgentTask(t,uuidv4(),null);
  res.json({success:true,role:req.params.role,result:result.result,error:result.error,taskId:t.id});
});

// Tasks
app.get('/api/tasks',(req,res)=>res.json(taskList()));
app.get('/api/tasks/:id',(req,res)=>{ const t=TASKS[req.params.id]; if (!t) return res.status(404).json({error:'Not found'}); res.json(t); });

// Memory
app.get('/api/memory',(req,res)=>res.json(MEM));
app.post('/api/memory',(req,res)=>{ const e=memAdd(req.body.type,req.body.content); res.json({success:true,entry:e}); });
app.delete('/api/memory/:type/:id',(req,res)=>{ if(MEM[req.params.type])MEM[req.params.type]=MEM[req.params.type].filter(i=>i.id!==req.params.id); saveMem(); res.json({success:true}); });
app.delete('/api/memory',(req,res)=>{ MEM={facts:[],preferences:[],projects:[],notes:[],people:[],knowledge:[],decisions:[]}; saveMem(); res.json({success:true}); });

// Skills
app.get('/api/skills',(req,res)=>res.json(Object.values(SKILLS)));
app.delete('/api/skills/:name',(req,res)=>{ delete SKILLS[req.params.name]; skillSave(); res.json({success:true}); });
app.post('/api/skills/:name/run',async(req,res)=>{ const r=await execTool('run_skill',{name:req.params.name,args:req.body.args||{}},'api'); res.json(r); });

// Automations
app.get('/api/automations',(req,res)=>res.json(Object.values(AUTOS)));
app.post('/api/automations',(req,res)=>{
  const {name,task,cron:c}=req.body;
  if (!name||!task||!c) return res.status(400).json({error:'name, task, cron required'});
  if (!cron.validate(c)) return res.status(400).json({error:`Invalid cron: ${c}`});
  const id=uuidv4();
  AUTOS[id]={id,name,task,cron:c,active:true,created:new Date().toISOString(),runCount:0,lastRun:null,lastResult:null};
  autoSave(); autoSchedule(AUTOS[id]); res.json({success:true,automation:AUTOS[id]});
});
app.post('/api/automations/:id/toggle',(req,res)=>{ const a=AUTOS[req.params.id]; if(!a)return res.status(404).json({error:'Not found'}); a.active=!a.active; autoSave(); autoSchedule(a); res.json({success:true,active:a.active}); });
app.delete('/api/automations/:id',(req,res)=>{ if(CRONS[req.params.id]){CRONS[req.params.id].stop();delete CRONS[req.params.id];} delete AUTOS[req.params.id]; autoSave(); res.json({success:true}); });

// Personas
app.get('/api/personas',(req,res)=>res.json(Object.values(PERSONAS)));
app.post('/api/personas',(req,res)=>{ const id=uuidv4(); PERSONAS[id]={id,created:new Date().toISOString(),...req.body}; personaSave(); res.json({success:true,persona:PERSONAS[id]}); });
app.put('/api/personas/:id',(req,res)=>{ if(!PERSONAS[req.params.id])return res.status(404).json({error:'Not found'}); Object.assign(PERSONAS[req.params.id],req.body); personaSave(); res.json({success:true}); });
app.delete('/api/personas/:id',(req,res)=>{ if(req.params.id==='default')return res.status(400).json({error:'Cannot delete default'}); delete PERSONAS[req.params.id]; personaSave(); res.json({success:true}); });

// Knowledge
app.get('/api/knowledge',(req,res)=>res.json({nodes:KG.nodes.slice(-500),edges:KG.edges.slice(-500)}));
app.post('/api/knowledge',(req,res)=>{ kgAddNode(req.body.label,req.body.type||'concept'); if(req.body.relatesTo)kgAddEdge(req.body.label,req.body.relatesTo,req.body.relation||'relates_to'); res.json({success:true}); });

// Experiments
app.get('/api/experiments',(req,res)=>res.json(Object.values(EXPERIMENTS).sort((a,b)=>new Date(b.created)-new Date(a.created)).slice(0,100)));
app.post('/api/experiments',(req,res)=>{ const e=expAdd(req.body.name,req.body.hypothesis,req.body.params); res.json({success:true,experiment:e}); });
app.post('/api/experiments/:id/run',async(req,res)=>{
  const exp=EXPERIMENTS[req.params.id];
  if (!exp) return res.status(404).json({error:'Not found'});
  exp.status='running'; expSave();
  try {
    const results={};
    for (const b of ['reasoning','coding','planning','search','memory']) {
      const r=await execTool('run_benchmark',{test:b,prompt:exp.params?.prompt||exp.hypothesis},'experiment');
      results[b]={latency:r.latency_ms,tokens:r.tokens,tps:r.tps};
    }
    exp.results=results; exp.score=Object.values(results).reduce((s,x)=>s+(1000/(x.latency||1000)),0);
    exp.status='completed'; exp.completed=new Date().toISOString(); expSave();
    res.json({success:true,experiment:exp});
  } catch(e) { exp.status='failed'; exp.error=e.message; expSave(); res.status(500).json({error:e.message}); }
});

// Metrics & Logs & Files & Stats
app.get('/api/metrics',(req,res)=>res.json(METRICS.slice(-500)));
app.get('/api/logs',(req,res)=>{ try { const logs=jload(path.join(DATA,'logs',new Date().toISOString().slice(0,10)+'.json'),[]); res.json(logs.slice(-300).reverse()); } catch { res.json([]); } });
app.get('/api/files',(req,res)=>{ try { const dir=path.join(DATA,'files'); const files=fs.existsSync(dir)?fs.readdirSync(dir).map(f=>{const s=fs.statSync(path.join(dir,f));return{name:f,size:s.size,created:s.birthtime,url:`/api/files/${f}`};}):[]; res.json(files); } catch { res.json([]); } });
app.get('/api/files/:filename',(req,res)=>{ const fp=path.join(DATA,'files',path.basename(req.params.filename)); if(!fs.existsSync(fp))return res.status(404).json({error:'Not found'}); res.download(fp); });
app.post('/api/upload',upload.single('file'),(req,res)=>{ if(!req.file)return res.status(400).json({error:'No file'}); const dest=path.join(DATA,'files',req.file.originalname); fs.moveSync(req.file.path,dest,{overwrite:true}); res.json({success:true,filename:req.file.originalname,url:`/api/files/${req.file.originalname}`}); });
app.get('/api/stats',(req,res)=>{ const sessions=sessionList(); res.json({version:'14.0',sessions:sessions.length,totalMessages:sessions.reduce((s,x)=>s+(x.messageCount||0),0),memoryItems:Object.values(MEM).reduce((s,a)=>s+(Array.isArray(a)?a.length:0),0),skills:Object.keys(SKILLS).length,automations:Object.keys(AUTOS).length,agents:Object.keys(AGENTS).length,tasks:Object.keys(TASKS).length,knowledgeNodes:KG.nodes.length,experiments:Object.keys(EXPERIMENTS).length,uptime:Math.floor(process.uptime()),memory_mb:Math.round(process.memoryUsage().heapUsed/1024/1024)}); });

app.listen(PORT,()=>{ console.log(`🚀 AGII v14.0 on port ${PORT}`); sysLog('info','server','AGII v14.0 started on port '+PORT); });
