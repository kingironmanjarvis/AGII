require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const multer      = require('multer');
const { v4: uid } = require('uuid');
const Groq        = require('groq-sdk');
const axios       = require('axios');
const fs          = require('fs-extra');
const path        = require('path');
const cron        = require('node-cron');
const http        = require('http');

const app    = express();
const server = http.createServer(app);
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('tiny'));
app.use(rateLimit({ windowMs: 60000, max: 600 }));
const upload = multer({ dest: 'uploads/', limits: { fileSize: 50*1024*1024 } });

const DATA = path.join(__dirname, 'data');
['sessions','memory','skills','automations','files','personas','agents','tasks','logs','knowledge','projects','evaluations']
  .forEach(d => fs.ensureDirSync(path.join(DATA, d)));
fs.ensureDirSync(path.join(__dirname, 'uploads'));

function rj(p, def={}) { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return def; } }
function wj(p, d) { fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,JSON.stringify(d,null,2)); }

function auditLog(level, source, msg, meta={}) {
  try {
    const f = path.join(DATA,'logs',`${new Date().toISOString().slice(0,10)}.json`);
    const logs = rj(f, []);
    logs.push({ id:uid(), ts:new Date().toISOString(), level, source, msg, meta });
    if (logs.length > 5000) logs.splice(0, logs.length-5000);
    wj(f, logs);
  } catch {}
}

// CRITICAL: strip non-Groq fields (ts, etc.) before API calls
function cm(m) {
  const c = { role: m.role, content: m.content ?? null };
  if (m.tool_calls)   c.tool_calls   = m.tool_calls;
  if (m.tool_call_id) c.tool_call_id = m.tool_call_id;
  if (m.name)         c.name         = m.name;
  return c;
}
function pa(raw) { try { return typeof raw==='string'?JSON.parse(raw):(raw||{}); } catch { return {}; } }

// ── MEMORY ──────────────────────────────────────────────────────────────────
const MEM_FILE = path.join(DATA,'memory','global.json');
let GM = rj(MEM_FILE, { facts:[],preferences:[],projects:[],notes:[],people:[],knowledge:[],decisions:[],patterns:[] });
function saveMem() { wj(MEM_FILE, GM); }
function memAdd(type, content) {
  if (!GM[type]) GM[type]=[];
  if (GM[type].some(i=>i.content===content)) return null;
  const e = { id:uid(), content, ts:new Date().toISOString() };
  GM[type].push(e);
  if (GM[type].length>2000) GM[type]=GM[type].slice(-2000);
  saveMem(); return e;
}
function memSearch(q) {
  const ql=q.toLowerCase(), res=[];
  for (const [type,items] of Object.entries(GM)) {
    if (!Array.isArray(items)) continue;
    items.forEach(i => { if (i.content?.toLowerCase().includes(ql)) res.push({type,...i}); });
  }
  return res.slice(0,30);
}
function memCtx() {
  return Object.entries(GM).filter(([,v])=>Array.isArray(v)&&v.length)
    .map(([k,v])=>`[${k}]: ${v.slice(-8).map(i=>i.content).join(' | ')}`).join('\n');
}

// ── KNOWLEDGE GRAPH ──────────────────────────────────────────────────────────
const KG_FILE = path.join(DATA,'knowledge','graph.json');
let KG = rj(KG_FILE, {nodes:[],edges:[]});
function saveKG() { wj(KG_FILE, KG); }
function kgNode(label, type) {
  if (!KG.nodes.find(n=>n.label===label&&n.type===type)) {
    KG.nodes.push({id:uid(),label,type,ts:new Date().toISOString()});
    if (KG.nodes.length>10000) KG.nodes.splice(0,KG.nodes.length-10000);
    saveKG();
  }
}

// ── AGENTS ──────────────────────────────────────────────────────────────────
const ROLES = {
  orchestrator: {name:'Orchestrator', emoji:'🧠', model:'llama-3.3-70b-versatile', temp:0.2, desc:'Master coordinator. Plans missions, decomposes goals into task graphs, coordinates all agents.'},
  researcher:   {name:'Researcher',   emoji:'🔍', model:'llama-3.3-70b-versatile', temp:0.3, desc:'Deep research specialist. Web search, fact verification, source analysis, knowledge extraction.'},
  coder:        {name:'Code Engineer',emoji:'💻', model:'llama-3.3-70b-versatile', temp:0.1, desc:'Senior software engineer. Writes production-quality code, reviews, debugs, tests in any language.'},
  analyst:      {name:'Data Analyst', emoji:'📊', model:'llama-3.3-70b-versatile', temp:0.3, desc:'Quantitative analyst. Data analysis, statistics, pattern detection, trend identification.'},
  writer:       {name:'Writer',       emoji:'✍️', model:'llama-3.3-70b-versatile', temp:0.7, desc:'Expert writer. Technical docs, reports, copywriting, structured content.'},
  planner:      {name:'Planner',      emoji:'📋', model:'llama-3.3-70b-versatile', temp:0.2, desc:'Strategic planner. Task decomposition, dependency mapping, timeline estimation.'},
  critic:       {name:'Critic',       emoji:'🎯', model:'llama-3.3-70b-versatile', temp:0.3, desc:'Quality reviewer. Error detection, logical validation, improvement suggestions.'},
  executor:     {name:'Executor',     emoji:'⚡', model:'llama-3.3-70b-versatile', temp:0.2, desc:'Task executor. Runs tools, manages files, executes code, handles system operations.'},
  memory_agent: {name:'Memory Agent', emoji:'💾', model:'llama-3.1-8b-instant',    temp:0.1, desc:'Knowledge curator. Stores, retrieves, and indexes information across sessions.'},
  optimizer:    {name:'Optimizer',    emoji:'🔧', model:'llama-3.3-70b-versatile', temp:0.3, desc:'Performance optimizer. Bottleneck detection, efficiency improvements.'},
  security:     {name:'Security',     emoji:'🛡️', model:'llama-3.1-8b-instant',    temp:0.1, desc:'Security auditor. Validates safety, checks for risks, enforces constraints.'},
};

