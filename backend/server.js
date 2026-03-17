/**
 * AGII v17 — Production AI Agent Platform
 * Real: Groq inference, Tavily search, E2B code execution, Supabase memory
 * Real SSE streaming, multi-agent orchestration, self-optimization loop
 */
'use strict';
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const compress   = require('compression');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const { v4: uid } = require('uuid');
const Groq       = require('groq-sdk');
const axios      = require('axios');
const cron       = require('node-cron');

const PORT      = process.env.PORT || 10000;
const GROQ_KEY  = process.env.GROQ_API_KEY;
const TAVILY    = process.env.TAVILY_API_KEY;
const E2B_KEY   = process.env.E2B_API_KEY;
const SB_URL    = process.env.SUPABASE_URL;
const SB_KEY    = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const VERSION   = '17.0';

if (!GROQ_KEY) { console.error('GROQ_API_KEY missing'); process.exit(1); }

const groq = new Groq({ apiKey: GROQ_KEY });

let supabase = null;
if (SB_URL && SB_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SB_URL, SB_KEY);
    console.log('Supabase connected');
  } catch(e) { console.log('Supabase unavailable'); }
}

const DATA_DIR     = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const MEMORY_DIR   = path.join(DATA_DIR, 'memory');
const FILES_DIR    = path.join(DATA_DIR, 'files');
const OPTIM_DIR    = path.join(DATA_DIR, 'optim');
[DATA_DIR, SESSIONS_DIR, MEMORY_DIR, FILES_DIR, OPTIM_DIR].forEach(d => fs.mkdirSync(d, {recursive:true}));

function rj(fp, def) { try { return JSON.parse(fs.readFileSync(fp,'utf8')); } catch { return def; } }
function wj(fp, d) { fs.writeFileSync(fp, JSON.stringify(d,null,2)); }
function ts() { return new Date().toISOString(); }

const MODELS = {
  'llama-3.3-70b': { id:'llama-3.3-70b-versatile', ctx:128000 },
  'llama-3.1-8b':  { id:'llama-3.1-8b-instant',    ctx:128000 },
  'mixtral-8x7b':  { id:'mixtral-8x7b-32768',       ctx:32768  },
  'gemma2-9b':     { id:'gemma2-9b-it',             ctx:8192   },
};

function detectDomain(msg) {
  const m = msg.toLowerCase();
  if (/\bcode\b|function|class|import|def |const |python|javascript|typescript|compile|debug/.test(m)) return 'coding';
  if (/\bmath\b|calcul|equation|integral|derivative|algebra|statistic/.test(m)) return 'math';
  if (/physics|chemistry|biology|quantum|molecule|astronomy/.test(m)) return 'science';
  return 'general';
}

function domainModel(domain) {
  return { coding:'llama-3.3-70b', math:'mixtral-8x7b', science:'mixtral-8x7b', general:'llama-3.3-70b' }[domain] || 'llama-3.3-70b';
}

async function callGroq(params, retries=3) {
  for (let i=0; i<=retries; i++) {
    try {
      return await Promise.race([
        groq.chat.completions.create(params),
        new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),30000))
      ]);
    } catch(e) {
      const msg = String(e.message||e);
      const wait = msg.includes('429') ? (()=>{ const m=msg.match(/try again in ([0-9.]+)s/i); return m?Math.ceil(parseFloat(m[1])*1000)+500:8000; })() : 2000;
      if (i < retries && (msg.includes('429')||msg.includes('timeout'))) {
        console.log(`[groq] retry ${i+1} after ${Math.round(wait/1000)}s`);
        await new Promise(r=>setTimeout(r,wait));
      } else throw e;
    }
  }
}

function sseStart(res, sid) {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  sse(res, {type:'start', sessionId:sid});
}
function sse(res, obj) { try { res.write('data: '+JSON.stringify(obj)+'\n\n'); } catch {} }
function sseDone(res, sid, extra={}) { sse(res,{type:'done',sessionId:sid,...extra}); res.end(); }

const WS_CLIENTS = new Set();
function broadcast(obj) {
  const m = JSON.stringify(obj);
  WS_CLIENTS.forEach(ws=>{ try{ws.send(m);}catch{WS_CLIENTS.delete(ws);} });
}

