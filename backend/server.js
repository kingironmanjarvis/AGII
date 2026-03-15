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
const cron = require('node-cron');
const http = require('http');

const app = express();
const server = http.createServer(app);
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
const upload = multer({ dest: 'uploads/', limits: { fileSize: 50*1024*1024 } });
app.use(rateLimit({ windowMs: 60000, max: 500 }));
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const DATA_DIR = path.join(__dirname, 'data');
['sessions','memory','skills','automations','files','personas','agents','tasks','logs','knowledge']
  .forEach(d => fs.ensureDirSync(path.join(DATA_DIR, d)));
fs.ensureDirSync(path.join(__dirname, 'uploads'));

function loadJSON(p, def={}) { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return def; } }
function saveJSON(p, data) { fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,JSON.stringify(data,null,2)); }
function sysLog(level,source,msg) { try { const lf=path.join(DATA_DIR,'logs',`${new Date().toISOString().slice(0,10)}.json`); const logs=loadJSON(lf,[]); logs.push({id:uuidv4(),ts:new Date().toISOString(),level,source,msg}); if(logs.length>2000)logs.splice(0,logs.length-2000); saveJSON(lf,logs); } catch {} }

// CRITICAL: strip non-Groq fields before sending messages to API
function cleanMsg(m) {
  const c = { role: m.role, content: m.content ?? null };
  if (m.tool_calls) c.tool_calls = m.tool_calls;
  if (m.tool_call_id) c.tool_call_id = m.tool_call_id;
  if (m.name) c.name = m.name;
  return c;
}
function parseArgs(raw) { try { return typeof raw==='string'?JSON.parse(raw):(raw||{}); } catch { return {}; } }

// ── MEMORY ────────────────────────────────────────────────────────────────────
const memFile = path.join(DATA_DIR,'memory','global.json');
let globalMemory = loadJSON(memFile, {facts:[],preferences:[],projects:[],notes:[],people:[],knowledge:[],decisions:[]});
function saveMemory() { saveJSON(memFile, globalMemory); }
function addMemory(type, content) {
  if (!globalMemory[type]) globalMemory[type]=[];
  if (globalMemory[type].some(i=>i.content===content)) return null;
  const entry={id:uuidv4(),content,ts:new Date().toISOString()};
  globalMemory[type].push(entry);
  if (globalMemory[type].length>1000) globalMemory[type]=globalMemory[type].slice(-1000);
  saveMemory(); return entry;
}
function searchMemory(q) {
  const ql=q.toLowerCase(); const res=[];
  for(const [type,items] of Object.entries(globalMemory)) {
    if(!Array.isArray(items)) continue;
    items.forEach(i=>{ if(i.content?.toLowerCase().includes(ql)) res.push({type,...i}); });
  }
  return res.slice(0,20);
}
function getMemCtx() {
  return Object.entries(globalMemory).filter(([,v])=>Array.isArray(v)&&v.length)
    .map(([k,v])=>`[${k}]: ${v.slice(-6).map(i=>i.content).join(' | ')}`).join('\n');
}

// ── KNOWLEDGE GRAPH ───────────────────────────────────────────────────────────
const kgFile = path.join(DATA_DIR,'knowledge','graph.json');
let kg = loadJSON(kgFile,{nodes:[],edges:[]});
function saveKG() { saveJSON(kgFile,kg); }
function addKGNode(label,type) {
  if(kg.nodes.find(n=>n.label===label&&n.type===type)) return;
  kg.nodes.push({id:uuidv4(),label,type,ts:new Date().toISOString()});
  if(kg.nodes.length>5000) kg.nodes.splice(0,kg.nodes.length-5000);
  saveKG();
}