const AGENTS_FILE = path.join(DATA,'agents','registry.json');
let AGENTS = rj(AGENTS_FILE, {});
(()=>{
  let changed=false;
  for (const [role,cfg] of Object.entries(ROLES)) {
    if (!AGENTS[role]) { AGENTS[role]={id:uid(),role,...cfg,status:'idle',tasksCompleted:0,tasksRunning:0,errors:0,created:new Date().toISOString(),lastActive:null,perf:{success:0,fail:0,avgMs:0}}; changed=true; }
  }
  if (changed) wj(AGENTS_FILE, AGENTS);
})();

function agentList() {
  return Object.values(AGENTS).map(a=>({
    id:a.id,role:a.role,name:a.name,emoji:a.emoji,desc:a.desc,
    status:a.status,tasksCompleted:a.tasksCompleted,tasksRunning:a.tasksRunning,
    errors:a.errors,lastActive:a.lastActive,
    successRate:a.perf.success>0?Math.round((a.perf.success/(a.perf.success+a.perf.fail))*100):null
  }));
}
function agentUpd(role, upd) {
  if (AGENTS[role]) { Object.assign(AGENTS[role],upd,{lastActive:new Date().toISOString()}); wj(AGENTS_FILE,AGENTS); }
}

// ── TASKS ────────────────────────────────────────────────────────────────────
const TASKS_FILE = path.join(DATA,'tasks','registry.json');
let TASKS = rj(TASKS_FILE, {});
function saveTasks() { wj(TASKS_FILE, TASKS); }
function taskNew(mId, role, desc) {
  const t={id:uid(),mId,role,desc,status:'pending',result:null,error:null,created:new Date().toISOString(),started:null,completed:null,ms:0};
  TASKS[t.id]=t; saveTasks(); return t;
}