const TOOLS = [
  { type:'function', function:{ name:'web_search', description:'Search the internet for real-time information. Use for news, current events, prices, research.', parameters:{ type:'object', properties:{ query:{type:'string',description:'Search query'} }, required:['query'] } } },
  { type:'function', function:{ name:'execute_code', description:'Execute Python, JavaScript, or bash in a cloud sandbox. Use for calculations, data processing, algorithms.', parameters:{ type:'object', properties:{ code:{type:'string'}, language:{type:'string',enum:['python','javascript','bash']} }, required:['code','language'] } } },
  { type:'function', function:{ name:'remember', description:'Store important information in persistent memory for future conversations.', parameters:{ type:'object', properties:{ content:{type:'string'}, category:{type:'string',enum:['fact','preference','project','skill','domain']}, importance:{type:'integer'} }, required:['content'] } } },
  { type:'function', function:{ name:'recall', description:'Search long-term memory for previously stored information.', parameters:{ type:'object', properties:{ query:{type:'string'} }, required:['query'] } } },
  { type:'function', function:{ name:'write_file', description:'Create a file (code, report, data). Returns a download link.', parameters:{ type:'object', properties:{ filename:{type:'string'}, content:{type:'string'} }, required:['filename','content'] } } },
  { type:'function', function:{ name:'spawn_agent', description:'Delegate to a specialist: researcher, coder, analyst, writer, scientist, planner, critic.', parameters:{ type:'object', properties:{ role:{type:'string',enum:['researcher','coder','analyst','writer','scientist','planner','critic']}, task:{type:'string'} }, required:['role','task'] } } },
];

const AGENTS = {
  researcher: { name:'Researcher', emoji:'🔍', model:'llama-3.3-70b', tools:['web_search','remember','write_file'],
    prompt:'You are a world-class research agent. Search thoroughly, synthesize multiple sources, verify facts, deliver comprehensive reports with citations.' },
  coder:      { name:'Code Engineer', emoji:'💻', model:'llama-3.3-70b', tools:['execute_code','write_file','web_search'],
    prompt:'You are an expert software engineer. Write production-quality code, execute it to verify it works, fix errors, deliver working tested solutions.' },
  analyst:    { name:'Analyst', emoji:'📊', model:'mixtral-8x7b', tools:['execute_code','web_search','write_file'],
    prompt:'You are a data analyst. Analyze data, run computations, create insights, deliver actionable findings.' },
  writer:     { name:'Writer', emoji:'✍️', model:'llama-3.3-70b', tools:['write_file','web_search'],
    prompt:'You are a professional writer. Create clear, compelling content tailored for the audience.' },
  scientist:  { name:'Scientist', emoji:'🔬', model:'mixtral-8x7b', tools:['execute_code','web_search','write_file'],
    prompt:'Expert scientist: physics, chemistry, biology, quantum mechanics, aerospace, engineering. Solve problems with mathematical rigor.' },
  planner:    { name:'Planner', emoji:'📋', model:'gemma2-9b', tools:['remember','write_file'],
    prompt:'Strategic planner. Break complex goals into executable steps, identify dependencies, create actionable project plans.' },
  critic:     { name:'Critic', emoji:'🎯', model:'mixtral-8x7b', tools:['execute_code','web_search'],
    prompt:'Quality assurance expert. Review for correctness, completeness, logical consistency. Flag issues and suggest improvements.' },
};

async function toolWebSearch(args) {
  const query = args.query||'';
  console.log('[tool] web_search:', query.slice(0,60));
  if (!TAVILY) {
    try {
      const r = await axios.get('https://api.duckduckgo.com/', { params:{q:query,format:'json',no_html:1,skip_disambig:1}, timeout:8000 });
      const d = r.data;
      return { success:true, query, answer:d.AbstractText||d.Answer||'', results:[{title:'DuckDuckGo',snippet:d.AbstractText||d.Answer||'No direct answer',url:d.AbstractURL||''}].concat((d.RelatedTopics||[]).slice(0,3).map(t=>({title:'Related',snippet:t.Text||'',url:t.FirstURL||''}))), note:'Using DuckDuckGo (Tavily not configured)' };
    } catch(e) { return {success:false,error:e.message,query}; }
  }
  try {
    const r = await axios.post('https://api.tavily.com/search', { api_key:TAVILY, query, search_depth:'advanced', include_answer:true, max_results:6 }, {timeout:15000});
    return { success:true, query, answer:r.data.answer||'', results:(r.data.results||[]).map(x=>({title:x.title,snippet:x.content,url:x.url,score:x.score})) };
  } catch(e) { return {success:false,error:e.message,query}; }
}