// ── AGENT REGISTRY ────────────────────────────────────────────────────────────
const ROLES = {
  orchestrator:{name:'Orchestrator',emoji:'🧠',desc:'Plans missions, coordinates all agents',model:'llama-3.3-70b-versatile'},
  researcher:{name:'Researcher',emoji:'🔍',desc:'Web search, data gathering, fact verification',model:'llama-3.3-70b-versatile'},
  coder:{name:'Code Engineer',emoji:'💻',desc:'Writes, reviews, debugs code in any language',model:'llama-3.3-70b-versatile'},
  analyst:{name:'Analyst',emoji:'📊',desc:'Data analysis, pattern detection, insights',model:'llama-3.3-70b-versatile'},
  writer:{name:'Writer',emoji:'✍️',desc:'Content creation, documentation, copywriting',model:'llama-3.3-70b-versatile'},
  planner:{name:'Planner',emoji:'📋',desc:'Task decomposition, scheduling, dependency mapping',model:'llama-3.3-70b-versatile'},
  critic:{name:'Critic',emoji:'🎯',desc:'Quality review, error detection, improvements',model:'llama-3.3-70b-versatile'},
  memory_agent:{name:'Memory Agent',emoji:'💾',desc:'Manages knowledge storage and retrieval',model:'llama-3.1-8b-instant'},
  executor:{name:'Executor',emoji:'⚡',desc:'Runs tools, executes code, manages files',model:'llama-3.3-70b-versatile'},
  monitor:{name:'Monitor',emoji:'📡',desc:'System health, performance, alerting',model:'llama-3.1-8b-instant'},
  optimizer:{name:'Optimizer',emoji:'🔧',desc:'Performance analysis, system improvements',model:'llama-3.3-70b-versatile'},
};
const agentsFile = path.join(DATA_DIR,'agents','registry.json');
let agents = loadJSON(agentsFile,{});
(function ensureAgents(){
  let changed=false;
  for(const [role,cfg] of Object.entries(ROLES)) {
    if(!agents[role]){agents[role]={id:uuidv4(),role,...cfg,status:'idle',tasksCompleted:0,tasksRunning:0,errors:0,created:new Date().toISOString(),lastActive:null};changed=true;}
  }
  if(changed) saveJSON(agentsFile,agents);
})();
function getAgentList() { return Object.values(agents).map(a=>({id:a.id,role:a.role,name:a.name,emoji:a.emoji,desc:a.desc,status:a.status,tasksCompleted:a.tasksCompleted,errors:a.errors,lastActive:a.lastActive})); }
function updateAgent(role,upd) { if(agents[role]){Object.assign(agents[role],upd,{lastActive:new Date().toISOString()});saveJSON(agentsFile,agents);} }

// ── TASK ENGINE ───────────────────────────────────────────────────────────────
const tasksFile = path.join(DATA_DIR,'tasks','registry.json');
let taskReg = loadJSON(tasksFile,{});
function saveTasks() { saveJSON(tasksFile,taskReg); }
function makeTask(mId,role,desc) { const t={id:uuidv4(),mId,role,desc,status:'pending',result:null,error:null,created:new Date().toISOString(),started:null,completed:null}; taskReg[t.id]=t; saveTasks(); return t; }