// ── TOOLS ────────────────────────────────────────────────────────────────────
const TOOLS=[
  {type:'function',function:{name:'web_search',description:'Search the internet for real-time information, news, and facts.',parameters:{type:'object',properties:{query:{type:'string',description:'Search query'},count:{type:'integer',description:'Number of results, default 6'}},required:['query']}}},
  {type:'function',function:{name:'fetch_url',description:'Fetch and read the full text content of any webpage or URL.',parameters:{type:'object',properties:{url:{type:'string',description:'The URL to fetch'}},required:['url']}}},
  {type:'function',function:{name:'execute_code',description:'Execute JavaScript code for calculations, data processing, or algorithms. Returns the result.',parameters:{type:'object',properties:{code:{type:'string',description:'JavaScript code to execute'},description:{type:'string',description:'What this code does'}},required:['code']}}},
  {type:'function',function:{name:'remember',description:'Store important information in persistent long-term memory for future sessions.',parameters:{type:'object',properties:{type:{type:'string',enum:['facts','preferences','projects','notes','people','knowledge','decisions','patterns'],description:'Memory category'},content:{type:'string',description:'The information to store'}},required:['type','content']}}},
  {type:'function',function:{name:'recall',description:'Search and retrieve information from persistent long-term memory.',parameters:{type:'object',properties:{query:{type:'string',description:'Search query to find relevant memories'}},required:['query']}}},
  {type:'function',function:{name:'write_file',description:'Create a file (code, text, CSV, JSON, markdown, HTML) that the user can download. Always use this when generating code.',parameters:{type:'object',properties:{filename:{type:'string',description:'Filename with extension, e.g. app.py, report.md'},content:{type:'string',description:'Full file content'}},required:['filename','content']}}},
  {type:'function',function:{name:'read_file',description:'Read the content of a previously created file.',parameters:{type:'object',properties:{filename:{type:'string',description:'Name of the file to read'}},required:['filename']}}},
  {type:'function',function:{name:'list_files',description:'List all files created on this platform.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'create_skill',description:'Save reusable JavaScript logic as a named skill for future use.',parameters:{type:'object',properties:{name:{type:'string',description:'Skill name'},description:{type:'string',description:'What the skill does'},code:{type:'string',description:'JavaScript function body'}},required:['name','description','code']}}},
  {type:'function',function:{name:'run_skill',description:'Execute a previously saved named skill.',parameters:{type:'object',properties:{name:{type:'string',description:'Skill name to run'},args:{type:'object',description:'Arguments to pass to the skill'}},required:['name']}}},
  {type:'function',function:{name:'list_skills',description:'List all saved skills with their descriptions and usage stats.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'create_automation',description:'Schedule a recurring task using a cron expression.',parameters:{type:'object',properties:{name:{type:'string',description:'Automation name'},description:{type:'string',description:'What this automation does'},task:{type:'string',description:'The task to execute on each run'},cron:{type:'string',description:'Cron expression e.g. 0 9 * * 1-5 for weekdays at 9am'}},required:['name','task','cron']}}},
  {type:'function',function:{name:'spawn_agent',description:'Spawn a specialized sub-agent to handle a specific task. Available roles: researcher, coder, analyst, writer, planner, critic, executor, optimizer.',parameters:{type:'object',properties:{role:{type:'string',description:'Agent role: researcher, coder, analyst, writer, planner, critic, executor, or optimizer'},task:{type:'string',description:'Detailed task description for the agent'}},required:['role','task']}}},
  {type:'function',function:{name:'reason_deep',description:'Perform deep chain-of-thought reasoning on complex problems. Returns structured analysis with multiple approaches.',parameters:{type:'object',properties:{problem:{type:'string',description:'The problem or question to reason about deeply'}},required:['problem']}}},
  {type:'function',function:{name:'analyze_image',description:'Analyze and describe an image from a URL using vision AI.',parameters:{type:'object',properties:{url:{type:'string',description:'Image URL'},question:{type:'string',description:'Question to ask about the image'}},required:['url']}}},
  {type:'function',function:{name:'calculate',description:'Evaluate any mathematical expression and return the result.',parameters:{type:'object',properties:{expression:{type:'string',description:'Math expression to evaluate, e.g. 2+2 or Math.sqrt(144)'}},required:['expression']}}},
  {type:'function',function:{name:'get_time',description:'Get the current date, time, and UTC timestamp.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'get_agents',description:'Get real-time status, performance metrics, and task counts for all specialized agents.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'create_project',description:'Create a new project workspace with goals and metadata.',parameters:{type:'object',properties:{name:{type:'string',description:'Project name'},description:{type:'string',description:'Project description'},goals:{type:'array',items:{type:'string'},description:'List of project goals'}},required:['name','description']}}},
  {type:'function',function:{name:'evaluate_performance',description:'Run a benchmark evaluation on a specific AI capability and return performance metrics.',parameters:{type:'object',properties:{capability:{type:'string',description:'Capability to benchmark: reasoning, coding, memory, research, or planning'}},required:['capability']}}},
];

// ── TOOL RUNNER ──────────────────────────────────────────────────────────────
async function runTool(name, args, sessionId) {
  auditLog('info',`tool:${name}`,'call');
  try {
    switch(name) {
      case 'web_search': {
        const q=args.query||'', count=Math.min(args.count||6,10);
        try {
          const r=await axios.get('https://api.duckduckgo.com/',{params:{q,format:'json',no_html:1,skip_disambig:1},timeout:8000});
          const res=[]; const d=r.data;
          if(d.AbstractText) res.push({title:d.Heading||q,snippet:d.AbstractText,url:d.AbstractURL});
          if(d.Answer) res.push({title:'Direct Answer',snippet:d.Answer,url:d.AbstractURL});
          (d.RelatedTopics||[]).slice(0,count+2).forEach(t=>{
            if(t.Text) res.push({title:t.Text.slice(0,60),snippet:t.Text,url:t.FirstURL||''});
            if(t.Topics) t.Topics.forEach(st=>{if(st.Text)res.push({title:st.Text.slice(0,60),snippet:st.Text,url:st.FirstURL||''});});
          });
          return {success:true,query:q,results:res.filter(r=>r.snippet).slice(0,count),total:res.length};
        } catch(e) { return {success:false,query:q,error:e.message,results:[]}; }
      }
      case 'fetch_url': {
        const url=args.url||'';
        try {
          const r=await axios.get(url,{timeout:12000,maxContentLength:1000000,headers:{'User-Agent':'Mozilla/5.0 AGII/15'}});
          let t=typeof r.data==='string'?r.data:JSON.stringify(r.data);
          t=t.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,'').replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);
          return {success:true,url,content:t,length:t.length};
        } catch(e) { return {success:false,url,error:e.message}; }
      }
      case 'execute_code': {
        try {
          const fn=new Function('Math','Date','JSON','parseInt','parseFloat','Number','String','Array','Object','Boolean',
            `"use strict";\n${(args.code||'').includes('return')?args.code:'return ('+args.code+')'}`);
          const res=fn(Math,Date,JSON,parseInt,parseFloat,Number,String,Array,Object,Boolean);
          return {success:true,description:args.description,result:String(res).slice(0,5000)};
        } catch(e) { return {success:false,description:args.description,error:e.message}; }
      }
      case 'remember': {
        const e=memAdd(args.type||'notes',args.content||'');
        kgNode((args.content||'').slice(0,80),args.type||'notes');
        return {success:true,stored:!!e,type:args.type};
      }
      case 'recall': { return {success:true,query:args.query,results:memSearch(args.query||'')}; }
      case 'write_file': {
        const fn=(args.filename||'file.txt').replace(/[^a-zA-Z0-9._\-]/g,'_');
        fs.writeFileSync(path.join(DATA,'files',fn),args.content||'','utf8');
        return {success:true,filename:fn,size:(args.content||'').length,downloadUrl:`/api/files/${fn}`};
      }
      case 'read_file': {
        const fn=(args.filename||'').replace(/[^a-zA-Z0-9._\-]/g,'_');
        const fp=path.join(DATA,'files',fn);
        if(!fs.existsSync(fp)) return {success:false,error:'File not found'};
        return {success:true,filename:fn,content:fs.readFileSync(fp,'utf8').slice(0,15000)};
      }
      case 'list_files': {
        const files=fs.readdirSync(path.join(DATA,'files')).map(f=>{const s=fs.statSync(path.join(DATA,'files',f));return{name:f,size:s.size,modified:s.mtime,url:`/api/files/${f}`};});
        return {success:true,files,count:files.length};
      }
      case 'create_skill': {
        const SK=rj(path.join(DATA,'skills','registry.json'),{});
        const id=(args.name||'skill').replace(/[^a-zA-Z0-9_]/g,'_');
        SK[id]={id,name:args.name,description:args.description||'',code:args.code,created:new Date().toISOString(),runCount:0};
        wj(path.join(DATA,'skills','registry.json'),SK);
        return {success:true,id,name:args.name};
      }
      case 'run_skill': {
        const SK=rj(path.join(DATA,'skills','registry.json'),{});
        const skill=SK[args.name];
        if(!skill) return {success:false,error:`Skill '${args.name}' not found`};
        try {
          const fn=new Function('args','Math','JSON',skill.code);
          const r=fn(args.args||{},Math,JSON);
          skill.runCount=(skill.runCount||0)+1; skill.lastRun=new Date().toISOString();
          wj(path.join(DATA,'skills','registry.json'),SK);
          return {success:true,name:args.name,result:String(r).slice(0,5000)};
        } catch(e) { return {success:false,name:args.name,error:e.message}; }
      }
      case 'list_skills': {
        const SK=rj(path.join(DATA,'skills','registry.json'),{});
        return {success:true,skills:Object.values(SK).map(s=>({name:s.name,description:s.description,runCount:s.runCount}))};
      }
      case 'create_automation': {
        const AU=rj(path.join(DATA,'automations','registry.json'),{});
        const id=uid();
        AU[id]={id,name:args.name,description:args.description||'',task:args.task,cron:args.cron,active:true,created:new Date().toISOString(),runCount:0,lastRun:null,lastResult:null};
        wj(path.join(DATA,'automations','registry.json'),AU);
        // Refresh live registry and schedule
        AUTO_REG=rj(path.join(DATA,'automations','registry.json'),{});
        scheduleAuto(AUTO_REG[id]);
        return {success:true,id,name:args.name,cron:args.cron,message:`Automation "${args.name}" created and scheduled.`};
      }
      case 'spawn_agent': {
        const task=taskNew(uid(),args.role||'executor',args.task||'');
        const res=await runAgentTask(task,sessionId,null);
        return {success:res.success,role:args.role,result:res.result,error:res.error};
      }
      case 'reason_deep': {
        const c=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:[{role:'system',content:'You are a deep reasoning engine. Think step by step, consider multiple angles, and produce rigorous structured analysis.'},{role:'user',content:`Problem:\n\n${args.problem}\n\nProvide:\n1. Problem decomposition\n2. Key considerations\n3. Multiple approaches\n4. Recommended approach with justification\n5. Risks and mitigations`}],temperature:0.3,max_tokens:3000});
        return {success:true,reasoning:c.choices[0].message.content};
      }
      case 'analyze_image': {
        const c=await groq.chat.completions.create({model:'meta-llama/llama-4-scout-17b-16e-instruct',messages:[{role:'user',content:[{type:'image_url',image_url:{url:args.url}},{type:'text',text:args.question||'Analyze this image in detail.'}]}],max_tokens:1500});
        return {success:true,analysis:c.choices[0].message.content};
      }
      case 'calculate': {
        try { return {success:true,expression:args.expression,result:Function('"use strict";return ('+args.expression+')')()}; }
        catch(e) { return {success:false,expression:args.expression,error:e.message}; }
      }
      case 'get_time': {
        const n=new Date();
        return {success:true,iso:n.toISOString(),utc:n.toUTCString(),unix:n.getTime(),date:n.toDateString(),time:n.toTimeString()};
      }
      case 'get_agents': { return {success:true,agents:agentList()}; }
      case 'create_project': {
        const PR=rj(path.join(DATA,'projects','registry.json'),{});
        const id=uid();
        PR[id]={id,name:args.name,description:args.description,goals:args.goals||[],status:'active',created:new Date().toISOString()};
        wj(path.join(DATA,'projects','registry.json'),PR);
        return {success:true,id,name:args.name,message:`Project "${args.name}" created.`};
      }
      case 'evaluate_performance': {
        const cap=args.capability||'reasoning';
        const benchmarks={
          reasoning:'Solve this step by step: If a train travels 120km in 1.5 hours, then stops for 30 minutes, then travels 80km in 1 hour, what is the average speed for the entire journey including the stop? Show your work.',
          coding:'Write a Python function that takes a list of integers and returns the longest increasing subsequence. Include proper type hints, edge case handling, and time complexity analysis.',
          memory:'Given these facts: Alice is Bob\'s sister. Bob is married to Carol. Carol has a daughter named Diana. What is Alice\'s relationship to Diana? Explain your reasoning step by step.',
          research:'Explain the key differences between transformer and state-space model architectures for sequence modeling. Cover attention mechanisms, computational complexity, and practical trade-offs.',
          planning:'You need to build a web application with user auth, a database, and a REST API. Create a detailed project plan with task dependencies, estimated times, and risk factors.'
        };
        const prompt=benchmarks[cap]||benchmarks.reasoning;
        try {
          const t0=Date.now();
          const comp=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:[{role:'system',content:'You are being evaluated. Provide the best possible answer. Be thorough, accurate, and complete.'},{role:'user',content:prompt}],temperature:0.3,max_tokens:2000});
          const answer=comp.choices[0].message.content;
          const latency=Date.now()-t0;
          const evalComp=await groq.chat.completions.create({model:'llama-3.1-8b-instant',messages:[{role:'system',content:'You are an objective AI evaluator. Score the following answer on a scale of 0-100. Return ONLY a JSON object with: {"score": <number>, "completeness": <0-100>, "correctness": <0-100>, "quality": <0-100>, "feedback": "<brief feedback>"}. Return valid JSON only.'},{role:'user',content:`Task: ${prompt}\n\nAnswer:\n${answer}`}],temperature:0.1,max_tokens:300,response_format:{type:'json_object'}});
          let scores;
          try { scores=JSON.parse(evalComp.choices[0].message.content); } catch { scores={score:75,completeness:75,correctness:75,quality:75,feedback:'Evaluation parse error'}; }
          const score=typeof scores.score==='number'?Math.min(100,Math.max(0,scores.score)):75;
          const EV=rj(path.join(DATA,'evaluations','history.json'),[]);
          EV.push({id:uid(),capability:cap,score,completeness:scores.completeness,correctness:scores.correctness,quality:scores.quality,feedback:scores.feedback,latencyMs:latency,ts:new Date().toISOString(),version:'v15'});
          if(EV.length>1000) EV.splice(0,EV.length-1000);
          wj(path.join(DATA,'evaluations','history.json'),EV);
          return {success:true,capability:cap,score,pass:score>=70,details:scores,latencyMs:latency,ts:new Date().toISOString()};
        } catch(e) { return {success:false,capability:cap,error:e.message}; }
      }
      default: return {success:false,error:`Unknown tool: ${name}`};
    }
  } catch(e) { auditLog('error',`tool:${name}`,e.message); return {success:false,error:e.message}; }
}

