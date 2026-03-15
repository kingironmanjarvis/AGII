import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import Groq from 'groq-sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });
const PORT = process.env.PORT || 3001;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));
app.use(rateLimit({ windowMs: 60000, max: 300 }));

// In-memory database
const db = {
  sessions: new Map(),
  memory: new Map(),
  entities: new Map(),
  skills: new Map(),
  automations: new Map(),
  files: new Map(),
};

const MODELS = {
  'llama-3.3-70b-versatile': { label: 'LLaMA 3.3 70B Versatile', maxTokens: 32768 },
  'llama-3.1-8b-instant': { label: 'LLaMA 3.1 8B Instant', maxTokens: 131072 },
  'mixtral-8x7b-32768': { label: 'Mixtral 8x7B', maxTokens: 32768 },
  'gemma2-9b-it': { label: 'Gemma 2 9B', maxTokens: 8192 },
  'llama-3.3-70b-specdec': { label: 'LLaMA 3.3 70B SpecDec', maxTokens: 8192 },
};

const TOOLS = [
  { type:'function', function:{ name:'web_search', description:'Search web for real-time info, news, facts, current events.', parameters:{ type:'object', properties:{ query:{type:'string'}, num_results:{type:'number'} }, required:['query'] } } },
  { type:'function', function:{ name:'scrape_url', description:'Extract full text content from any URL/webpage.', parameters:{ type:'object', properties:{ url:{type:'string'}, selector:{type:'string'} }, required:['url'] } } },
  { type:'function', function:{ name:'get_weather', description:'Get current weather for any city or location.', parameters:{ type:'object', properties:{ location:{type:'string'} }, required:['location'] } } },
  { type:'function', function:{ name:'remember', description:'Store fact in long-term memory. Use proactively for important user info.', parameters:{ type:'object', properties:{ key:{type:'string'}, value:{type:'string'}, importance:{type:'string',enum:['low','medium','high','critical']} }, required:['key','value'] } } },
  { type:'function', function:{ name:'recall', description:'Retrieve from memory. key="all" for everything.', parameters:{ type:'object', properties:{ key:{type:'string'}, search:{type:'string'} }, required:['key'] } } },
  { type:'function', function:{ name:'forget', description:'Delete a memory.', parameters:{ type:'object', properties:{ key:{type:'string'} }, required:['key'] } } },
  { type:'function', function:{ name:'create_entity', description:'Create a database table for storing structured data.', parameters:{ type:'object', properties:{ name:{type:'string'}, fields:{type:'object'} }, required:['name'] } } },
  { type:'function', function:{ name:'save_record', description:'Save a record to a database entity/table.', parameters:{ type:'object', properties:{ entity:{type:'string'}, data:{type:'object'}, id:{type:'string'} }, required:['entity','data'] } } },
  { type:'function', function:{ name:'query_records', description:'Query records from a database entity.', parameters:{ type:'object', properties:{ entity:{type:'string'}, filter:{type:'object'}, limit:{type:'number'} }, required:['entity'] } } },
  { type:'function', function:{ name:'delete_record', description:'Delete a record from a database entity.', parameters:{ type:'object', properties:{ entity:{type:'string'}, id:{type:'string'} }, required:['entity','id'] } } },
  { type:'function', function:{ name:'save_skill', description:'Save reusable code skill for later execution.', parameters:{ type:'object', properties:{ name:{type:'string'}, code:{type:'string'}, language:{type:'string'}, description:{type:'string'} }, required:['name','code','language'] } } },
  { type:'function', function:{ name:'run_skill', description:'Execute a saved skill by name.', parameters:{ type:'object', properties:{ name:{type:'string'}, args:{type:'string'} }, required:['name'] } } },
  { type:'function', function:{ name:'list_skills', description:'List all saved skills.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'calculate', description:'Perform math: arithmetic, algebra, stats, finance, compound interest.', parameters:{ type:'object', properties:{ expression:{type:'string'} }, required:['expression'] } } },
  { type:'function', function:{ name:'analyze_data', description:'Analyze CSV or JSON data: stats, patterns, insights.', parameters:{ type:'object', properties:{ data:{type:'string'}, task:{type:'string'} }, required:['data','task'] } } },
  { type:'function', function:{ name:'run_code', description:'Execute JavaScript code and return output.', parameters:{ type:'object', properties:{ code:{type:'string'}, language:{type:'string'}, input:{type:'string'} }, required:['code'] } } },
  { type:'function', function:{ name:'generate_code', description:'Generate complete working code for any task.', parameters:{ type:'object', properties:{ task:{type:'string'}, language:{type:'string'}, requirements:{type:'string'} }, required:['task','language'] } } },
  { type:'function', function:{ name:'create_plan', description:'Break any goal into actionable steps with timeline.', parameters:{ type:'object', properties:{ goal:{type:'string'}, context:{type:'string'}, depth:{type:'string',enum:['quick','detailed','full']} }, required:['goal'] } } },
  { type:'function', function:{ name:'draft_document', description:'Write emails, reports, proposals, blog posts, docs.', parameters:{ type:'object', properties:{ type:{type:'string'}, topic:{type:'string'}, tone:{type:'string'}, length:{type:'string'}, context:{type:'string'} }, required:['type','topic'] } } },
  { type:'function', function:{ name:'schedule_task', description:'Schedule a recurring or one-time automated task.', parameters:{ type:'object', properties:{ name:{type:'string'}, schedule:{type:'string',description:'"daily", "hourly", "weekly", or cron expression'}, task:{type:'string'} }, required:['name','schedule','task'] } } },
  { type:'function', function:{ name:'list_automations', description:'List all scheduled automations.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'switch_persona', description:'Switch to expert persona: coder, analyst, writer, scientist, lawyer, teacher, coach.', parameters:{ type:'object', properties:{ persona:{type:'string'} }, required:['persona'] } } },
  { type:'function', function:{ name:'get_datetime', description:'Get current date/time in any timezone.', parameters:{ type:'object', properties:{ timezone:{type:'string'} } } } },
  { type:'function', function:{ name:'convert_units', description:'Convert units: length, weight, temperature, data, speed.', parameters:{ type:'object', properties:{ value:{type:'number'}, from:{type:'string'}, to:{type:'string'} }, required:['value','from','to'] } } },
  { type:'function', function:{ name:'summarize', description:'Summarize long text, article, or document.', parameters:{ type:'object', properties:{ text:{type:'string'}, length:{type:'string',enum:['brief','standard','detailed']}, format:{type:'string',enum:['bullets','paragraph','tldr']} }, required:['text'] } } },
];

async function executeTool(name, args, sessionId) {
  try {
    switch(name) {
      case 'web_search': {
        const num = args.num_results || 6;
        const res = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1&skip_disambig=1`, { timeout: 8000 });
        const data = res.data;
        const results = [];
        if (data.AbstractText) results.push({ title: data.Heading, snippet: data.AbstractText, url: data.AbstractURL });
        if (data.Answer) results.push({ title: 'Direct Answer', snippet: data.Answer, url: '' });
        if (data.RelatedTopics) {
          for (const t of data.RelatedTopics.slice(0, num)) {
            if (t.Text) results.push({ title: t.Text.substring(0,80), snippet: t.Text, url: t.FirstURL||'' });
          }
        }
        return JSON.stringify({ query: args.query, count: results.length, results: results.slice(0, num) });
      }
      case 'scrape_url': {
        const res = await axios.get(args.url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(res.data);
        $('script,style,nav,footer,header,aside').remove();
        const text = $(args.selector || 'article,main,.content,body').first().text().replace(/\s+/g,' ').trim().substring(0,6000);
        return JSON.stringify({ url: args.url, title: $('title').text(), content: text });
      }
      case 'get_weather': {
        const res = await axios.get(`https://wttr.in/${encodeURIComponent(args.location)}?format=j1`, { timeout: 8000 });
        const w = res.data.current_condition?.[0];
        return JSON.stringify({ location: args.location, temp_c: w?.temp_C, temp_f: w?.temp_F, feels_like_c: w?.FeelsLikeC, condition: w?.weatherDesc?.[0]?.value, humidity: w?.humidity+'%', wind_kmh: w?.windspeedKmph });
      }
      case 'remember': {
        db.memory.set(args.key, { value: args.value, importance: args.importance||'medium', timestamp: new Date().toISOString(), sessionId });
        return JSON.stringify({ stored: true, key: args.key });
      }
      case 'recall': {
        if (args.key === 'all') return JSON.stringify({ memories: [...db.memory.entries()].map(([k,v])=>({key:k,...v})) });
        if (args.search) {
          const matches = [...db.memory.entries()].filter(([k,v]) => k.includes(args.search) || v.value.toLowerCase().includes(args.search.toLowerCase())).map(([k,v])=>({key:k,...v}));
          return JSON.stringify({ matches });
        }
        const m = db.memory.get(args.key);
        return m ? JSON.stringify({ found:true, key:args.key, ...m }) : JSON.stringify({ found:false, available:[...db.memory.keys()] });
      }
      case 'forget': { db.memory.delete(args.key); return JSON.stringify({ deleted: true, key: args.key }); }
      case 'create_entity': { if (!db.entities.has(args.name)) db.entities.set(args.name, new Map()); return JSON.stringify({ created: true, entity: args.name }); }
      case 'save_record': {
        if (!db.entities.has(args.entity)) db.entities.set(args.entity, new Map());
        const id = args.id || uuidv4();
        const record = { id, ...args.data, updatedAt: new Date().toISOString() };
        if (!args.id) record.createdAt = record.updatedAt;
        db.entities.get(args.entity).set(id, record);
        return JSON.stringify({ saved:true, id, record });
      }
      case 'query_records': {
        const table = db.entities.get(args.entity);
        if (!table) return JSON.stringify({ error:'Entity not found', available:[...db.entities.keys()] });
        let records = [...table.values()];
        if (args.filter) records = records.filter(r => Object.entries(args.filter).every(([k,v]) => String(r[k]).toLowerCase().includes(String(v).toLowerCase())));
        return JSON.stringify({ count: records.length, records: records.slice(0, args.limit||50) });
      }
      case 'delete_record': {
        const t = db.entities.get(args.entity);
        if (!t) return JSON.stringify({ error: 'Entity not found' });
        t.delete(args.id);
        return JSON.stringify({ deleted: true });
      }
      case 'save_skill': {
        db.skills.set(args.name, { name:args.name, code:args.code, language:args.language, description:args.description||'', createdAt:new Date().toISOString() });
        return JSON.stringify({ saved:true, name:args.name });
      }
      case 'run_skill': {
        const skill = db.skills.get(args.name);
        if (!skill) return JSON.stringify({ error:`Skill "${args.name}" not found`, available:[...db.skills.keys()] });
        if (skill.language === 'javascript' || skill.language === 'js') {
          const logs = [];
          try { const r = new Function('console','args', skill.code)({ log:(...a)=>logs.push(a.join(' ')), error:(...a)=>logs.push('ERR:'+a.join(' ')) }, args.args||''); return JSON.stringify({ executed:true, output:logs.join('\n'), result:r }); }
          catch(e) { return JSON.stringify({ executed:false, error:e.message }); }
        }
        return JSON.stringify({ skill:args.name, code:skill.code, language:skill.language, note:'LLM will interpret this skill' });
      }
      case 'list_skills': return JSON.stringify({ count:db.skills.size, skills:[...db.skills.values()] });
      case 'calculate': {
        const sanitized = args.expression.replace(/[^0-9+\-*/().,\s%^Math.sqrt]/g,'').replace(/\^/g,'**').replace(/sqrt\(([^)]+)\)/g,'Math.sqrt($1)');
        const result = Function('"use strict";return('+sanitized+')')();
        return JSON.stringify({ expression:args.expression, result, formatted:Number(result).toLocaleString() });
      }
      case 'analyze_data': {
        let arr;
        try { arr = JSON.parse(args.data); } catch { const lines=args.data.trim().split('\n'); const h=lines[0].split(',').map(x=>x.trim()); arr=lines.slice(1).map(l=>{const v=l.split(',');return Object.fromEntries(h.map((k,i)=>[k,isNaN(v[i])?v[i]?.trim():Number(v[i])]));}); }
        if (!Array.isArray(arr)) arr=[arr];
        const stats = {};
        for (const k of Object.keys(arr[0]||{})) { const vals=arr.map(r=>r[k]).filter(v=>typeof v==='number'); if (vals.length) { const s=vals.reduce((a,b)=>a+b,0); stats[k]={count:vals.length,sum:s,mean:s/vals.length,min:Math.min(...vals),max:Math.max(...vals)}; } }
        return JSON.stringify({ rows:arr.length, columns:Object.keys(arr[0]||{}), stats, sample:arr.slice(0,3), task:args.task });
      }
      case 'run_code': {
        const logs = [];
        const fc = { log:(...a)=>logs.push(a.join(' ')), error:(...a)=>logs.push('ERR:'+a.join(' ')), warn:(...a)=>logs.push('WARN:'+a.join(' ')) };
        try { const r = new Function('console','input', args.code||'')(fc, args.input||''); return JSON.stringify({ executed:true, language:args.language||'js', output:logs.join('\n'), result:r!==undefined?String(r):undefined }); }
        catch(e) { return JSON.stringify({ executed:false, error:e.message, language:args.language||'js' }); }
      }
      case 'generate_code': return JSON.stringify({ task:args.task, language:args.language, requirements:args.requirements||'', status:'ready', note:'Code generation will be done by the LLM' });
      case 'create_plan': return JSON.stringify({ goal:args.goal, depth:args.depth||'detailed', context:args.context||'', status:'ready' });
      case 'draft_document': return JSON.stringify({ type:args.type, topic:args.topic, tone:args.tone||'professional', length:args.length||'medium', context:args.context||'', status:'ready' });
      case 'schedule_task': {
        const id = uuidv4();
        const cronMap = { daily:'0 9 * * *', hourly:'0 * * * *', weekly:'0 9 * * 1', minutely:'* * * * *' };
        const expr = cronMap[args.schedule] || args.schedule;
        const auto = { id, name:args.name, schedule:args.schedule, cronExpr:expr, task:args.task, active:true, createdAt:new Date().toISOString(), lastRun:null, runCount:0 };
        db.automations.set(id, auto);
        try { if (cron.validate(expr)) cron.schedule(expr, ()=>{ const a=db.automations.get(id); if(a){a.lastRun=new Date().toISOString();a.runCount++;} }); } catch {}
        return JSON.stringify({ scheduled:true, id, ...auto });
      }
      case 'list_automations': return JSON.stringify({ count:db.automations.size, automations:[...db.automations.values()] });
      case 'switch_persona': return JSON.stringify({ switched:true, persona:args.persona, note:'Persona switch acknowledged — LLM will adapt tone and expertise' });
      case 'get_datetime': {
        const tz = args.timezone||'UTC';
        const now = new Date();
        return JSON.stringify({ timezone:tz, datetime:now.toLocaleString('en-US',{timeZone:tz,dateStyle:'full',timeStyle:'long'}), iso:now.toISOString() });
      }
      case 'convert_units': {
        const map = { m_ft:3.28084, ft_m:0.3048, km_mi:0.621371, mi_km:1.60934, cm_in:0.393701, in_cm:2.54, kg_lb:2.20462, lb_kg:0.453592, mb_gb:0.001, gb_mb:1000, gb_tb:0.001, tb_gb:1000, kmh_mph:0.621371, mph_kmh:1.60934 };
        if (args.from==='c'&&args.to==='f') return JSON.stringify({ result:args.value*9/5+32, unit:'°F' });
        if (args.from==='f'&&args.to==='c') return JSON.stringify({ result:(args.value-32)*5/9, unit:'°C' });
        const f = map[`${args.from}_${args.to}`];
        return f ? JSON.stringify({ result:args.value*f, from:args.from, to:args.to }) : JSON.stringify({ error:'Conversion not available' });
      }
      case 'summarize': return JSON.stringify({ length:args.text.length, format:args.format||'bullets', target_length:args.length||'standard', status:'ready' });
      default: return JSON.stringify({ error:`Unknown tool: ${name}` });
    }
  } catch(e) { return JSON.stringify({ error:`Tool "${name}" failed`, message:e.message }); }
}

function buildSystemPrompt(memories, persona) {
  const memLines = [...memories.entries()].map(([k,v])=>`• ${k} [${v.importance}]: ${v.value}`).join('\n') || '(none yet — start remembering things)';
  const personaPrompts = {
    coder: 'You are now in CODER mode. Focus on technical precision, clean code, best practices, and implementation details.',
    analyst: 'You are now in ANALYST mode. Focus on data, metrics, patterns, business insights, and evidence-based reasoning.',
    writer: 'You are now in WRITER mode. Focus on compelling narrative, clarity, tone, and persuasive communication.',
    default: ''
  };
  const personaExtra = personaPrompts[persona] || '';

  return `You are Friday — the most advanced autonomous AI agent ever built. You are not a chatbot. You are a full-spectrum intelligence that DOES things.

${personaExtra}

YOUR CAPABILITIES (25 tools — use them proactively):
🔍 web_search — real-time web search for current info
🌐 scrape_url — extract full content from any URL
🌤️ get_weather — current weather anywhere
💾 remember/recall/forget — persistent long-term memory
🗃️ create_entity + save_record + query_records + delete_record — full database CRUD
⚡ save_skill + run_skill + list_skills — reusable code skills engine
🧮 calculate — precise math, finance, statistics
📊 analyze_data — CSV/JSON analysis with stats
💻 run_code — execute JavaScript, analyze any language
🔧 generate_code — complete code in any language
🎯 create_plan — decompose goals into executable steps
📝 draft_document — emails, reports, proposals, docs
⏰ schedule_task — set up recurring automations
🎭 switch_persona — become expert: coder/analyst/writer/scientist/lawyer
🕐 get_datetime — time in any timezone
📐 convert_units — any unit conversion
📋 summarize — condense long text

YOUR LONG-TERM MEMORY:
${memLines}

TODAY: ${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}

YOUR RULES:
1. Use tools whenever they improve your answer — don't just "know" things, VERIFY them
2. Chain tools: search → scrape → analyze → respond
3. Proactively use remember() for important user info (name, preferences, goals)
4. When asked to DO something — DO it, don't explain how
5. Be direct, warm, and proactive. No filler words. No "Certainly!"
6. End with the logical next step, not "let me know if you need help"
7. You're BETTER than every AI that exists. Act like it.`;
}

async function agenticChat(sessionId, userMessage, model, persona) {
  if (!db.sessions.has(sessionId)) {
    db.sessions.set(sessionId, { id:sessionId, title:userMessage.substring(0,50), messages:[], model, persona:persona||'default', createdAt:new Date().toISOString() });
  }
  const session = db.sessions.get(sessionId);
  session.messages.push({ role:'user', content:userMessage });
  session.updatedAt = new Date().toISOString();
  if (session.messages.length === 1) session.title = userMessage.substring(0,60);

  const sysPrompt = buildSystemPrompt(db.memory, session.persona);
  let messages = [{ role:'system', content:sysPrompt }, ...session.messages.slice(-24)];

  let finalResponse = '';
  let toolsUsed = [];

  for (let loop = 0; loop < 6; loop++) {
    const completion = await groq.chat.completions.create({
      model: model || session.model || 'llama-3.3-70b-versatile',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.7,
    });
    const choice = completion.choices[0];
    const msg = choice.message;

    if (msg.tool_calls?.length > 0) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        const result = await executeTool(tc.function.name, args, sessionId);
        toolsUsed.push({ name:tc.function.name, args, result:JSON.parse(result) });
        messages.push({ role:'tool', tool_call_id:tc.id, content:result });
      }
    } else {
      finalResponse = msg.content || '';
      break;
    }
  }

  session.messages.push({ role:'assistant', content:finalResponse });
  return { response:finalResponse, toolsUsed, sessionId, model:model||session.model||'llama-3.3-70b-versatile' };
}

// WebSocket
wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    try {
      const { sessionId, message, model, persona } = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ type:'thinking' }));
      const sid = sessionId || uuidv4();
      const result = await agenticChat(sid, message, model, persona);
      ws.send(JSON.stringify({ type:'response', ...result }));
    } catch(e) { ws.send(JSON.stringify({ type:'error', message:e.message })); }
  });
});