// ── TOOL DEFINITIONS ──────────────────────────────────────────────────────────
const TOOLS=[
  {type:'function',function:{name:'web_search',description:'Search internet for real-time info, news, facts.',parameters:{type:'object',properties:{query:{type:'string'},count:{type:'number'}},required:['query']}}},
  {type:'function',function:{name:'fetch_url',description:'Fetch full text content of any webpage.',parameters:{type:'object',properties:{url:{type:'string'}},required:['url']}}},
  {type:'function',function:{name:'execute_code',description:'Execute JavaScript for calculations, data processing, algorithms. Returns result.',parameters:{type:'object',properties:{code:{type:'string'},description:{type:'string'}},required:['code','description']}}},
  {type:'function',function:{name:'remember',description:'Store important info in persistent long-term memory.',parameters:{type:'object',properties:{type:{type:'string',enum:['facts','preferences','projects','notes','people','knowledge','decisions']},content:{type:'string'}},required:['type','content']}}},
  {type:'function',function:{name:'recall',description:'Search long-term persistent memory.',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}},
  {type:'function',function:{name:'write_file',description:'Create a text, code, CSV, JSON, or markdown file for download.',parameters:{type:'object',properties:{filename:{type:'string'},content:{type:'string'}},required:['filename','content']}}},
  {type:'function',function:{name:'read_file',description:'Read a previously created file.',parameters:{type:'object',properties:{filename:{type:'string'}},required:['filename']}}},
  {type:'function',function:{name:'list_files',description:'List all created files.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'create_skill',description:'Save reusable JavaScript as a named skill.',parameters:{type:'object',properties:{name:{type:'string'},description:{type:'string'},code:{type:'string'}},required:['name','description','code']}}},
  {type:'function',function:{name:'run_skill',description:'Run a previously saved skill.',parameters:{type:'object',properties:{name:{type:'string'},args:{type:'object'}},required:['name']}}},
  {type:'function',function:{name:'list_skills',description:'List all saved skills.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'create_automation',description:'Schedule a recurring task with cron expression.',parameters:{type:'object',properties:{name:{type:'string'},task:{type:'string'},cron:{type:'string'}},required:['name','task','cron']}}},
  {type:'function',function:{name:'spawn_agent',description:'Spawn a specialized sub-agent. Roles: researcher,coder,analyst,writer,planner,critic,executor',parameters:{type:'object',properties:{role:{type:'string'},task:{type:'string'}},required:['role','task']}}},
  {type:'function',function:{name:'reason_and_plan',description:'Deep structured reasoning for complex problems.',parameters:{type:'object',properties:{problem:{type:'string'}},required:['problem']}}},
  {type:'function',function:{name:'analyze_image_url',description:'Analyze and describe an image from URL.',parameters:{type:'object',properties:{url:{type:'string'},question:{type:'string'}},required:['url']}}},
  {type:'function',function:{name:'calculate',description:'Evaluate a math expression.',parameters:{type:'object',properties:{expression:{type:'string'}},required:['expression']}}},
  {type:'function',function:{name:'get_current_time',description:'Get current date and time.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'get_agents',description:'Get status of all specialized agents.',parameters:{type:'object',properties:{}}}},
];

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function executeTool(name, args, sessionId) {
  try {
    switch(name) {
      case 'web_search': {
        const q=args.query||''; const count=args.count||6;
        try {
          const r=await axios.get('https://api.duckduckgo.com/',{params:{q,format:'json',no_html:1,skip_disambig:1},timeout:8000});
          const res=[]; const d=r.data;
          if(d.AbstractText) res.push({title:d.Heading,snippet:d.AbstractText,url:d.AbstractURL});
          (d.RelatedTopics||[]).slice(0,count-1).forEach(t=>{if(t.Text)res.push({title:t.Text.split(' - ')[0],snippet:t.Text,url:t.FirstURL});});
          return {success:true,query:q,results:res.slice(0,count),count:res.length};
        } catch(e){return {success:false,query:q,error:e.message,results:[]};}
      }
      case 'fetch_url': {
        const url=args.url||'';
        try {
          const r=await axios.get(url,{timeout:10000,headers:{'User-Agent':'Mozilla/5.0 AGII/12'},maxContentLength:500000});
          let text=typeof r.data==='string'?r.data:JSON.stringify(r.data);
          text=text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
          return {success:true,url,content:text};
        } catch(e){return {success:false,url,error:e.message};}
      }
      case 'execute_code': {
        try {
          const fn=new Function(`"use strict";const Math=globalThis.Math;const Date=globalThis.Date;const JSON=globalThis.JSON;${(args.code||'').includes('return')?args.code:'return ('+args.code+')'}`);
          return {success:true,result:String(fn()).slice(0,2000)};
        } catch(e){return {success:false,error:e.message};}
      }
      case 'remember': { const e=addMemory(args.type||'notes',args.content||''); addKGNode((args.content||'').slice(0,60),args.type||'notes'); return {success:true,stored:!!e}; }
      case 'recall': { return {success:true,query:args.query,results:searchMemory(args.query||'')}; }
      case 'write_file': {
        const fn=(args.filename||'file.txt').replace(/[^a-zA-Z0-9._-]/g,'_');
        fs.writeFileSync(path.join(DATA_DIR,'files',fn),args.content||'','utf8');
        return {success:true,filename:fn,size:(args.content||'').length,downloadUrl:`/api/files/${fn}`};
      }
      case 'read_file': {
        const fn=(args.filename||'').replace(/[^a-zA-Z0-9._-]/g,'_');
        const fp=path.join(DATA_DIR,'files',fn);
        if(!fs.existsSync(fp)) return {success:false,error:'File not found'};
        return {success:true,filename:fn,content:fs.readFileSync(fp,'utf8').slice(0,10000)};
      }
      case 'list_files': {
        const files=fs.readdirSync(path.join(DATA_DIR,'files')).map(f=>{const st=fs.statSync(path.join(DATA_DIR,'files',f));return {name:f,size:st.size,modified:st.mtime,url:`/api/files/${f}`};});
        return {success:true,files,count:files.length};
      }
      case 'create_skill': {
        const sk=loadJSON(path.join(DATA_DIR,'skills','registry.json'),{});
        const id=(args.name||'skill').replace(/[^a-zA-Z0-9_]/g,'_');
        sk[id]={id,name:args.name,description:args.description||'',code:args.code,created:new Date().toISOString(),runCount:0};
        saveJSON(path.join(DATA_DIR,'skills','registry.json'),sk);
        return {success:true,name:id};
      }
      case 'run_skill': {
        const sk=loadJSON(path.join(DATA_DIR,'skills','registry.json'),{});
        const skill=sk[args.name]; if(!skill) return {success:false,error:`Skill '${args.name}' not found`};
        try { const fn=new Function('args',skill.code); const r=fn(args.args||{}); skill.runCount=(skill.runCount||0)+1; skill.lastRun=new Date().toISOString(); saveJSON(path.join(DATA_DIR,'skills','registry.json'),sk); return {success:true,result:String(r).slice(0,2000)}; }
        catch(e){return {success:false,error:e.message};}
      }
      case 'list_skills': {
        const sk=loadJSON(path.join(DATA_DIR,'skills','registry.json'),{});
        return {success:true,skills:Object.values(sk).map(s=>({name:s.name,description:s.description,runCount:s.runCount}))};
      }
      case 'create_automation': {
        const au=loadJSON(path.join(DATA_DIR,'automations','registry.json'),{});
        const id=uuidv4();
        au[id]={id,name:args.name,task:args.task,cron:args.cron,active:true,created:new Date().toISOString(),runCount:0};
        saveJSON(path.join(DATA_DIR,'automations','registry.json'),au);
        return {success:true,id,name:args.name,cron:args.cron};
      }
      case 'spawn_agent': {
        const task=makeTask(uuidv4(),args.role||'researcher',args.task||'');
        const result=await runTask(task,sessionId,null);
        return {success:true,role:args.role,result:result.result||result.error};
      }
      case 'reason_and_plan': {
        const c=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:[{role:'system',content:'You are a deep reasoning engine. Think step by step.'},{role:'user',content:`Problem: ${args.problem}\n\nCreate a detailed structured plan.`}],temperature:0.3,max_tokens:2048});
        return {success:true,reasoning:c.choices[0].message.content};
      }
      case 'analyze_image_url': {
        const c=await groq.chat.completions.create({model:'meta-llama/llama-4-scout-17b-16e-instruct',messages:[{role:'user',content:[{type:'image_url',image_url:{url:args.url}},{type:'text',text:args.question||'Describe this image in detail.'}]}],max_tokens:1024});
        return {success:true,analysis:c.choices[0].message.content};
      }
      case 'calculate': { try{return {success:true,expression:args.expression,result:Function('"use strict";return ('+args.expression+')')()};}catch(e){return {success:false,error:e.message};} }
      case 'get_current_time': { const n=new Date(); return {success:true,iso:n.toISOString(),utc:n.toUTCString(),unix:n.getTime()}; }
      case 'get_agents': { return {success:true,agents:getAgentList()}; }
      default: return {success:false,error:`Unknown tool: ${name}`};
    }
  } catch(e) { return {success:false,error:e.message}; }
}

// ── AGENT TASK RUNNER ─────────────────────────────────────────────────────────
async function runTask(task, sessionId, send) {
  const agent=agents[task.role];
  if(!agent) return {success:false,error:`No agent: ${task.role}`};
  task.status='running'; task.started=new Date().toISOString(); saveTasks();
  updateAgent(task.role,{status:'working',tasksRunning:(agent.tasksRunning||0)+1});
  if(send) send({type:'agent_start',agent:agent.name,emoji:agent.emoji,task:task.desc});
  try {
    const messages=[{role:'system',content:`You are ${agent.name} (${agent.emoji}). ${agent.desc}.\nTask: ${task.desc}\nExecute with precision. Use tools when needed.`},{role:'user',content:task.desc}];
    let result=''; let itr=0;
    while(itr<5) {
      itr++;
      const comp=await groq.chat.completions.create({model:agent.model||'llama-3.3-70b-versatile',messages,tools:TOOLS,tool_choice:'auto',temperature:0.4,max_tokens:2048});
      const choice=comp.choices[0]; const msg=choice.message;
      messages.push(cleanMsg(msg));
      if(choice.finish_reason==='tool_calls'&&msg.tool_calls) {
        for(const tc of msg.tool_calls) {
          const a=parseArgs(tc.function.arguments);
          if(send) send({type:'agent_tool',agent:agent.name,tool:tc.function.name});
          const tr=await executeTool(tc.function.name,a,sessionId);
          messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(tr)});
        }
      } else { result=msg.content||''; break; }
    }
    task.status='completed'; task.result=result; task.completed=new Date().toISOString(); saveTasks();
    updateAgent(task.role,{status:'idle',tasksCompleted:(agent.tasksCompleted||0)+1,tasksRunning:Math.max(0,(agent.tasksRunning||1)-1)});
    if(send) send({type:'agent_done',agent:agent.name,emoji:agent.emoji,result:result.slice(0,200)});
    return {success:true,result};
  } catch(e) {
    task.status='failed'; task.error=e.message; task.completed=new Date().toISOString(); saveTasks();
    updateAgent(task.role,{status:'idle',errors:(agent.errors||0)+1,tasksRunning:Math.max(0,(agent.tasksRunning||1)-1)});
    return {success:false,error:e.message};
  }
}

// ── MISSION ORCHESTRATOR ──────────────────────────────────────────────────────
async function runMission(desc, sessionId, send) {
  const mId=uuidv4();
  updateAgent('orchestrator',{status:'planning'});
  if(send) send({type:'mission_start',missionId:mId});
  try {
    const planComp=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:[{role:'system',content:'You are a mission planning AI. Return only valid JSON.'},{role:'user',content:`Mission: "${desc}"\n\nPlan 2-4 tasks. Return:\n{"plan":"brief strategy","tasks":[{"role":"researcher|coder|analyst|writer|planner|critic|executor","desc":"specific task description","deps":[]}]}`}],temperature:0.2,max_tokens:800,response_format:{type:'json_object'}});
    const plan=JSON.parse(planComp.choices[0].message.content);
    if(send) send({type:'mission_plan',plan:plan.plan,count:plan.tasks?.length||0});
    updateAgent('orchestrator',{status:'idle',tasksCompleted:(agents.orchestrator?.tasksCompleted||0)+1});
    const tasks=(plan.tasks||[]).map(t=>makeTask(mId,t.role||'executor',t.desc||t.description||''));
    const done=new Set(); const results={};
    let tries=0;
    while(done.size<tasks.length&&tries<tasks.length*4) {
      tries++;
      for(let i=0;i<tasks.length;i++) {
        const task=tasks[i];
        if(done.has(task.id)||task.status==='failed'){done.add(task.id);continue;}
        const depsOk=(plan.tasks[i].deps||[]).every(d=>tasks[d]&&done.has(tasks[d].id));
        if(depsOk&&task.status==='pending'){results[i]=await runTask(task,sessionId,send);done.add(task.id);}
      }
      if(done.size<tasks.length) await new Promise(r=>setTimeout(r,50));
    }
    const synthesis=Object.values(results).filter(r=>r.success).map(r=>r.result).join('\n\n---\n\n');
    return {missionId:mId,plan:plan.plan,synthesis};
  } catch(e) {
    sysLog('error','orchestrator',e.message);
    updateAgent('orchestrator',{status:'idle'});
    return null;
  }
}