// ── AGENT TASK RUNNER ────────────────────────────────────────────────────────
async function runAgentTask(task, sessionId, send) {
  const agent=AGENTS[task.role];
  if(!agent) return {success:false,error:`No agent: ${task.role}`};
  const t0=Date.now();
  task.status='running'; task.started=new Date().toISOString(); saveTasks();
  agentUpd(task.role,{status:'working',tasksRunning:(agent.tasksRunning||0)+1});
  if(send) send({type:'agent_start',agent:agent.name,emoji:agent.emoji,role:task.role,task:task.desc.slice(0,100)});
  try {
    const messages=[
      {role:'system',content:`You are ${agent.name} (${agent.emoji}). ${agent.desc}\nTask: ${task.desc}\nExecute with precision. Use tools when needed.`},
      {role:'user',content:task.desc}
    ];
    let result=''; let itr=0;
    while(itr<6) {
      itr++;
      const comp=await groq.chat.completions.create({model:agent.model||'llama-3.3-70b-versatile',messages,tools:TOOLS,tool_choice:'auto',temperature:agent.temp||0.4,max_tokens:3000});
      const choice=comp.choices[0]; const msg=choice.message;
      messages.push(cm(msg));
      if(choice.finish_reason==='tool_calls'&&msg.tool_calls) {
        for(const tc of msg.tool_calls) {
          const a=pa(tc.function.arguments);
          if(send) send({type:'agent_tool',agent:agent.name,emoji:agent.emoji,tool:tc.function.name});
          const tr=await runTool(tc.function.name,a,sessionId);
          messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(tr)});
        }
      } else { result=msg.content||''; break; }
    }
    const ms=Date.now()-t0;
    task.status='completed'; task.result=result; task.completed=new Date().toISOString(); task.ms=ms; saveTasks();
    const p=agent.perf||{success:0,fail:0,avgMs:0};
    p.success=(p.success||0)+1; p.avgMs=Math.round(((p.avgMs||0)*(p.success-1)+ms)/p.success);
    agentUpd(task.role,{status:'idle',tasksCompleted:(agent.tasksCompleted||0)+1,tasksRunning:Math.max(0,(agent.tasksRunning||1)-1),perf:p});
    if(send) send({type:'agent_done',agent:agent.name,emoji:agent.emoji,role:task.role,ms});
    return {success:true,result,ms};
  } catch(e) {
    const ms=Date.now()-t0;
    task.status='failed'; task.error=e.message; task.completed=new Date().toISOString(); saveTasks();
    agentUpd(task.role,{status:'idle',errors:(agent.errors||0)+1,tasksRunning:Math.max(0,(agent.tasksRunning||1)-1)});
    return {success:false,error:e.message,ms};
  }
}