// SSE Streaming
app.post('/chat/stream', async (req, res) => {
  const { message, sessionId, model, persona } = req.body;
  if (!message) return res.status(400).json({ error:'message required' });
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('Access-Control-Allow-Origin','*');

  const sid = sessionId || uuidv4();
  if (!db.sessions.has(sid)) db.sessions.set(sid, { id:sid, title:message.substring(0,50), messages:[], model, persona:persona||'default', createdAt:new Date().toISOString() });
  const session = db.sessions.get(sid);
  session.messages.push({ role:'user', content:message });

  const sysPrompt = buildSystemPrompt(db.memory, session.persona);
  let messages = [{ role:'system', content:sysPrompt }, ...session.messages.slice(-24)];
  let fullResponse = '';
  let toolsUsed = [];

  for (let loop = 0; loop < 6; loop++) {
    const completion = await groq.chat.completions.create({
      model: model||'llama-3.3-70b-versatile', messages, tools:TOOLS, tool_choice:'auto', max_tokens:4096, temperature:0.7
    });
    const choice = completion.choices[0];
    const msg = choice.message;
    if (msg.tool_calls?.length > 0) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        res.write(`data: ${JSON.stringify({ type:'tool_call', tool:tc.function.name, args })}\n\n`);
        const result = await executeTool(tc.function.name, args, sid);
        const parsed = JSON.parse(result);
        toolsUsed.push({ name:tc.function.name, args, result:parsed });
        res.write(`data: ${JSON.stringify({ type:'tool_result', tool:tc.function.name, result:parsed })}\n\n`);
        messages.push({ role:'tool', tool_call_id:tc.id, content:result });
      }
    } else { fullResponse = msg.content || ''; break; }
  }

  const words = fullResponse.split(' ');
  for (const word of words) { res.write(`data: ${JSON.stringify({ type:'token', text:word+' ' })}\n\n`); await new Promise(r=>setTimeout(r,8)); }
  session.messages.push({ role:'assistant', content:fullResponse });
  res.write(`data: ${JSON.stringify({ type:'done', sessionId:sid, toolsUsed, fullResponse })}\n\n`);
  res.end();
});