// ── PERSONAS ──────────────────────────────────────────────────────────────────
const personasFile=path.join(DATA_DIR,'personas','registry.json');
let personas=loadJSON(personasFile,{default:{id:'default',name:'AGII',avatar:'🤖',systemPrompt:`You are AGII — a production-grade distributed AI agent platform. You are sharp, precise, and genuinely powerful. You coordinate specialized sub-agents for complex missions, maintain persistent memory across sessions, and execute real tools. You reason deeply, delegate intelligently, and always deliver results. For complex multi-step tasks, use spawn_agent to delegate to specialists. Use tools proactively. Be concise but thorough.`,model:'llama-3.3-70b-versatile',temperature:0.7,created:new Date().toISOString()}});
function savePersonas(){saveJSON(personasFile,personas);}

// ── SESSIONS ──────────────────────────────────────────────────────────────────
const sessionCache={};
function getSession(id,personaId='default'){
  if(!sessionCache[id]){
    const f=path.join(DATA_DIR,'sessions',`${id}.json`);
    const p=personas[personaId]||personas['default'];
    sessionCache[id]=loadJSON(f,{id,messages:[],title:'New Conversation',created:new Date().toISOString(),model:p.model,personaId,pinned:false});
  }
  return sessionCache[id];
}
function saveSession(id){const s=sessionCache[id];if(s)saveJSON(path.join(DATA_DIR,'sessions',`${s.id}.json`),s);}
function listSessions(){
  try {
    return fs.readdirSync(path.join(DATA_DIR,'sessions')).filter(f=>f.endsWith('.json'))
      .map(f=>{const d=loadJSON(path.join(DATA_DIR,'sessions',f));return {id:d.id,title:d.title||'Untitled',created:d.created,messageCount:d.messages?.length||0,pinned:d.pinned,lastMessage:d.messages?.slice(-1)[0]?.content?.slice?.(0,80)||''};})
      .filter(s=>s.id).sort((a,b)=>new Date(b.created)-new Date(a.created));
  } catch {return [];}
}