// ── MISSION ORCHESTRATOR ─────────────────────────────────────────────────────
async function runMission(desc, sessionId, send) {
  const mId=uid();
  agentUpd('orchestrator',{status:'planning'});
  if(send) send({type:'mission_start',missionId:mId});
  try {
    const planComp=await groq.chat.completions.create({
      model:'llama-3.3-70b-versatile',
      messages:[
        {role:'system',content:'You are a mission planning AI. Return ONLY valid JSON.'},
        {role:'user',content:`Mission: "${desc}"\n\nCreate optimal task graph with 2-5 tasks.\n\nReturn:\n{"plan":"brief strategy","tasks":[{"role":"researcher|coder|analyst|writer|planner|critic|executor|optimizer","desc":"specific detailed task description","deps":[]}]}\n\nDeps = zero-based indices of tasks that must complete first.`}
      ],
      temperature:0.2, max_tokens:1000, response_format:{type:'json_object'}
    });
    const plan=JSON.parse(planComp.choices[0].message.content);
    agentUpd('orchestrator',{status:'coordinating',tasksCompleted:(AGENTS.orchestrator?.tasksCompleted||0)+1});
    if(send) send({type:'mission_plan',plan:plan.plan,taskCount:plan.tasks?.length||0});
    const tasks=(plan.tasks||[]).map(t=>taskNew(mId,t.role||'executor',t.desc||t.description||''));
    const done=new Set(); const results={};
    let tries=0;
    while(done.size<tasks.length&&tries<tasks.length*5) {
      tries++;
      let progress=false;
      for(let i=0;i<tasks.length;i++) {
        const task=tasks[i];
        if(done.has(task.id)){continue;}
        if(task.status==='failed'){done.add(task.id);continue;}
        const depsOk=(plan.tasks[i].deps||[]).every(d=>tasks[d]&&done.has(tasks[d].id));
        if(depsOk&&task.status==='pending'){results[i]=await runAgentTask(task,sessionId,send);done.add(task.id);progress=true;}
      }
      if(!progress) await new Promise(r=>setTimeout(r,100));
    }
    agentUpd('orchestrator',{status:'idle'});
    const synthesis=Object.entries(results).filter(([,r])=>r.success).map(([i,r])=>`[${plan.tasks[i]?.role||'agent'}]: ${r.result}`).join('\n\n---\n\n');
    return {missionId:mId,plan:plan.plan,tasks:tasks.length,synthesis};
  } catch(e) {
    agentUpd('orchestrator',{status:'idle'});
    auditLog('error','mission',e.message);
    return null;
  }
}