async function toolExecuteCode(args, sessionId) {
  const { code, language='python' } = args;
  console.log(`[tool] execute_code [${language}]:`, code.slice(0,60));
  broadcast({type:'code_execution',sessionId,language,preview:code.slice(0,80)});
  if (E2B_KEY) {
    try {
      const { CodeInterpreter } = require('@e2b/code-interpreter');
      const sb = await CodeInterpreter.create({apiKey:E2B_KEY,timeoutMs:30000});
      try {
        if (language==='python') {
          const r = await sb.notebook.execCell(code);
          const out = [...(r.logs?.stdout||[]),...(r.logs?.stderr||[])].join('\n');
          return {success:!r.error,language,output:out||'(no output)',error:r.error?`${r.error.name}: ${r.error.value}`:'',env:'e2b_cloud'};
        } else {
          const r = await sb.notebook.execCell(`import subprocess\nr=subprocess.run(['bash','-c',${JSON.stringify(language==='bash'?code:`node -e ${JSON.stringify(code)}`)}],capture_output=True,text=True,timeout=20)\nprint(r.stdout)\nif r.stderr:print('ERR:',r.stderr)`);
          return {success:true,language,output:r.logs?.stdout?.join('\n')||'',env:'e2b_cloud'};
        }
      } finally { await sb.close(); }
    } catch(e) { console.log('[tool] E2B error:', e.message.slice(0,80)); }
  }
  // Fallback: python3 subprocess
  if (language==='python') {
    try {
      const {execSync}=require('child_process');
      const f='/tmp/agii_'+uid().slice(0,8)+'.py';
      fs.writeFileSync(f,code);
      const out=execSync(`python3 "${f}"`,{timeout:10000,encoding:'utf8'});
      fs.unlinkSync(f);
      return {success:true,language,output:out||'(no output)',env:'local_python'};
    } catch(e) { return {success:false,language,error:e.message.slice(0,400),output:e.stdout||'',env:'local_python'}; }
  }
  if (language==='javascript') {
    try {
      const vm=require('vm');
      const logs=[];
      const ctx={console:{log:(...a)=>logs.push(a.map(String).join(' ')),error:(...a)=>logs.push('ERR: '+a.map(String).join(' '))},Math,JSON,Object,Array,String,Number,Date};
      vm.createContext(ctx); vm.runInContext(code,ctx,{timeout:5000});
      return {success:true,language,output:logs.join('\n')||'(no output)',env:'node_vm'};
    } catch(e) { return {success:false,language,error:e.message,output:'',env:'node_vm'}; }
  }
  return {success:false,error:'No execution env for '+language};
}

async function toolRemember(args, sessionId) {
  const entry={id:uid(),content:args.content,category:args.category||'fact',importance:args.importance||5,sessionId,ts:ts()};
  if (supabase) { try { await supabase.from('memories').insert(entry); } catch {} }
  const fp=path.join(MEMORY_DIR,'memories.json');
  const m=rj(fp,[]); m.unshift(entry); if(m.length>1000)m.splice(1000); wj(fp,m);
  broadcast({type:'memory_added',entry});
  return {success:true,id:entry.id};
}

function toolRecall(args) {
  const q=(args.query||'').toLowerCase();
  const m=rj(path.join(MEMORY_DIR,'memories.json'),[]);
  return {success:true,memories:m.filter(x=>x.content?.toLowerCase().includes(q)).slice(0,10)};
}

function toolWriteFile(args, sessionId) {
  const safe=(args.filename||'file.txt').replace(/[^a-zA-Z0-9._-]/g,'_');
  const fp=path.join(FILES_DIR,`${sessionId}_${safe}`);
  fs.writeFileSync(fp,args.content||'');
  return {success:true,filename:safe,download:`/api/files/${sessionId}_${safe}`,size:(args.content||'').length};
}