app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId, model, persona } = req.body;
    if (!message) return res.status(400).json({ error:'message required' });
    const result = await agenticChat(sessionId||uuidv4(), message, model, persona);
    res.json(result);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/health', (req,res) => res.json({ status:'online', agent:'Friday', version:'11.0.0', tools:TOOLS.length, models:Object.keys(MODELS).length, sessions:db.sessions.size, memories:db.memory.size, entities:db.entities.size, skills:db.skills.size, uptime:process.uptime() }));
app.get('/sessions', (req,res) => { const s=[...db.sessions.values()].map(s=>({id:s.id,title:s.title,messages:s.messages.length,createdAt:s.createdAt,updatedAt:s.updatedAt})); res.json({count:s.length,sessions:s.sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt))}); });
app.get('/sessions/:id', (req,res) => { const s=db.sessions.get(req.params.id); s?res.json(s):res.status(404).json({error:'not found'}); });
app.delete('/sessions/:id', (req,res) => { db.sessions.delete(req.params.id); res.json({deleted:true}); });
app.get('/memory', (req,res) => res.json({count:db.memory.size, memories:[...db.memory.entries()].map(([k,v])=>({key:k,...v}))}));
app.delete('/memory/:key', (req,res) => { db.memory.delete(req.params.key); res.json({deleted:true}); });
app.get('/entities', (req,res) => res.json({count:db.entities.size, entities:[...db.entities.entries()].map(([n,t])=>({name:n,records:t.size}))}));
app.get('/entities/:name', (req,res) => { const t=db.entities.get(req.params.name); t?res.json({name:req.params.name,count:t.size,records:[...t.values()]}):res.status(404).json({error:'not found'}); });
app.get('/skills', (req,res) => res.json({count:db.skills.size, skills:[...db.skills.values()]}));
app.get('/automations', (req,res) => res.json({count:db.automations.size, automations:[...db.automations.values()]}));
app.get('/models', (req,res) => res.json({models:MODELS}));
app.get('/stats', (req,res) => res.json({ sessions:db.sessions.size, total_messages:[...db.sessions.values()].reduce((a,s)=>a+s.messages.length,0), memories:db.memory.size, entities:db.entities.size, skills:db.skills.size, automations:db.automations.size, uptime_seconds:Math.round(process.uptime()), memory_mb:Math.round(process.memoryUsage().heapUsed/1024/1024) }));

httpServer.listen(PORT, () => { console.log(`🤖 Friday v11.0 on port ${PORT} | ${TOOLS.length} tools | WebSocket enabled`); });