// ── PERSONAS ─────────────────────────────────────────────────────────────────
const PERSONAS_FILE=path.join(DATA,'personas','registry.json');
let PERSONAS=rj(PERSONAS_FILE,{default:{id:'default',name:'AGII',avatar:'🤖',model:'llama-3.3-70b-versatile',temperature:0.7,systemPrompt:`You are AGII — a production-grade distributed AI agent platform built for real work.\n\nYou have 11 specialized agents you can coordinate, persistent memory across sessions, real tool execution (web search, code execution, file creation, URL fetching), and multi-agent mission orchestration.\n\nYour principles:\n- Use tools proactively. Don't say "I would search..." — actually search using web_search.\n- For complex tasks, spawn specialized agents or run reason_deep first.\n- Store important information to memory automatically using remember.\n- Create files when producing code, reports, or structured data using write_file.\n- Be direct, precise, and thorough. Show what tools you used.\n- When producing code, always write it to a file using write_file so the user can download it.`,created:new Date().toISOString()}});
function savePersonas(){wj(PERSONAS_FILE,PERSONAS);}

// ── SESSIONS ─────────────────────────────────────────────────────────────────
const SC={};
function sessGet(id,personaId='default'){
  if(!SC[id]){
    const f=path.join(DATA,'sessions',`${id}.json`);
    const p=PERSONAS[personaId]||PERSONAS['default'];
    SC[id]=rj(f,{id,messages:[],title:'New Conversation',created:new Date().toISOString(),model:p.model,personaId,pinned:false,missionIds:[],messageCount:0});
  }
  return SC[id];
}
function sessSave(id){const s=SC[id];if(s)wj(path.join(DATA,'sessions',`${s.id}.json`),s);}
function sessList(){
  try {
    return fs.readdirSync(path.join(DATA,'sessions')).filter(f=>f.endsWith('.json'))
      .map(f=>{const d=rj(path.join(DATA,'sessions',f));return{id:d.id,title:d.title||'Untitled',created:d.created,messageCount:d.messages?.length||0,pinned:d.pinned||false,lastMessage:d.messages?.slice(-1)[0]?.content?.toString().slice(0,100)||''};})
      .filter(s=>s.id).sort((a,b)=>new Date(b.created)-new Date(a.created));
  } catch {return [];}
}

// ── MAIN AGENT LOOP ──────────────────────────────────────────────────────────
async function agentLoop(session, sessionId, send) {
  const persona=PERSONAS[session.personaId||'default']||PERSONAS['default'];
  const mc=memCtx();
  const sys=`${persona.systemPrompt}\n\nCurrent date/time: ${new Date().toISOString()}\n${mc?`\nPersistent memory:\n${mc}`:''}`;
  const messages=[{role:'system',content:sys},...session.messages.slice(-24).map(cm)];
  let finalResponse=''; let itr=0;
  while(itr<12){
    itr++;
    const comp=await groq.chat.completions.create({model:session.model||'llama-3.3-70b-versatile',messages,tools:TOOLS,tool_choice:'auto',temperature:persona.temperature||0.7,max_tokens:4096});
    const choice=comp.choices[0]; const msg=choice.message;
    messages.push(cm(msg));
    if(choice.finish_reason==='tool_calls'&&msg.tool_calls){
      for(const tc of msg.tool_calls){
        const a=pa(tc.function.arguments);
        if(send) send({type:'tool_start',tool:tc.function.name,args:a});
        const tr=await runTool(tc.function.name,a,sessionId);
        if(send) send({type:'tool_result',tool:tc.function.name,result:tr,success:tr.success});
        messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(tr)});
      }
    } else {finalResponse=msg.content||'';break;}
  }
  return finalResponse;
}

// ── AUTOMATIONS ──────────────────────────────────────────────────────────────
let AUTO_REG=rj(path.join(DATA,'automations','registry.json'),{});
const CRON_JOBS={};
function saveAutoReg(){wj(path.join(DATA,'automations','registry.json'),AUTO_REG);}
function scheduleAuto(a){
  if(CRON_JOBS[a.id]){try{CRON_JOBS[a.id].stop();}catch{}delete CRON_JOBS[a.id];}
  if(!a.active||!a.cron) return;
  try {
    CRON_JOBS[a.id]=cron.schedule(a.cron,async()=>{
      a.lastRun=new Date().toISOString(); a.runCount=(a.runCount||0)+1; saveAutoReg();
      const sid=uid(); const s=sessGet(sid);
      s.messages.push({role:'user',content:a.task});
      try{const r=await agentLoop(s,sid,null);a.lastResult=r.slice(0,1000);}
      catch(e){a.lastResult=`Error: ${e.message}`;}
      saveAutoReg();
    });
  } catch(e){auditLog('error','automation',`schedule failed: ${e.message}`);}
}
Object.values(AUTO_REG).forEach(a=>scheduleAuto(a));

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/health',(req,res)=>res.json({status:'ok',version:'15.0',platform:'AGII',timestamp:new Date().toISOString(),agents:Object.keys(AGENTS).length,uptime:Math.floor(process.uptime())}));

// CHAT — SSE Streaming
app.post('/api/chat',async(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  const send=d=>{try{if(!res.writableEnded)res.write(`data: ${JSON.stringify(d)}\n\n`);}catch{}};
  try {
    const {message,sessionId=uid(),model,imageUrl,useMission=false}=req.body;
    if(!message){send({type:'error',message:'No message'});return res.end();}
    const session=sessGet(sessionId);
    if(model) session.model=model;
    const userContent=imageUrl?[{type:'image_url',image_url:{url:imageUrl}},{type:'text',text:message}]:message;
    session.messages.push({role:'user',content:userContent,ts:new Date().toISOString()});
    session.messageCount=(session.messageCount||0)+1;
    if(session.messages.length===1&&session.title==='New Conversation')
      session.title=(typeof message==='string'?message:'Vision').slice(0,65)+(message.length>65?'…':'');
    send({type:'start',sessionId});
    const complex=useMission||(typeof message==='string'&&message.length>120&&/\b(build|create|develop|implement|research and|analyze and|design|write a complete|generate a full)\b/i.test(message));
    let finalResponse='';
    if(complex){
      send({type:'status',text:'🧠 Orchestrating multi-agent mission...'});
      const mission=await runMission(message,sessionId,send);
      if(mission?.synthesis&&mission.synthesis.length>50){
        send({type:'status',text:'🔗 Synthesizing results...'});
        const sc=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:[{role:'system',content:PERSONAS['default'].systemPrompt},{role:'user',content:`Original request: "${message}"\n\nAgent outputs:\n\n${mission.synthesis}\n\nSynthesize into a clear, comprehensive, well-structured response.`}],temperature:0.5,max_tokens:3000});
        finalResponse=sc.choices[0].message.content;
      } else {finalResponse=await agentLoop(session,sessionId,send);}
    } else {finalResponse=await agentLoop(session,sessionId,send);}
    const words=finalResponse.split(' ');
    for(let i=0;i<words.length;i++){send({type:'token',text:(i===0?'':' ')+words[i]});if(i%10===0)await new Promise(r=>setTimeout(r,3));}
    session.messages.push({role:'assistant',content:finalResponse,ts:new Date().toISOString()});
    sessSave(sessionId);
    send({type:'done',sessionId,title:session.title,messageCount:session.messages.length});
    res.end();
    auditLog('info','chat',`session:${sessionId}`,{msg:message.slice(0,80)});
  } catch(e){auditLog('error','chat',e.message);send({type:'error',message:e.message});res.end();}
});