async function toolSpawnAgent(args, res, sessionId) {
  const {role,task}=args;
  const agent=AGENTS[role];
  if (!agent) return {success:false,error:`Unknown role: ${role}`};
  console.log(`[agent] ${role}: ${task.slice(0,60)}`);
  broadcast({type:'agent_spawned',role,name:agent.name,sessionId});
  if (res) sse(res,{type:'agent_start',role,name:agent.name,emoji:agent.emoji,task:task.slice(0,80)});
  const modelId=MODELS[agent.model]?.id||MODELS['llama-3.3-70b'].id;
  const agentTools=TOOLS.filter(t=>agent.tools.includes(t.function.name));
  const msgs=[
    {role:'system',content:agent.prompt+'\n\nUSE YOUR TOOLS to actually complete this task. Do not just describe — execute.'},
    {role:'user',content:task}
  ];
  let final=''; let itr=0;
  while(itr<5) {
    itr++;
    let resp;
    try { resp=await callGroq({model:modelId,messages:msgs,tools:agentTools,tool_choice:'auto',temperature:0.4,max_tokens:2048}); }
    catch(e) { final=`Agent error: ${e.message}`; break; }
    const msg=resp.choices[0].message;
    if (!msg.tool_calls?.length) { final=msg.content||'Done.'; break; }
    msgs.push({role:'assistant',content:msg.content||null,tool_calls:msg.tool_calls});
    for (const tc of msg.tool_calls) {
      const n=tc.function.name; let a; try{a=JSON.parse(tc.function.arguments);}catch{a={};}
      if (res) sse(res,{type:'agent_tool',role,tool:n});
      const r=await runTool(n,a,null,sessionId);
      msgs.push({role:'tool',tool_call_id:tc.id,name:n,content:JSON.stringify(r).slice(0,6000)});
    }
  }
  if (res) sse(res,{type:'agent_done',role,name:agent.name,preview:final.slice(0,150)});
  broadcast({type:'agent_completed',role,sessionId});
  return {success:true,role,result:final};
}

async function runTool(name, args, res, sessionId) {
  try {
    switch(name) {
      case 'web_search':   return await toolWebSearch(args);
      case 'execute_code': return await toolExecuteCode(args,sessionId);
      case 'remember':     return await toolRemember(args,sessionId);
      case 'recall':       return toolRecall(args);
      case 'write_file':   return toolWriteFile(args,sessionId);
      case 'spawn_agent':  return await toolSpawnAgent(args,res,sessionId);
      default:             return {success:false,error:'Unknown tool: '+name};
    }
  } catch(e) { return {success:false,error:e.message}; }
}

const SYSTEM_PROMPT = `You are AGII — an advanced autonomous AI agent. You have real tools. USE THEM.

TOOLS YOU HAVE:
- web_search: real-time internet search. Use for ANY current info, news, prices, facts you might not know.
- execute_code: run Python/JS/bash in cloud sandbox. Use for ALL calculations, data processing, code tasks.
- remember / recall: persistent memory across sessions.
- write_file: create downloadable files.
- spawn_agent: delegate to specialist (researcher, coder, analyst, writer, scientist, planner).

RULES:
1. For current info → SEARCH, never guess.
2. For code/math → EXECUTE, never just show code.
3. For complex tasks → SPAWN the right agent.
4. Be direct, precise, expert-level. No filler.
5. You operate in ALL domains: engineering, physics, quantum, biology, medicine, finance, law, aerospace, software, chemistry.

You are not a chatbot. You are an agent that gets things done.`;