// ── AGENT LOOP ────────────────────────────────────────────────────────────────
async function runAgentLoop(session, sessionId, send) {
  const persona=personas[session.personaId||'default']||personas['default'];
  const memCtx=getMemCtx();
  const sysPrompt=`${persona.systemPrompt}\n\nDate/time: ${new Date().toISOString()}\n${memCtx?`\nMemory:\n${memCtx}`:''}`;
  const messages=[{role:'system',content:sysPrompt},...session.messages.slice(-20).map(cleanMsg)];
  let finalResponse=''; let itr=0;
  while(itr<10){
    itr++;
    const comp=await groq.chat.completions.create({model:session.model||'llama-3.3-70b-versatile',messages,tools:TOOLS,tool_choice:'auto',temperature:persona.temperature||0.7,max_tokens:4096});
    const choice=comp.choices[0]; const msg=choice.message;
    messages.push(cleanMsg(msg));
    if(choice.finish_reason==='tool_calls'&&msg.tool_calls){
      for(const tc of msg.tool_calls){
        const a=parseArgs(tc.function.arguments);
        if(send) send({type:'tool_start',tool:tc.function.name,args:a});
        const tr=await executeTool(tc.function.name,a,sessionId);
        if(send) send({type:'tool_result',tool:tc.function.name,result:tr});
        messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(tr)});
      }
    } else {finalResponse=msg.content||'';break;}
  }
  return finalResponse;
}