// Sessions
app.get('/api/sessions',(req,res)=>res.json(sessList()));
app.get('/api/sessions/:id',(req,res)=>{const f=path.join(DATA,'sessions',`${req.params.id}.json`);const d=rj(f,null);if(!d)return res.status(404).json({error:'Not found'});res.json(d);});
app.delete('/api/sessions/:id',(req,res)=>{const f=path.join(DATA,'sessions',`${req.params.id}.json`);if(fs.existsSync(f))fs.unlinkSync(f);delete SC[req.params.id];res.json({success:true});});
app.patch('/api/sessions/:id',(req,res)=>{const f=path.join(DATA,'sessions',`${req.params.id}.json`);const d=rj(f,null);if(!d)return res.status(404).json({error:'Not found'});if(req.body.pinned!==undefined)d.pinned=req.body.pinned;if(req.body.title!==undefined)d.title=req.body.title;wj(f,d);res.json({success:true});});

// Memory
app.get('/api/memory',(req,res)=>res.json(GM));
app.get('/api/memory/search',(req,res)=>res.json(memSearch(req.query.q||'')));
app.post('/api/memory',(req,res)=>res.json({success:true,entry:memAdd(req.body.type||'notes',req.body.content||'')}));
app.delete('/api/memory/:type/:id',(req,res)=>{const{type,id}=req.params;if(GM[type]){GM[type]=GM[type].filter(i=>i.id!==id);saveMem();}res.json({success:true});});
app.delete('/api/memory',(req,res)=>{Object.keys(GM).forEach(k=>GM[k]=[]);saveMem();res.json({success:true});});

// Knowledge
app.get('/api/knowledge',(req,res)=>{const lim=parseInt(req.query.limit)||200;res.json({nodes:KG.nodes.slice(-lim),edges:KG.edges.slice(-lim),total:{nodes:KG.nodes.length,edges:KG.edges.length}});});

// Agents
app.get('/api/agents',(req,res)=>res.json(agentList()));
app.post('/api/agents/:role/run',async(req,res)=>{
  const role=req.params.role;
  if(!AGENTS[role]) return res.status(404).json({error:`Agent '${role}' not found`});
  const task=taskNew(uid(),role,req.body.task||'');
  const result=await runAgentTask(task,uid(),null);
  res.json({success:result.success,role,result:result.result,error:result.error,ms:result.ms});
});

// Tasks
app.get('/api/tasks',(req,res)=>res.json(Object.values(TASKS).sort((a,b)=>new Date(b.created)-new Date(a.created)).slice(0,parseInt(req.query.limit)||100)));
app.get('/api/tasks/:id',(req,res)=>{const t=TASKS[req.params.id];if(!t)return res.status(404).json({error:'Not found'});res.json(t);});

// Models
app.get('/api/models',(req,res)=>res.json([
  {id:'llama-3.3-70b-versatile',name:'Llama 3.3 70B',provider:'Groq',speed:'Fast',recommended:true},
  {id:'llama-3.1-8b-instant',name:'Llama 3.1 8B',provider:'Groq',speed:'Ultra Fast'},
  {id:'meta-llama/llama-4-scout-17b-16e-instruct',name:'Llama 4 Scout 17B',provider:'Groq',speed:'Fast',vision:true},
  {id:'deepseek-r1-distill-llama-70b',name:'DeepSeek R1 70B',provider:'Groq',speed:'Medium',reasoning:true},
  {id:'qwen-qwq-32b',name:'Qwen QwQ 32B',provider:'Groq',speed:'Medium',reasoning:true},
  {id:'mixtral-8x7b-32768',name:'Mixtral 8x7B',provider:'Groq',speed:'Fast'},
  {id:'gemma2-9b-it',name:'Gemma 2 9B',provider:'Groq',speed:'Fast'},
]));

// Skills
const getSkills=()=>rj(path.join(DATA,'skills','registry.json'),{});
app.get('/api/skills',(req,res)=>res.json(Object.values(getSkills())));
app.post('/api/skills',(req,res)=>{const SK=getSkills();const id=(req.body.name||'skill').replace(/[^a-zA-Z0-9_]/g,'_');SK[id]={id,name:req.body.name,description:req.body.description||'',code:req.body.code||'',created:new Date().toISOString(),runCount:0};wj(path.join(DATA,'skills','registry.json'),SK);res.json({success:true,id});});
app.delete('/api/skills/:id',(req,res)=>{const SK=getSkills();delete SK[req.params.id];wj(path.join(DATA,'skills','registry.json'),SK);res.json({success:true});});
app.post('/api/skills/:id/run',async(req,res)=>{const result=await runTool('run_skill',{name:req.params.id,args:req.body.args||{}},uid());res.json(result);});