async function handleChat(req, res) {
  const {message, sessionId:sid, model:mp} = req.body;
  if (!message?.trim()) return res.status(400).json({error:'No message'});
  const sessionId = sid||uid();
  sseStart(res, sessionId);
  const sf=path.join(SESSIONS_DIR,`${sessionId}.json`);
  const session=rj(sf,{id:sessionId,messages:[],created:ts(),tool_calls:0});
  const domain=detectDomain(message);
  const mkey=(mp&&mp!=='auto'&&MODELS[mp])?mp:domainModel(domain);
  const mid=MODELS[mkey].id;
  // Load relevant memory
  const mems=rj(path.join(MEMORY_DIR,'memories.json'),[]).filter(m=>m.content?.toLowerCase().includes(message.toLowerCase().split(' ').slice(0,2).join(' '))).slice(0,4);
  const memCtx=mems.length?'\n\nMEMORY:\n'+mems.map(m=>'- '+m.content).join('\n'):'';
  session.messages.push({role:'user',content:message,ts:ts()});
  const history=session.messages.slice(-30).map(m=>{
    const c={role:m.role,content:m.content};
    if(m.tool_calls)c.tool_calls=m.tool_calls;
    if(m.tool_call_id)c.tool_call_id=m.tool_call_id;
    if(m.name)c.name=m.name;
    return c;
  }).filter(m=>(m.content!=null)||m.tool_calls);
  const callMsgs=[{role:'system',content:SYSTEM_PROMPT+memCtx},...history];
  let finalResponse=''; let toolsUsed=[]; let itr=0;
  sse(res,{type:'thinking',sessionId,model:mkey,domain});
  broadcast({type:'chat_start',sessionId,domain,model:mkey});
  while(itr<8) {
    itr++;
    let resp;
    try {
      resp=await callGroq({model:mid,messages:callMsgs,tools:TOOLS,tool_choice:'auto',temperature:0.7,max_tokens:4096});
    } catch(e) {
      try {
        resp=await callGroq({model:MODELS['llama-3.3-70b'].id,messages:callMsgs.filter(m=>m.role!=='tool').map(m=>({role:m.role,content:m.content||''})),temperature:0.7,max_tokens:4096});
      } catch(e2) { sse(res,{type:'error',message:e2.message}); return sseDone(res,sessionId); }
    }
    const msg=resp.choices[0].message;
    if (!msg.tool_calls?.length) {
      const text=msg.content||'';
      const words=text.split(/(\s+)/);
      for(const w of words) if(w) sse(res,{type:'token',text:w});
      finalResponse=text; break;
    }
    callMsgs.push({role:'assistant',content:msg.content||null,tool_calls:msg.tool_calls});
    session.tool_calls+=msg.tool_calls.length;
    for(const tc of msg.tool_calls) {
      const n=tc.function.name; let a; try{a=JSON.parse(tc.function.arguments);}catch{a={};}
      sse(res,{type:'tool_start',tool:n,args:a});
      broadcast({type:'tool_executing',tool:n,sessionId});
      const r=await runTool(n,a,res,sessionId);
      toolsUsed.push({tool:n,success:!!r.success});
      sse(res,{type:'tool_result',tool:n,result:r,success:!!r.success});
      callMsgs.push({role:'tool',tool_call_id:tc.id,name:n,content:JSON.stringify(r).slice(0,8000)});
    }
  }
  if (!finalResponse) {
    sse(res,{type:'thinking',phase:'synthesizing'});
    try {
      const s=await callGroq({model:MODELS['llama-3.3-70b'].id,messages:[{role:'system',content:'Synthesize tool results into a clear complete answer.'},{role:'user',content:message},...callMsgs.slice(-6).filter(m=>m.role==='tool')],temperature:0.5,max_tokens:3000});
      const t=s.choices[0].message.content||'Done.';
      for(const w of t.split(/(\s+)/)) if(w) sse(res,{type:'token',text:w});
      finalResponse=t;
    } catch { finalResponse='Task completed.'; sse(res,{type:'token',text:finalResponse}); }
  }
  session.messages.push({role:'assistant',content:finalResponse,ts:ts(),model:mkey,domain,tools_used:toolsUsed.map(t=>t.tool)});
  wj(sf,session);
  broadcast({type:'chat_done',sessionId,tools:toolsUsed.length,model:mkey});
  sseDone(res,sessionId,{tools_used:toolsUsed,model:mkey,domain});
}

// Benchmarks
async function runBenchmark(cap) {
  const tests={
    reasoning:[{q:'A bat and ball cost $1.10. Bat costs $1 more than ball. Ball cost?',a:'0.05'},{q:'What comes next: 2,4,8,16?',a:'32'},{q:'All roses are flowers. Some flowers fade fast. Can all roses fade fast?',a:'no'}],
    coding:[{q:'What is Big O of quicksort average case?',a:'n log'},{q:'Stack vs queue difference?',a:'LIFO'},{q:'What does async/await do?',a:'async'}],
    math:[{q:'Integral of x^2?',a:'x^3'},{q:'Derivative of sin(x)?',a:'cos'},{q:'Solve 3x+7=22',a:'5'}],
    science:[{q:'Speed of light in m/s?',a:'299'},{q:'Atomic number of carbon?',a:'6'},{q:"Newton's 2nd law formula?",a:'ma'}],
  };
  const qs=tests[cap]||tests.reasoning;
  let correct=0; const t0=Date.now();
  for(const {q,a} of qs){
    try{const r=await callGroq({model:MODELS['llama-3.1-8b'].id,messages:[{role:'user',content:'Answer in one sentence: '+q}],temperature:0.1,max_tokens:80});
    if((r.choices[0].message.content||'').toLowerCase().includes(a.toLowerCase()))correct++;}catch{}
  }
  const score=correct/qs.length;
  const hist=rj(path.join(DATA_DIR,'benchmarks.json'),[]); hist.push({capability:cap,score,correct,total:qs.length,ts:ts(),ms:Date.now()-t0}); if(hist.length>200)hist.splice(0,hist.length-200); wj(path.join(DATA_DIR,'benchmarks.json'),hist);
  return {capability:cap,score,correct,total:qs.length,ms:Date.now()-t0};
}