// ── AUTOMATIONS ───────────────────────────────────────────────────────────────
const autoFile=path.join(DATA_DIR,'automations','registry.json');
let autoReg=loadJSON(autoFile,{});
const cronJobs={};
function saveAutoReg(){saveJSON(autoFile,autoReg);}
function scheduleAuto(a){
  if(cronJobs[a.id]){try{cronJobs[a.id].stop();}catch{}delete cronJobs[a.id];}
  if(!a.active||!a.cron) return;
  try{cronJobs[a.id]=cron.schedule(a.cron,async()=>{a.lastRun=new Date().toISOString();a.runCount=(a.runCount||0)+1;saveAutoReg();const sid=uuidv4();const s=getSession(sid);s.messages.push({role:'user',content:a.task});try{const r=await runAgentLoop(s,sid,null);a.lastResult=r.slice(0,500);}catch(e){a.lastResult=`Error: ${e.message}`;}saveAutoReg();});}
  catch(e){console.error('Cron:',e.message);}
}
Object.values(autoReg).forEach(a=>scheduleAuto(a));

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/health',(req,res)=>res.json({status:'ok',version:'12.0',timestamp:new Date().toISOString(),agents:Object.keys(agents).length}));

app.post('/api/chat',async(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  const send=d=>{if(!res.writableEnded)res.write(`data: ${JSON.stringify(d)}\n\n`);};
  try {
    const {message,sessionId=uuidv4(),model,imageUrl,useMission}=req.body;
    const session=getSession(sessionId);
    if(model) session.model=model;
    // Store message — cleanMsg() strips ts before Groq
    const userContent=imageUrl?[{type:'image_url',image_url:{url:imageUrl}},{type:'text',text:message}]:message;
    session.messages.push({role:'user',content:userContent,ts:new Date().toISOString()});
    if(session.messages.length===1&&session.title==='New Conversation'){session.title=(typeof message==='string'?message:'Vision query').slice(0,60)+(message.length>60?'…':'');}
    send({type:'start',sessionId});
    const complex=typeof message==='string'&&(message.length>150||/build|create a|research and|analyze and|develop|implement/i.test(message)||useMission);
    let finalResponse='';
    if(complex){
      send({type:'status',text:'🧠 Planning multi-agent mission...'});
      const mission=await runMission(message,sessionId,send);
      if(mission?.synthesis){
        send({type:'status',text:'🔗 Synthesizing agent results...'});
        const sc=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:[{role:'system',content:personas['default'].systemPrompt},{role:'user',content:`Original: ${message}\n\nAgent outputs:\n${mission.synthesis}\n\nSynthesize into a clear complete answer.`}],temperature:0.5,max_tokens:2048});
        finalResponse=sc.choices[0].message.content;
      } else {finalResponse=await runAgentLoop(session,sessionId,send);}
    } else {finalResponse=await runAgentLoop(session,sessionId,send);}
    const words=finalResponse.split(' ');
    for(let i=0;i<words.length;i++){send({type:'token',text:(i===0?'':' ')+words[i]});if(i%8===0)await new Promise(r=>setTimeout(r,4));}
    session.messages.push({role:'assistant',content:finalResponse,ts:new Date().toISOString()});
    saveSession(sessionId);
    send({type:'done',sessionId,title:session.title});
    res.end();
  } catch(e){sysLog('error','chat',e.message);send({type:'error',message:e.message});res.end();}
});

