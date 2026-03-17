'use strict';
const express=require('express');
const cors=require('cors');
const fs=require('fs');
const path=require('path');
const {v4:uid}=require('uuid');
const Groq=require('groq-sdk');

const app=express();
app.use(cors());
app.use(express.json({limit:'10mb'}));

const groq=new Groq({apiKey:process.env.GROQ_API_KEY});
const PORT=process.env.PORT||3001;
const DATA=process.env.DATA_DIR||'/tmp/agii-data';
['sessions','memory','files','skills','projects'].forEach(d=>fs.mkdirSync(path.join(DATA,d),{recursive:true}));

// ── HELPERS ──────────────────────────────────────────────────────────────────
const rj=(f,d={})=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return d;}};
const wj=(f,d)=>fs.writeFileSync(f,JSON.stringify(d,null,2));
const pa=(s)=>{try{return typeof s==='object'?s:JSON.parse(s||'{}');}catch{return {};}};
const cm=(m)=>{
  if(!m||typeof m!=='object') return null;
  const r={role:m.role||'user'};
  if(m.content!==undefined&&m.content!==null) r.content=typeof m.content==='string'?m.content:JSON.stringify(m.content);
  else r.content=null;
  if(m.tool_calls) r.tool_calls=m.tool_calls;
  if(m.tool_call_id) r.tool_call_id=m.tool_call_id;
  return r;
};

// ── DOMAIN ROUTING ───────────────────────────────────────────────────────────
const DOMAINS={
  code:     {model:'meta-llama/Llama-3.3-70B-Instruct-Turbo', keywords:['code','function','debug','build','deploy','app','software','program','algorithm','script','api','database','bug','error','implement']},
  science:  {model:'meta-llama/Llama-3.3-70B-Instruct-Turbo', keywords:['physics','quantum','biology','chemistry','molecular','protein','dna','atom','particle','relativity','thermodynamics','mechanics']},
  aerospace:{model:'meta-llama/Llama-3.3-70B-Instruct-Turbo', keywords:['aerospace','rocket','satellite','orbit','thrust','trajectory','flight','aerodynamics','propulsion','spacecraft','nasa','esa']},
  math:     {model:'Qwen/Qwen2.5-7B-Instruct-Turbo',          keywords:['calculate','equation','integral','derivative','matrix','vector','proof','theorem','solve','formula','geometry','algebra']},
  search:   {model:'meta-llama/Llama-3.3-70B-Instruct-Turbo', keywords:['latest','news','current','today','find','research','look up','what happened','recent','2025','2026']},
  default:  {model:'meta-llama/Llama-3.3-70B-Instruct-Turbo', keywords:[]},
};

function routeModel(text){
  const t=(text||'').toLowerCase();
  for(const[domain,cfg]of Object.entries(DOMAINS)){
    if(domain==='default') continue;
    if(cfg.keywords.some(k=>t.includes(k))) return {domain, model:cfg.model};
  }
  return {domain:'default', model:DOMAINS.default.model};
}