const optimState=rj(path.join(OPTIM_DIR,'state.json'),{version:VERSION,cycles:0,best_score:0,history:[]});
async function runOptimCycle() {
  if(optimState.running)return;
  optimState.running=true;
  broadcast({type:'optimization_start',cycle:optimState.cycles+1});
  const caps=['reasoning','coding','math'];
  const scores={};
  for(const c of caps){try{const r=await runBenchmark(c);scores[c]=r.score;}catch{scores[c]=0;}}
  const overall=Object.values(scores).reduce((a,b)=>a+b,0)/caps.length;
  optimState.cycles++;
  const cycle={n:optimState.cycles,scores,overall,improved:overall>optimState.best_score,ts:ts()};
  if(overall>optimState.best_score)optimState.best_score=overall;
  optimState.history.push(cycle); if(optimState.history.length>50)optimState.history.shift();
  optimState.running=false; wj(path.join(OPTIM_DIR,'state.json'),optimState);
  broadcast({type:'optimization_done',...cycle});
  return cycle;
}
cron.schedule('0 */6 * * *',runOptimCycle);

const app=express();
app.use(cors({origin:'*'}));
app.use(compress());
app.use(express.json({limit:'10mb'}));
const FRONTEND=path.join(__dirname,'..','frontend');
if(fs.existsSync(FRONTEND))app.use(express.static(FRONTEND));

app.get('/health',(req,res)=>res.json({status:'ok',version:VERSION,uptime:Math.floor(process.uptime()),features:{tavily:!!TAVILY,e2b:!!E2B_KEY,supabase:!!supabase},agents:Object.keys(AGENTS).length,ts:ts()}));
app.get('/',(req,res)=>{const fp=path.join(FRONTEND,'index.html');if(fs.existsSync(fp))res.sendFile(fp);else res.json({name:'AGII',version:VERSION});});
app.post('/api/chat',handleChat);

app.get('/api/sessions',(req,res)=>{
  try{const f=fs.readdirSync(SESSIONS_DIR).filter(x=>x.endsWith('.json'));
  res.json(f.slice(-50).map(x=>{const s=rj(path.join(SESSIONS_DIR,x),{});return{id:s.id,created:s.created,messages:s.messages?.length||0,last:s.messages?.slice(-1)[0]?.content?.slice(0,80)||''};}).sort((a,b)=>new Date(b.created)-new Date(a.created)));}catch{res.json([]);}
});
app.get('/api/sessions/:id',(req,res)=>{const s=rj(path.join(SESSIONS_DIR,req.params.id+'.json'),null);s?res.json(s):res.status(404).json({error:'Not found'});});
app.delete('/api/sessions/:id',(req,res)=>{try{fs.unlinkSync(path.join(SESSIONS_DIR,req.params.id+'.json'));res.json({success:true});}catch{res.json({success:false});}});

app.get('/api/memory',(req,res)=>{let m=rj(path.join(MEMORY_DIR,'memories.json'),[]);const{limit=50,search,category}=req.query;if(category)m=m.filter(x=>x.category===category);if(search)m=m.filter(x=>x.content?.toLowerCase().includes(search.toLowerCase()));res.json(m.slice(0,parseInt(limit)));});
app.delete('/api/memory/:id',(req,res)=>{const fp=path.join(MEMORY_DIR,'memories.json');let m=rj(fp,[]);m=m.filter(x=>x.id!==req.params.id);wj(fp,m);res.json({success:true});});

app.get('/api/agents',(req,res)=>res.json(Object.entries(AGENTS).map(([id,a])=>({id,name:a.name,emoji:a.emoji,model:a.model,status:'idle'}))));