app.get('/api/sessions',(req,res)=>res.json(listSessions()));
app.get('/api/sessions/:id',(req,res)=>{const f=path.join(DATA_DIR,'sessions',`${req.params.id}.json`);const d=loadJSON(f,null);if(!d)return res.status(404).json({error:'Not found'});res.json(d);});
app.delete('/api/sessions/:id',(req,res)=>{const f=path.join(DATA_DIR,'sessions',`${req.params.id}.json`);if(fs.existsSync(f))fs.unlinkSync(f);delete sessionCache[req.params.id];res.json({success:true});});
app.put('/api/sessions/:id',(req,res)=>{const f=path.join(DATA_DIR,'sessions',`${req.params.id}.json`);const d=loadJSON(f,null);if(!d)return res.status(404).json({error:'Not found'});if(req.body.pinned!==undefined)d.pinned=req.body.pinned;if(req.body.title)d.title=req.body.title;saveJSON(f,d);res.json({success:true});});

app.get('/api/memory',(req,res)=>res.json(globalMemory));
app.post('/api/memory',(req,res)=>res.json({success:true,entry:addMemory(req.body.type||'notes',req.body.content||'')}));
app.delete('/api/memory/:type/:id',(req,res)=>{if(globalMemory[req.params.type]){globalMemory[req.params.type]=globalMemory[req.params.type].filter(i=>i.id!==req.params.id);saveMemory();}res.json({success:true});});
app.delete('/api/memory',(req,res)=>{Object.keys(globalMemory).forEach(k=>globalMemory[k]=[]);saveMemory();res.json({success:true});});

app.get('/api/agents',(req,res)=>res.json(getAgentList()));
app.get('/api/tasks',(req,res)=>res.json(Object.values(taskReg).sort((a,b)=>new Date(b.created)-new Date(a.created)).slice(0,100)));