// Automations
app.get('/api/automations',(req,res)=>res.json(Object.values(AUTO_REG)));
app.post('/api/automations',(req,res)=>{const id=uid();AUTO_REG[id]={id,name:req.body.name,description:req.body.description||'',task:req.body.task,cron:req.body.cron,active:true,created:new Date().toISOString(),runCount:0};saveAutoReg();scheduleAuto(AUTO_REG[id]);res.json({success:true,id});});
app.patch('/api/automations/:id',(req,res)=>{const a=AUTO_REG[req.params.id];if(!a)return res.status(404).json({error:'Not found'});if(req.body.active!==undefined){a.active=req.body.active;scheduleAuto(a);}if(req.body.name)a.name=req.body.name;if(req.body.task)a.task=req.body.task;if(req.body.cron){a.cron=req.body.cron;scheduleAuto(a);}saveAutoReg();res.json({success:true});});
app.delete('/api/automations/:id',(req,res)=>{if(CRON_JOBS[req.params.id]){try{CRON_JOBS[req.params.id].stop();}catch{}delete CRON_JOBS[req.params.id];}delete AUTO_REG[req.params.id];saveAutoReg();res.json({success:true});});

// Personas
app.get('/api/personas',(req,res)=>res.json(Object.values(PERSONAS)));
app.post('/api/personas',(req,res)=>{const id=uid();PERSONAS[id]={id,...req.body,created:new Date().toISOString()};savePersonas();res.json({success:true,id});});
app.put('/api/personas/:id',(req,res)=>{if(!PERSONAS[req.params.id])return res.status(404).json({error:'Not found'});Object.assign(PERSONAS[req.params.id],req.body);savePersonas();res.json({success:true});});

// Projects
const getProjects=()=>rj(path.join(DATA,'projects','registry.json'),{});
app.get('/api/projects',(req,res)=>res.json(Object.values(getProjects())));
app.post('/api/projects',(req,res)=>{const PR=getProjects();const id=uid();PR[id]={id,name:req.body.name,description:req.body.description||'',goals:req.body.goals||[],status:'active',created:new Date().toISOString()};wj(path.join(DATA,'projects','registry.json'),PR);res.json({success:true,id});});
app.delete('/api/projects/:id',(req,res)=>{const PR=getProjects();delete PR[req.params.id];wj(path.join(DATA,'projects','registry.json'),PR);res.json({success:true});});

// Files
app.get('/api/files',(req,res)=>{try{const dir=path.join(DATA,'files');res.json(fs.readdirSync(dir).map(f=>{const s=fs.statSync(path.join(dir,f));return{name:f,size:s.size,modified:s.mtime,url:`/api/files/${f}`};}));}catch{res.json([]);}});
app.get('/api/files/:name',(req,res)=>{const fn=req.params.name.replace(/[^a-zA-Z0-9._\-]/g,'_');const fp=path.join(DATA,'files',fn);if(!fs.existsSync(fp))return res.status(404).json({error:'Not found'});res.download(fp,fn);});
app.delete('/api/files/:name',(req,res)=>{const fn=req.params.name.replace(/[^a-zA-Z0-9._\-]/g,'_');const fp=path.join(DATA,'files',fn);if(fs.existsSync(fp))fs.unlinkSync(fp);res.json({success:true});});
app.post('/api/upload',upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'No file'});const ext=path.extname(req.file.originalname);const dest=path.join(DATA,'files',req.file.filename+ext);fs.moveSync(req.file.path,dest);res.json({success:true,filename:req.file.filename+ext,url:`/api/files/${req.file.filename+ext}`});});

// Logs
app.get('/api/logs',(req,res)=>{try{const day=req.query.date||new Date().toISOString().slice(0,10);const logs=rj(path.join(DATA,'logs',`${day}.json`),[]);const filtered=req.query.level?logs.filter(l=>l.level===req.query.level):logs;res.json(filtered.slice(-300).reverse());}catch{res.json([]);}});

// Stats
app.get('/api/stats',(req,res)=>{
  const ss=sessList();
  const SK=getSkills(); const PR=getProjects();
  const tasks=Object.values(TASKS);
  res.json({
    sessions:ss.length,
    totalMessages:ss.reduce((s,x)=>s+(x.messageCount||0),0),
    memoryItems:Object.values(GM).reduce((s,a)=>s+(Array.isArray(a)?a.length:0),0),
    skills:Object.keys(SK).length,
    automations:Object.keys(AUTO_REG).length,
    agents:Object.keys(AGENTS).length,
    tasks:tasks.length,
    tasksSuccess:tasks.filter(t=>t.status==='completed').length,
    tasksFailed:tasks.filter(t=>t.status==='failed').length,
    knowledgeNodes:KG.nodes.length,
    projects:Object.keys(PR).length,
    files:fs.readdirSync(path.join(DATA,'files')).length,
    uptime:Math.floor(process.uptime()),
    version:'15.0'
  });
});

// Mission
app.post('/api/mission',async(req,res)=>{
  const{description,sessionId=uid()}=req.body;
  if(!description) return res.status(400).json({error:'No description'});
  const result=await runMission(description,sessionId,null);
  res.json(result||{error:'Mission failed'});
});

// Benchmarks
app.post('/api/benchmark',async(req,res)=>{const result=await runTool('evaluate_performance',{capability:req.body.capability||'reasoning'},uid());res.json(result);});
app.get('/api/benchmark/history',(req,res)=>res.json(rj(path.join(DATA,'evaluations','history.json'),[]).slice(-100).reverse()));

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{
  console.log(`\n🚀 AGII v15 | Port ${PORT} | ${Object.keys(AGENTS).length} agents | ${TOOLS.length} tools`);
  auditLog('info','server',`started on port ${PORT}`);
});