app.get('/api/files',(req,res)=>{try{res.json(fs.readdirSync(FILES_DIR).map(f=>({name:f,size:fs.statSync(path.join(FILES_DIR,f)).size,download:'/api/files/'+f})));}catch{res.json([]);}});
app.get('/api/files/:name',(req,res)=>{const fp=path.join(FILES_DIR,req.params.name);fs.existsSync(fp)?res.download(fp):res.status(404).json({error:'Not found'});});

app.post('/api/benchmark',async(req,res)=>{try{const r=await runBenchmark(req.body.capability||'reasoning');broadcast({type:'benchmark_result',...r});res.json(r);}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/benchmark/history',(req,res)=>res.json(rj(path.join(DATA_DIR,'benchmarks.json'),[])));

app.get('/api/optimization',(req,res)=>res.json(optimState));
app.post('/api/optimization/run',async(req,res)=>{const r=await runOptimCycle();res.json(r||{error:'already running'});});

app.get('/api/stats',(req,res)=>{
  const sessions=fs.readdirSync(SESSIONS_DIR).filter(f=>f.endsWith('.json')).length;
  const memories=rj(path.join(MEMORY_DIR,'memories.json'),[]).length;
  res.json({sessions,memories,files:fs.readdirSync(FILES_DIR).length,agents:Object.keys(AGENTS).length,version:VERSION,uptime:Math.floor(process.uptime()),features:{tavily:!!TAVILY,e2b:!!E2B_KEY,supabase:!!supabase}});
});

app.post('/api/mission',async(req,res)=>{
  const{goal,sessionId:sid}=req.body;
  if(!goal)return res.status(400).json({error:'No goal'});
  const sessionId=sid||uid();
  sseStart(res,sessionId);
  sse(res,{type:'mission_start',goal:goal.slice(0,100),sessionId});
  let plan;
  try{
    const r=await callGroq({model:MODELS['llama-3.3-70b'].id,messages:[{role:'user',content:`Break this goal into 2-4 subtasks, each for a specialist agent.\nGoal: "${goal}"\nAgents: ${Object.keys(AGENTS).join(', ')}\nJSON: {"tasks":[{"role":"name","task":"what to do"}]}`}],temperature:0.3,max_tokens:600});
    const c=r.choices[0].message.content||'';
    plan=JSON.parse(c.slice(c.indexOf('{'),c.lastIndexOf('}')+1));
  }catch{plan={tasks:[{role:'researcher',task:goal}]};}
  sse(res,{type:'plan',tasks:plan.tasks});
  const results=[];
  for(const{role,task}of(plan.tasks||[])){
    if(!AGENTS[role])continue;
    const r=await toolSpawnAgent({role,task},res,sessionId);
    results.push({role,result:r.result?.slice(0,400)||''});
  }
  sse(res,{type:'thinking',phase:'synthesizing'});
  try{
    const r=await callGroq({model:MODELS['llama-3.3-70b'].id,messages:[{role:'system',content:'Synthesize agent results into a comprehensive final report.'},{role:'user',content:`Mission: "${goal}"\n\nResults:\n${results.map(r=>`${r.role}: ${r.result}`).join('\n\n')}`}],temperature:0.5,max_tokens:2000});
    const t=r.choices[0].message.content||'Mission complete.';
    for(const w of t.split(/(\s+)/)) if(w) sse(res,{type:'token',text:w});
  }catch{sse(res,{type:'token',text:'Mission complete.'});}
  sseDone(res,sessionId,{subtasks:results.length});
});

app.get('/api/models',(req,res)=>res.json(Object.entries(MODELS).map(([k,v])=>({id:k,modelId:v.id}))));

const server=http.createServer(app);
const{WebSocketServer}=require('ws');
const wss=new WebSocketServer({server});
wss.on('connection',ws=>{
  WS_CLIENTS.add(ws);
  ws.on('close',()=>WS_CLIENTS.delete(ws));
  ws.on('error',()=>WS_CLIENTS.delete(ws));
  ws.send(JSON.stringify({type:'connected',version:VERSION}));
});

server.listen(PORT,()=>{
  console.log(`AGII v${VERSION} on port ${PORT}`);
  console.log(`Groq:OK Tavily:${TAVILY?'OK':'NO'} E2B:${E2B_KEY?'OK':'NO'} Supabase:${supabase?'OK':'NO'}`);
});

process.on('uncaughtException',e=>console.error('[uncaught]',e.message));
process.on('unhandledRejection',e=>console.error('[unhandled]',e?.message||e));