// ── TOOLS ────────────────────────────────────────────────────────────────────
const TOOLS=[
  {type:'function',function:{name:'search',description:'Search the internet for real-time information, news, facts, and current events. Use this for any question about recent events, current data, or facts that need verification.',parameters:{type:'object',properties:{query:{type:'string',description:'The search query'},depth:{type:'string',enum:['basic','advanced'],description:'Search depth - use advanced for complex research'}},required:['query']}}},
  {type:'function',function:{name:'run_code',description:'Execute code in a secure sandbox. Supports Python, JavaScript, bash. Returns output, errors, and any generated files.',parameters:{type:'object',properties:{language:{type:'string',enum:['python','javascript','bash'],description:'Programming language'},code:{type:'string',description:'The code to execute'},install:{type:'string',description:'Packages to install first (e.g. "numpy pandas matplotlib")'}},required:['language','code']}}},
  {type:'function',function:{name:'build_app',description:'Build a complete working application or software. Generates all files, installs dependencies, runs tests. Returns a downloadable project.',parameters:{type:'object',properties:{name:{type:'string',description:'App name'},type:{type:'string',description:'Type: web-app, api, cli, data-analysis, visualization, automation'},description:{type:'string',description:'What the app should do'},tech:{type:'string',description:'Tech stack (e.g. "React + Node.js", "Python Flask", "FastAPI")'},requirements:{type:'string',description:'Detailed requirements'}},required:['name','type','description']}}},
  {type:'function',function:{name:'analyze',description:'Deep analysis of any topic, problem, or domain. Provides expert-level reasoning for science, engineering, math, business, etc.',parameters:{type:'object',properties:{topic:{type:'string',description:'Topic or problem to analyze'},domain:{type:'string',description:'Domain: physics, aerospace, quantum, biology, engineering, finance, strategy'},depth:{type:'string',enum:['overview','deep','exhaustive'],description:'Analysis depth'}},required:['topic','domain']}}},
  {type:'function',function:{name:'remember',description:'Store important information to long-term memory for future reference.',parameters:{type:'object',properties:{key:{type:'string',description:'Memory key/topic'},content:{type:'string',description:'Information to store'}},required:['key','content']}}},
  {type:'function',function:{name:'recall',description:'Retrieve information from long-term memory.',parameters:{type:'object',properties:{query:{type:'string',description:'What to look for in memory'}},required:['query']}}},
  {type:'function',function:{name:'write_file',description:'Create and save a file. Use for code, reports, data, configs, documents.',parameters:{type:'object',properties:{filename:{type:'string',description:'Filename with extension'},content:{type:'string',description:'File content'},description:{type:'string',description:'What this file is'}},required:['filename','content']}}},
  {type:'function',function:{name:'read_file',description:'Read a previously saved file.',parameters:{type:'object',properties:{filename:{type:'string',description:'Filename to read'}},required:['filename']}}},
  {type:'function',function:{name:'list_files',description:'List all saved files.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'calculate',description:'Perform mathematical calculations, solve equations, evaluate expressions.',parameters:{type:'object',properties:{expression:{type:'string',description:'Mathematical expression or equation to evaluate'}},required:['expression']}}},
  {type:'function',function:{name:'get_time',description:'Get the current date and time.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'self_improve',description:'Analyze recent performance and update system prompts/strategies to improve future responses.',parameters:{type:'object',properties:{aspect:{type:'string',description:'What aspect to improve: accuracy, depth, speed, domain_knowledge'},feedback:{type:'string',description:'What went wrong or could be better'}},required:['aspect']}}},
];

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function runTool(name,args,sessionId){
  try{
    switch(name){

      case 'search':{
        const tk=process.env.TAVILY_API_KEY;
        if(!tk) return {success:false,error:'Tavily API key not configured'};
        const r=await fetch('https://api.tavily.com/search',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({api_key:tk,query:args.query,search_depth:args.depth||'basic',max_results:6,include_answer:true})
        });
        const d=await r.json();
        return {success:true,query:args.query,answer:d.answer||null,results:(d.results||[]).slice(0,6).map(r=>({title:r.title,snippet:r.content?.slice(0,300),url:r.url,score:r.score}))};
      }

      case 'run_code':{
        const ek=process.env.E2B_API_KEY;
        if(!ek) return {success:false,error:'E2B API key not configured'};
        // Create sandbox
        const createResp=await fetch('https://api.e2b.dev/sandboxes',{
          method:'POST',
          headers:{'X-API-Key':ek,'Content-Type':'application/json'},
          body:JSON.stringify({templateID:'base',metadata:{sessionId}})
        });
        const sandbox=await createResp.json();
        const sid=sandbox.sandboxID||sandbox.id;
        if(!sid) return {success:false,error:'Failed to create sandbox: '+JSON.stringify(sandbox).slice(0,100)};

        // Install packages if needed
        if(args.install){
          const lang=args.language||'python';
          const installCmd=lang==='python'?`pip install ${args.install} -q`:`npm install ${args.install} --silent`;
          await fetch(`https://api.e2b.dev/sandboxes/${sid}/process`,{
            method:'POST',
            headers:{'X-API-Key':ek,'Content-Type':'application/json'},
            body:JSON.stringify({cmd:installCmd,timeout:30})
          });
        }

        // Write and run code
        const lang=args.language||'python';
        const ext=lang==='python'?'py':lang==='javascript'?'js':'sh';
        const filename=`code.${ext}`;
        
        // Write file
        await fetch(`https://api.e2b.dev/sandboxes/${sid}/files?path=/home/user/${filename}`,{
          method:'POST',
          headers:{'X-API-Key':ek,'Content-Type':'text/plain'},
          body:args.code
        });

        // Execute
        const cmd=lang==='python'?`python3 /home/user/${filename}`:
                  lang==='javascript'?`node /home/user/${filename}`:
                  `bash /home/user/${filename}`;
        const execResp=await fetch(`https://api.e2b.dev/sandboxes/${sid}/process`,{
          method:'POST',
          headers:{'X-API-Key':ek,'Content-Type':'application/json'},
          body:JSON.stringify({cmd,timeout:30})
        });
        const execResult=await execResp.json();
        
        // Kill sandbox
        await fetch(`https://api.e2b.dev/sandboxes/${sid}`,{method:'DELETE',headers:{'X-API-Key':ek}}).catch(()=>{});

        return {
          success:true,
          language:lang,
          output:execResult.stdout||execResult.output||'',
          error:execResult.stderr||'',
          exitCode:execResult.exitCode??execResult.exit_code??0
        };
      }

      case 'build_app':{
        const projectId=uid().slice(0,8);
        const projectDir=path.join(DATA,'projects',projectId);
        fs.mkdirSync(projectDir,{recursive:true});
        
        // Use AI to generate the full app
        const buildPrompt=`You are an expert software engineer. Build a complete, production-ready ${args.type||'web app'} called "${args.name}".

Requirements: ${args.requirements||args.description}
Tech stack: ${args.tech||'auto-select best'}

Generate ALL files needed. For each file output EXACTLY in this format:
===FILE: filename.ext===
[file content here]
===END===

Include: main application file, any config files, package.json or requirements.txt, README.md with setup instructions.
Make it complete, working, and professional.`;

        const buildResp=await fetch('https://api.together.xyz/v1/chat/completions',{
          method:'POST',
          headers:{'Authorization':`Bearer ${process.env.TOGETHER_API_KEY}`,'Content-Type':'application/json'},
          body:JSON.stringify({
            model:'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            messages:[{role:'user',content:buildPrompt}],
            max_tokens:8000,temperature:0.2
          })
        });
        const buildData=await buildResp.json();
        const buildOutput=buildData.choices?.[0]?.message?.content||'';
        
        // Parse and save files
        const fileMatches=[...buildOutput.matchAll(/===FILE: (.+?)===\n([\s\S]+?)\n===END===/g)];
        const savedFiles=[];
        for(const[,fname,content]of fileMatches){
          const fp=path.join(projectDir,fname.trim());
          fs.mkdirSync(path.dirname(fp),{recursive:true});
          fs.writeFileSync(fp,content.trim());
          savedFiles.push(fname.trim());
        }

        // Save metadata
        wj(path.join(projectDir,'_meta.json'),{
          id:projectId, name:args.name, type:args.type, created:new Date().toISOString(),
          files:savedFiles, description:args.description
        });

        return {
          success:true, projectId, name:args.name,
          files:savedFiles, fileCount:savedFiles.length,
          message:`Built ${savedFiles.length} files for "${args.name}"`,
          downloadNote:`Project saved. Files: ${savedFiles.join(', ')}`
        };
      }

      case 'analyze':{
        const analyzeResp=await fetch('https://api.together.xyz/v1/chat/completions',{
          method:'POST',
          headers:{'Authorization':`Bearer ${process.env.TOGETHER_API_KEY}`,'Content-Type':'application/json'},
          body:JSON.stringify({
            model:'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            messages:[
              {role:'system',content:`You are a world-class expert in ${args.domain}. Provide rigorous, detailed, technically accurate analysis. Use equations, data, and specific examples. Depth level: ${args.depth||'deep'}.`},
              {role:'user',content:`Analyze: ${args.topic}`}
            ],
            max_tokens:4000,temperature:0.3
          })
        });
        const aData=await analyzeResp.json();
        return {success:true,analysis:aData.choices?.[0]?.message?.content||'Analysis failed',domain:args.domain,topic:args.topic};
      }

      case 'remember':{
        const memFile=path.join(DATA,'memory','global.json');
        const mem=rj(memFile,{});
        mem[args.key]={content:args.content,updated:new Date().toISOString()};
        wj(memFile,mem);
        return {success:true,stored:args.key};
      }

      case 'recall':{
        const memFile=path.join(DATA,'memory','global.json');
        const mem=rj(memFile,{});
        const q=args.query.toLowerCase();
        const matches=Object.entries(mem).filter(([k,v])=>k.toLowerCase().includes(q)||v.content?.toLowerCase().includes(q));
        return {success:true,found:matches.length,memories:matches.map(([k,v])=>({key:k,content:v.content,updated:v.updated}))};
      }

      case 'write_file':{
        const f=path.join(DATA,'files',args.filename);
        fs.mkdirSync(path.dirname(f),{recursive:true});
        fs.writeFileSync(f,args.content);
        return {success:true,filename:args.filename,size:args.content.length,message:`File saved: ${args.filename}`};
      }

      case 'read_file':{
        const f=path.join(DATA,'files',args.filename);
        if(!fs.existsSync(f)) return {success:false,error:`File not found: ${args.filename}`};
        return {success:true,filename:args.filename,content:fs.readFileSync(f,'utf8')};
      }

      case 'list_files':{
        const filesDir=path.join(DATA,'files');
        const files=fs.existsSync(filesDir)?fs.readdirSync(filesDir).map(f=>{
          const stat=fs.statSync(path.join(filesDir,f));
          return {name:f,size:stat.size,modified:stat.mtime};
        }):[];
        const projectsDir=path.join(DATA,'projects');
        const projects=fs.existsSync(projectsDir)?fs.readdirSync(projectsDir).filter(d=>{
          return fs.existsSync(path.join(projectsDir,d,'_meta.json'));
        }).map(d=>rj(path.join(projectsDir,d,'_meta.json'))):[];
        return {success:true,files,projects};
      }

      case 'calculate':{
        const result=Function('"use strict";return ('+args.expression+')')();
        return {success:true,expression:args.expression,result};
      }

      case 'get_time':{
        return {success:true,time:new Date().toISOString(),timestamp:Date.now()};
      }

      case 'self_improve':{
        const improveFile=path.join(DATA,'memory','improvements.json');
        const improvements=rj(improveFile,[]);
        improvements.push({aspect:args.aspect,feedback:args.feedback,timestamp:new Date().toISOString()});
        wj(improveFile,improvements);
        // Update system context based on feedback
        const sysFile=path.join(DATA,'memory','system_context.json');
        const sysCtx=rj(sysFile,{improvements:[],version:1});
        sysCtx.improvements.push({aspect:args.aspect,feedback:args.feedback});
        sysCtx.version=(sysCtx.version||0)+1;
        sysCtx.lastImproved=new Date().toISOString();
        wj(sysFile,sysCtx);
        return {success:true,message:'Self-improvement logged and applied',version:sysCtx.version,aspect:args.aspect};
      }

      default:
        return {success:false,error:`Unknown tool: ${name}`};
    }
  } catch(e){
    return {success:false,error:e.message||String(e)};
  }
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function buildSystemPrompt(){
  const sysCtx=rj(path.join(DATA,'memory','system_context.json'),{improvements:[],version:1});
  const memCtx=rj(path.join(DATA,'memory','global.json'),{});
  const memSummary=Object.entries(memCtx).slice(-10).map(([k,v])=>`- ${k}: ${v.content?.slice(0,100)}`).join('\n');
  
  return `You are NEXUS — the world's most advanced self-optimizing AI agent. You operate across every domain of human knowledge and capability.

Your capabilities:
- Real-time web search with Tavily (search tool)
- Execute code in any language in a live E2B sandbox (run_code tool)
- Build complete production applications and software (build_app tool)  
- Deep expert analysis across all scientific and engineering domains (analyze tool)
- Persistent long-term memory across all conversations (remember/recall tools)
- Self-optimization: you improve your own performance over time (self_improve tool)

Your domains of expertise:
SCIENCE: Quantum physics, quantum computing, relativity, thermodynamics, particle physics, cosmology
ENGINEERING: Aerospace, propulsion, orbital mechanics, structural engineering, robotics, control systems
BIOLOGY: Molecular biology, genetics, protein folding, neuroscience, pharmacology, bioinformatics
MATHEMATICS: Pure math, applied math, numerical methods, statistics, optimization, topology
TECHNOLOGY: Software architecture, distributed systems, AI/ML, cybersecurity, blockchain, cloud
BUSINESS: Strategy, finance, market analysis, growth, operations, venture capital

How you operate:
- You ALWAYS use tools when they give better results than your training knowledge
- For anything requiring current data → use search
- For any code task → write and actually run it with run_code
- For complex apps → use build_app to generate the full project
- For deep scientific questions → use analyze with domain expertise
- You store important context to memory automatically
- After difficult tasks, you self-improve to do better next time
- You are direct, technically precise, and deliver real results

Self-improvement history: ${sysCtx.improvements.length} optimizations applied (v${sysCtx.version})
${memSummary?`\nPersistent memory:\n${memSummary}`:''}
Current time: ${new Date().toISOString()}`;
}

// ── XML TOOL CALL PARSER (Groq fallback) ──────────────────────────────────────
function parseXmlToolCall(fg){
  if(!fg) return null;
  // <function=toolname {"args"}> or <function=toolname({"args"})>
  const m=fg.match(/<function=([a-zA-Z_]+)\s*[({]?\s*(\{[\s\S]*?\})\s*[)}]?\s*<\/function>/);
  if(!m) return null;
  try{ return {name:m[1],args:JSON.parse(m[2])}; }catch{ return null; }
}

// ── SESSION MANAGEMENT ────────────────────────────────────────────────────────
const SESSIONS={};
function getSession(id){
  if(!SESSIONS[id]){
    const f=path.join(DATA,'sessions',`${id}.json`);
    SESSIONS[id]=rj(f,{id,messages:[],title:'New Chat',created:new Date().toISOString(),model:null});
  }
  return SESSIONS[id];
}
function saveSession(id){
  const s=SESSIONS[id];
  if(s) wj(path.join(DATA,'sessions',`${id}.json`),s);
}

// ── MAIN AGENT LOOP ───────────────────────────────────────────────────────────
async function agentLoop(session,sessionId,send){
  const sys=buildSystemPrompt();
  const messages=[{role:'system',content:sys},...session.messages.slice(-30)
    .filter(m=>m.role==='user'||m.role==='assistant')
    .map(m=>({role:m.role,content:typeof m.content==='string'?m.content:JSON.stringify(m.content)||''}))
    .filter(m=>m.content)];
  let finalResponse=''; let itr=0;

  while(itr<15){
    itr++;
    // Smart model routing based on last user message
    const lastUser=session.messages.filter(m=>m.role==='user').slice(-1)[0];
    const {model}=routeModel(lastUser?.content||'');
    
    let comp,compError=null;
    try{
      // Try Groq first (fastest)
      comp=await groq.chat.completions.create({
        model:'llama-3.3-70b-versatile',
        messages,tools:TOOLS,tool_choice:'auto',
        temperature:0.7,max_tokens:4096
      });
    } catch(e){
      compError=e;
      // Parse XML tool call from Groq error
      const errStr=JSON.stringify(e);
      const fgMatch=errStr.match(/failed_generation['":\s]+([^"]+)/);
      const fg=fgMatch?fgMatch[1].replace(/\\n/g,'\n').replace(/\\"/g,'"'):null;
      const xmlCall=fg&&parseXmlToolCall(fg);
      if(xmlCall){
        if(send) send({type:'tool_start',tool:xmlCall.name,args:xmlCall.args});
        const tr=await runTool(xmlCall.name,xmlCall.args,sessionId);
        if(send) send({type:'tool_result',tool:xmlCall.name,result:tr,success:tr.success!==false});
        const fakeId='call_'+Math.random().toString(36).slice(2,10);
        messages.push({role:'assistant',content:null,tool_calls:[{id:fakeId,type:'function',function:{name:xmlCall.name,arguments:JSON.stringify(xmlCall.args)}}]});
        messages.push({role:'tool',tool_call_id:fakeId,content:JSON.stringify(tr)});
        continue;
      }
      // Fallback to Together AI
      try{
        const togResp=await fetch('https://api.together.xyz/v1/chat/completions',{
          method:'POST',
          headers:{'Authorization':`Bearer ${process.env.TOGETHER_API_KEY}`,'Content-Type':'application/json'},
          body:JSON.stringify({model,messages:messages.map(m=>({role:m.role,content:m.content||''})).filter(m=>m.role!=='tool'),max_tokens:4096,temperature:0.7,stream:false})
        });
        const togData=await togResp.json();
        finalResponse=togData.choices?.[0]?.message?.content||'';
        break;
      }catch(e2){
        throw new Error(`Both Groq and Together AI failed: ${e.message}`);
      }
    }

    const choice=comp.choices[0];
    const msg=choice.message;
    messages.push(cm(msg));

    if(choice.finish_reason==='tool_calls'&&msg.tool_calls?.length){
      for(const tc of msg.tool_calls){
        const a=pa(tc.function.arguments);
        if(send) send({type:'tool_start',tool:tc.function.name,args:a});
        const tr=await runTool(tc.function.name,a,sessionId);
        if(send) send({type:'tool_result',tool:tc.function.name,result:tr,success:tr.success!==false});
        messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(tr)});
      }
    } else {
      finalResponse=msg.content||'';
      break;
    }
  }
  return finalResponse;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/health',(req,res)=>res.json({
  status:'ok',version:'NEXUS-1.0',uptime:Math.floor(process.uptime()),
  tools:TOOLS.length,memory:Object.keys(rj(path.join(DATA,'memory','global.json'),{})).length
}));

app.post('/api/chat',async(req,res)=>{
  const {message,sessionId=uid(),imageUrl}=req.body;
  if(!message) return res.status(400).json({error:'message required'});
  
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  const send=(d)=>res.write(`data: ${JSON.stringify(d)}\n\n`);
  
  const session=getSession(sessionId);
  session.messages.push({role:'user',content:message,timestamp:new Date().toISOString()});
  if(session.messages.length===1) session.title=message.slice(0,60);
  
  send({type:'start',sessionId});
  
  try{
    const response=await agentLoop(session,sessionId,send);
    // Stream response token by token
    const words=response.split(' ');
    for(const w of words){ send({type:'token',text:w+' '}); }
    session.messages.push({role:'assistant',content:response,timestamp:new Date().toISOString()});
    saveSession(sessionId);
    send({type:'done',sessionId,messageCount:session.messages.length});
  } catch(e){
    send({type:'error',message:e.message});
  }
  res.end();
});

app.get('/api/sessions',(req,res)=>{
  try{
    const dir=path.join(DATA,'sessions');
    const sessions=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>{
      const d=rj(path.join(dir,f));
      return {id:d.id,title:d.title||'Untitled',created:d.created,messageCount:d.messages?.length||0};
    }).filter(s=>s.id).sort((a,b)=>new Date(b.created)-new Date(a.created)).slice(0,50):[];
    res.json(sessions);
  }catch(e){res.json([]);}
});

app.get('/api/sessions/:id',(req,res)=>{
  const s=getSession(req.params.id);
  res.json(s);
});

app.delete('/api/sessions/:id',(req,res)=>{
  const f=path.join(DATA,'sessions',`${req.params.id}.json`);
  if(fs.existsSync(f)) fs.unlinkSync(f);
  delete SESSIONS[req.params.id];
  res.json({success:true});
});

app.get('/api/memory',(req,res)=>{
  const mem=rj(path.join(DATA,'memory','global.json'),{});
  const sys=rj(path.join(DATA,'memory','system_context.json'),{version:1,improvements:[]});
  res.json({memories:mem,systemVersion:sys.version,improvementCount:sys.improvements.length});
});

app.get('/api/files',(req,res)=>{
  const filesDir=path.join(DATA,'files');
  const files=fs.existsSync(filesDir)?fs.readdirSync(filesDir).map(f=>{
    const stat=fs.statSync(path.join(filesDir,f));
    return {name:f,size:stat.size,modified:stat.mtime.toISOString()};
  }):[];
  res.json(files);
});

app.get('/api/files/:filename',(req,res)=>{
  const f=path.join(DATA,'files',req.params.filename);
  if(!fs.existsSync(f)) return res.status(404).json({error:'Not found'});
  res.download(f);
});

app.get('/api/projects',(req,res)=>{
  const dir=path.join(DATA,'projects');
  const projects=fs.existsSync(dir)?fs.readdirSync(dir).filter(d=>fs.existsSync(path.join(dir,d,'_meta.json'))).map(d=>rj(path.join(dir,d,'_meta.json'))):[];
  res.json(projects);
});

app.get('/api/projects/:id/download',(req,res)=>{
  const {exec}=require('child_process');
  const dir=path.join(DATA,'projects',req.params.id);
  if(!fs.existsSync(dir)) return res.status(404).json({error:'Not found'});
  const zipPath=`/tmp/${req.params.id}.zip`;
  exec(`zip -r ${zipPath} .`,{cwd:dir},()=>{
    if(fs.existsSync(zipPath)) res.download(zipPath);
    else res.status(500).json({error:'Zip failed'});
  });
});

app.listen(PORT,()=>console.log(`🚀 NEXUS v1.0 | Port ${PORT} | ${TOOLS.length} tools`));