app.get('/api/models',(req,res)=>res.json([
  {id:'llama-3.3-70b-versatile',name:'Llama 3.3 70B',provider:'Groq',speed:'Fast'},
  {id:'llama-3.1-8b-instant',name:'Llama 3.1 8B Instant',provider:'Groq',speed:'Ultra Fast'},
  {id:'meta-llama/llama-4-scout-17b-16e-instruct',name:'Llama 4 Scout 17B',provider:'Groq',speed:'Fast'},
  {id:'deepseek-r1-distill-llama-70b',name:'DeepSeek R1 70B',provider:'Groq',speed:'Medium'},
  {id:'qwen-qwq-32b',name:'Qwen QwQ 32B',provider:'Groq',speed:'Medium'},
  {id:'mixtral-8x7b-32768',name:'Mixtral 8x7B',provider:'Groq',speed:'Fast'},
]));

const getSkills=()=>loadJSON(path.join(DATA_DIR,'skills','registry.json'),{});
app.get('/api/skills',(req,res)=>res.json(Object.values(getSkills())));
app.delete('/api/skills/:id',(req,res)=>{const sk=getSkills();delete sk[req.params.id];saveJSON(path.join(DATA_DIR,'skills','registry.json'),sk);res.json({success:true});});

app.get('/api/automations',(req,res)=>res.json(Object.values(autoReg)));
app.post('/api/automations/:id/toggle',(req,res)=>{const a=autoReg[req.params.id];if(!a)return res.status(404).json({error:'Not found'});a.active=!a.active;saveAutoReg();if(a.active)scheduleAuto(a);else if(cronJobs[a.id]){try{cronJobs[a.id].stop();}catch{}delete cronJobs[a.id];}res.json({success:true,active:a.active});});
app.delete('/api/automations/:id',(req,res)=>{if(cronJobs[req.params.id]){try{cronJobs[req.params.id].stop();}catch{}delete cronJobs[req.params.id];}delete autoReg[req.params.id];saveAutoReg();res.json({success:true});});

app.get('/api/personas',(req,res)=>res.json(Object.values(personas)));
app.post('/api/personas',(req,res)=>{const id=uuidv4();personas[id]={id,...req.body,created:new Date().toISOString()};savePersonas();res.json({success:true,id});});
app.put('/api/personas/:id',(req,res)=>{if(!personas[req.params.id])return res.status(404).json({error:'Not found'});Object.assign(personas[req.params.id],req.body);savePersonas();res.json({success:true});});

app.get('/api/files',(req,res)=>{try{res.json(fs.readdirSync(path.join(DATA_DIR,'files')).map(f=>{const st=fs.statSync(path.join(DATA_DIR,'files',f));return {name:f,size:st.size,modified:st.mtime,url:`/api/files/${f}`};}));}catch{res.json([]);}});
app.get('/api/files/:name',(req,res)=>{const fn=req.params.name.replace(/[^a-zA-Z0-9._-]/g,'_');const fp=path.join(DATA_DIR,'files',fn);if(!fs.existsSync(fp))return res.status(404).json({error:'Not found'});res.download(fp,fn);});
app.post('/api/upload',upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'No file'});const ext=path.extname(req.file.originalname);const dest=path.join(DATA_DIR,'files',req.file.filename+ext);fs.moveSync(req.file.path,dest);res.json({success:true,filename:req.file.filename+ext,url:`/api/files/${req.file.filename+ext}`});});

app.get('/api/logs',(req,res)=>{try{const t=new Date().toISOString().slice(0,10);res.json(loadJSON(path.join(DATA_DIR,'logs',`${t}.json`),[]).slice(-200).reverse());}catch{res.json([]);}});
app.get('/api/knowledge',(req,res)=>res.json(kg));
app.get('/api/stats',(req,res)=>{const ss=listSessions();res.json({sessions:ss.length,totalMessages:ss.reduce((s,x)=>s+(x.messageCount||0),0),memoryItems:Object.values(globalMemory).reduce((s,a)=>s+(Array.isArray(a)?a.length:0),0),skills:Object.keys(getSkills()).length,automations:Object.keys(autoReg).length,agents:Object.keys(agents).length,tasks:Object.keys(taskReg).length,knowledgeNodes:kg.nodes.length,uptime:Math.floor(process.uptime())});});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{console.log(`🚀 AGII v12 on port ${PORT} | ${Object.keys(agents).length} agents ready`);});
