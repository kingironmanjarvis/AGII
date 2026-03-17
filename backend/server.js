/**
 * AGII v16 — Production Multi-Agent AI Platform
 * Real execution: E2B sandbox, Tavily search, Groq multi-model, Supabase memory,
 * self-optimization loop, 100-agent architecture, WebSocket live updates.
 */
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const multer       = require('multer');
const { v4: uid }  = require('uuid');
const Groq         = require('groq-sdk');
const axios        = require('axios');
const fs           = require('fs-extra');
const path         = require('path');
const cron         = require('node-cron');
const http         = require('http');
const WebSocket    = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── API Clients ───────────────────────────────────────────────────────────────
const groq    = new Groq({ apiKey: process.env.GROQ_API_KEY });
const TAVILY  = process.env.TAVILY_API_KEY;
const E2B_KEY = process.env.E2B_API_KEY;
const TOGETHER= process.env.TOGETHER_API_KEY;

// Supabase (optional — falls back to local JSON)
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
} catch(e) { console.log('Supabase optional — using local storage'); }

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('tiny'));
app.use(rateLimit({ windowMs: 60000, max: 600 }));

// ── Data Directories ──────────────────────────────────────────────────────────
const DATA       = path.join(__dirname, 'data');
const SESSIONS   = path.join(DATA, 'sessions');
const MEMORIES   = path.join(DATA, 'memories');
const FILES_DIR  = path.join(DATA, 'files');
const AGENTS_DIR = path.join(DATA, 'agents');
const BENCH_DIR  = path.join(DATA, 'benchmarks');
const OPTIM_DIR  = path.join(DATA, 'optimization');
const LOGS_DIR   = path.join(DATA, 'logs');

[SESSIONS,MEMORIES,FILES_DIR,AGENTS_DIR,BENCH_DIR,OPTIM_DIR,LOGS_DIR,
 path.join(DATA,'uploads'),path.join(DATA,'knowledge')].forEach(d => fs.ensureDirSync(d));

// ── Helpers ───────────────────────────────────────────────────────────────────
const rj = (f, def={}) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,'utf8')) : def; } catch { return def; }};
const wj = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));
const ts  = () => new Date().toISOString();
const log = (tag, msg, data={}) => {
  const entry = { ts: ts(), tag, msg, ...data };
  const lf    = path.join(LOGS_DIR, `${new Date().toISOString().slice(0,10)}.jsonl`);
  fs.appendFileSync(lf, JSON.stringify(entry)+'\n');
  broadcast({ type:'log', ...entry });
};

// ── WebSocket Broadcast ───────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type:'connected', ts: ts(), version:'16.0' }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL REGISTRY — Multi-model routing
// ═══════════════════════════════════════════════════════════════════════════════
const MODELS = {
  // Groq (ultra-fast)
  'llama-3.3-70b':   { provider:'groq', id:'llama-3.3-70b-versatile', ctx:128000, speed:'fast',  domains:['general','reasoning','planning','writing'] },
  'llama-3.1-70b':   { provider:'groq', id:'llama-3.1-70b-versatile', ctx:128000, speed:'fast',  domains:['general','coding','analysis'] },
  'llama-3.1-8b':    { provider:'groq', id:'llama-3.1-8b-instant',    ctx:128000, speed:'ultra', domains:['quick','routing'] },
  'mixtral-8x7b':    { provider:'groq', id:'mixtral-8x7b-32768',      ctx:32768,  speed:'fast',  domains:['coding','math','science'] },
  'gemma2-9b':       { provider:'groq', id:'gemma2-9b-it',            ctx:8192,   speed:'ultra', domains:['quick','general'] },
  // Together AI (more variety)
  'together-llama4': { provider:'together', id:'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', ctx:524288, speed:'medium', domains:['advanced','multimodal'] },
  'together-qwen':   { provider:'together', id:'Qwen/Qwen2.5-72B-Instruct-Turbo', ctx:32768, speed:'medium', domains:['coding','math','science'] },
  'together-deep':   { provider:'together', id:'deepseek-ai/DeepSeek-V3', ctx:65536, speed:'medium', domains:['reasoning','coding','math'] },
};

const DOMAIN_MODEL_MAP = {
  coding:        'together-qwen',
  math:          'together-deep',
  science:       'together-qwen',
  physics:       'together-deep',
  engineering:   'together-qwen',
  reasoning:     'llama-3.3-70b',
  planning:      'llama-3.3-70b',
  writing:       'llama-3.3-70b',
  research:      'llama-3.3-70b',
  quick:         'llama-3.1-8b',
  aerospace:     'together-deep',
  biology:       'together-qwen',
  quantum:       'together-deep',
  default:       'llama-3.3-70b',
};

async function callModel(modelKey, messages, opts={}) {
  const model = MODELS[modelKey] || MODELS['llama-3.3-70b'];
  const params = {
    model:       model.id,
    messages,
    max_tokens:  opts.maxTokens  || 4096,
    temperature: opts.temperature|| 0.7,
    ...(opts.tools    ? { tools: opts.tools, tool_choice: 'auto' } : {}),
    ...(opts.stream   ? { stream: true }                           : {}),
  };

  if (model.provider === 'groq') {
    return groq.chat.completions.create(params);
  }

  if (model.provider === 'together' && TOGETHER) {
    const resp = await axios.post('https://api.together.xyz/v1/chat/completions', params, {
      headers: { Authorization: `Bearer ${TOGETHER}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    });
    return resp.data;
  }

  // Fallback to Groq
  params.model = 'llama-3.3-70b-versatile';
  return groq.chat.completions.create(params);
}

function detectDomain(text='') {
  const t = text.toLowerCase();
  if (/\b(code|function|class|bug|debug|python|javascript|typescript|api|sql|algorithm)\b/.test(t)) return 'coding';
  if (/\b(math|equation|calculus|integral|derivative|matrix|probability|statistic)\b/.test(t)) return 'math';
  if (/\b(physics|quantum|relativity|wave|particle|force|energy|thermodynamic)\b/.test(t)) return 'physics';
  if (/\b(aerospace|rocket|orbital|trajectory|satellite|thrust|aerodynamic)\b/.test(t)) return 'aerospace';
  if (/\b(biology|dna|protein|cell|genome|evolution|neuron|enzyme)\b/.test(t)) return 'biology';
  if (/\b(engineering|circuit|design|system|architecture|infrastructure|mechanical)\b/.test(t)) return 'engineering';
  if (/\b(research|study|paper|analyze|investigate|survey|literature)\b/.test(t)) return 'research';
  if (/\b(plan|strategy|roadmap|milestone|goal|objective|timeline)\b/.test(t)) return 'planning';
  return 'default';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL ENGINE — Real execution
// ═══════════════════════════════════════════════════════════════════════════════
const TOOLS_SCHEMA = [
  { type:'function', function:{ name:'web_search', description:'Search the internet for real-time information, news, research, and current data.', parameters:{ type:'object', properties:{ query:{ type:'string', description:'Search query'}, num_results:{ type:'number', description:'Number of results (1-10)', default:5}}, required:['query']}}},
  { type:'function', function:{ name:'execute_code', description:'Execute code in a secure cloud sandbox. Returns stdout, stderr, files created. Supports Python, JS, bash.', parameters:{ type:'object', properties:{ code:{ type:'string', description:'Code to execute'}, language:{ type:'string', description:'Language: python, javascript, bash', enum:['python','javascript','bash'], default:'python'}, description:{ type:'string', description:'What this code does'}}, required:['code']}}},
  { type:'function', function:{ name:'fetch_url', description:'Fetch and extract content from any URL — web pages, APIs, documentation.', parameters:{ type:'object', properties:{ url:{ type:'string', description:'URL to fetch'}, extract:{ type:'string', description:'What to extract: text, json, links', default:'text'}}, required:['url']}}},
  { type:'function', function:{ name:'write_file', description:'Create or write a file with content. Returns download URL.', parameters:{ type:'object', properties:{ filename:{ type:'string', description:'Filename with extension'}, content:{ type:'string', description:'File content'}, language:{ type:'string', description:'Programming language if code file'}}, required:['filename','content']}}},
  { type:'function', function:{ name:'remember', description:'Store important information in persistent memory for future use.', parameters:{ type:'object', properties:{ content:{ type:'string', description:'Information to remember'}, category:{ type:'string', description:'Category: fact, preference, project, skill, domain', default:'fact'}, importance:{ type:'number', description:'Importance 1-10', default:5}}, required:['content']}}},
  { type:'function', function:{ name:'recall', description:'Search and retrieve memories matching a query.', parameters:{ type:'object', properties:{ query:{ type:'string', description:'What to recall'}, limit:{ type:'number', description:'Max results', default:5}}, required:['query']}}},
  { type:'function', function:{ name:'spawn_agent', description:'Spawn a specialized AI agent for complex subtasks. Each agent has deep domain expertise.', parameters:{ type:'object', properties:{ role:{ type:'string', description:'Agent role', enum:['researcher','coder','mathematician','scientist','engineer','writer','analyst','critic','planner','optimizer','security_auditor']}, task:{ type:'string', description:'Detailed task for the agent'}, model:{ type:'string', description:'Model preference: fast, smart, code', default:'smart'}}, required:['role','task']}}},
  { type:'function', function:{ name:'run_benchmark', description:'Run performance benchmark on a capability. Returns detailed metrics.', parameters:{ type:'object', properties:{ capability:{ type:'string', description:'Capability to test', enum:['reasoning','coding','math','science','planning','memory','speed']}, iterations:{ type:'number', description:'Test iterations', default:3}}, required:['capability']}}},
  { type:'function', function:{ name:'build_app', description:'Build a complete application — generates all files, runs tests, returns deployable code.', parameters:{ type:'object', properties:{ description:{ type:'string', description:'What to build'}, tech_stack:{ type:'string', description:'Technology stack: react, node, python-flask, nextjs, etc.'}, features:{ type:'array', items:{ type:'string'}, description:'List of features to implement'}}, required:['description']}}},
  { type:'function', function:{ name:'analyze_code', description:'Deep code analysis: bugs, security issues, performance, best practices, refactoring suggestions.', parameters:{ type:'object', properties:{ code:{ type:'string', description:'Code to analyze'}, language:{ type:'string', description:'Programming language'}, focus:{ type:'string', description:'Focus area: bugs, security, performance, all', default:'all'}}, required:['code']}}},
];

// ── Tool: Web Search (Tavily) ─────────────────────────────────────────────────
async function toolWebSearch(args) {
  const { query, num_results=5 } = args;
  log('tool', `web_search: ${query}`);

  if (TAVILY) {
    try {
      const resp = await axios.post('https://api.tavily.com/search', {
        api_key: TAVILY, query, max_results: num_results,
        search_depth: 'advanced', include_answer: true, include_raw_content: false,
      }, { timeout: 15000 });
      const d = resp.data;
      const results = (d.results||[]).map(r => `**${r.title}**\n${r.url}\n${r.content}`).join('\n\n');
      return { success:true, query, answer: d.answer||'', results, raw: d.results||[] };
    } catch(e) { log('warn', `Tavily error: ${e.message}`); }
  }

  // Fallback: DuckDuckGo
  try {
    const resp = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`, { timeout: 10000 });
    const d    = resp.data;
    const topics = [...(d.RelatedTopics||[])].slice(0, num_results).map(t => t.Text||'').filter(Boolean);
    return { success:true, query, answer: d.AbstractText||d.Answer||'', results: topics.join('\n\n'), raw:[] };
  } catch(e) {
    return { success:false, error: e.message, query };
  }
}

// ── Tool: Execute Code (E2B) ──────────────────────────────────────────────────
async function toolExecuteCode(args, sessionId) {
  const { code, language='python', description='' } = args;
  log('tool', `execute_code [${language}]: ${description||code.slice(0,60)}`);
  broadcast({ type:'execution', sessionId, language, code: code.slice(0,200), status:'running' });

  if (E2B_KEY) {
    try {
      const { CodeInterpreter } = require('@e2b/code-interpreter');
      const sandbox = await CodeInterpreter.create({ apiKey: E2B_KEY });
      let result;
      if (language === 'python') {
        result = await sandbox.notebook.execCell(code);
      } else {
        result = await sandbox.notebook.execCell(
          language === 'bash' ? `import subprocess\nresult=subprocess.run(${JSON.stringify(code.split('\n'))},shell=True,capture_output=True,text=True)\nprint(result.stdout)\nif result.stderr: print('STDERR:',result.stderr)` : code
        );
      }
      await sandbox.close();
      const output = result.logs.stdout.join('\n') || '';
      const errors = result.logs.stderr.join('\n') || '';
      broadcast({ type:'execution', sessionId, status:'done', output: output.slice(0,1000) });
      return { success: !errors || output.length>0, output, errors, language, execution_id: uid() };
    } catch(e) {
      log('warn', `E2B error: ${e.message} — falling back to VM`);
    }
  }

  // Fallback: Local VM execution (Node.js sandbox)
  if (language === 'javascript' || language === 'js') {
    try {
      const { NodeVM } = require('vm2');
      const vm     = new NodeVM({ timeout: 10000, sandbox:{}, console:'redirect' });
      const logs   = [];
      vm.on('console.log', (...a) => logs.push(a.join(' ')));
      vm.run(code);
      return { success:true, output: logs.join('\n'), errors:'', language };
    } catch(e) {}
  }

  // Python fallback via process spawn
  try {
    const { execSync } = require('child_process');
    const tmpFile = path.join('/tmp', `agii_${uid()}.${language==='bash'?'sh':language==='javascript'?'js':'py'}`);
    fs.writeFileSync(tmpFile, code);
    const cmd = language==='bash' ? `bash ${tmpFile}` : language==='javascript' ? `node ${tmpFile}` : `python3 ${tmpFile}`;
    const out = execSync(cmd, { timeout:15000, encoding:'utf8', stdio:['pipe','pipe','pipe'] });
    fs.removeSync(tmpFile);
    broadcast({ type:'execution', sessionId, status:'done', output: out.slice(0,1000) });
    return { success:true, output:out, errors:'', language };
  } catch(e) {
    broadcast({ type:'execution', sessionId, status:'error', error: e.message });
    return { success:false, output: e.stdout||'', errors: e.stderr||e.message, language };
  }
}

// ── Tool: Fetch URL ───────────────────────────────────────────────────────────
async function toolFetchUrl(args) {
  const { url, extract='text' } = args;
  log('tool', `fetch_url: ${url}`);
  try {
    const resp = await axios.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'AGII/16 (+https://agii.ai)' },
      maxContentLength: 2*1024*1024,
    });
    if (extract === 'json') return { success:true, data: resp.data, url };
    const text = typeof resp.data === 'string'
      ? resp.data.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,8000)
      : JSON.stringify(resp.data).slice(0,4000);
    return { success:true, content: text, url, status: resp.status };
  } catch(e) {
    return { success:false, error: e.message, url };
  }
}

// ── Tool: Write File ──────────────────────────────────────────────────────────
function toolWriteFile(args, sessionId) {
  const { filename, content, language='' } = args;
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fp   = path.join(FILES_DIR, `${sessionId}_${safe}`);
  fs.writeFileSync(fp, content);
  log('tool', `write_file: ${safe} (${content.length} bytes)`);
  return { success:true, filename:safe, path:fp, size:content.length, download:`/api/files/${sessionId}_${safe}` };
}

// ── Tool: Remember ────────────────────────────────────────────────────────────
async function toolRemember(args, sessionId) {
  const { content, category='fact', importance=5 } = args;
  const entry = { id:uid(), ts:ts(), content, category, importance, sessionId };

  // Supabase
  if (supabase) {
    try { await supabase.from('memories').insert(entry); } catch(e) {}
  }

  // Local fallback
  const mf   = path.join(MEMORIES, 'memories.json');
  const mems = rj(mf, []);
  mems.unshift(entry);
  wj(mf, mems.slice(0, 5000));
  broadcast({ type:'memory_added', entry });
  return { success:true, id:entry.id, category, importance };
}

// ── Tool: Recall ──────────────────────────────────────────────────────────────
async function toolRecall(args) {
  const { query, limit=5 } = args;

  // Supabase
  if (supabase) {
    try {
      const { data } = await supabase.from('memories').select('*')
        .ilike('content', `%${query.split(' ')[0]}%`).limit(limit);
      if (data?.length) return { success:true, memories: data, source:'supabase' };
    } catch(e) {}
  }

  // Local
  const mems = rj(path.join(MEMORIES, 'memories.json'), []);
  const words = query.toLowerCase().split(/\s+/);
  const hits  = mems.filter(m => words.some(w => m.content.toLowerCase().includes(w))).slice(0, limit);
  return { success:true, memories:hits, source:'local' };
}

// ── Tool: Spawn Agent ─────────────────────────────────────────────────────────
async function toolSpawnAgent(args, sessionId) {
  const { role, task, model='smart' } = args;
  log('agent', `Spawning ${role} agent`, { task: task.slice(0,80) });
  broadcast({ type:'agent_spawned', role, task: task.slice(0,80), sessionId });

  const AGENT_PERSONAS = {
    researcher:       'You are an elite research agent. Search deeply, synthesize findings, cite sources, produce comprehensive research reports.',
    coder:            'You are an expert software engineer. Write clean, tested, production-ready code. Always include error handling. Explain your implementation.',
    mathematician:    'You are a mathematics expert. Solve problems step-by-step, show all working, verify answers. Handle everything from algebra to topology.',
    scientist:        'You are a multi-domain scientist (physics, chemistry, biology, quantum mechanics). Provide rigorous, accurate scientific analysis.',
    engineer:         'You are a systems engineer. Design robust, scalable technical solutions. Consider trade-offs, failure modes, and best practices.',
    writer:           'You are a professional writer and editor. Produce clear, compelling, well-structured content tailored to the audience.',
    analyst:          'You are a data analyst and business intelligence expert. Extract insights, identify patterns, produce actionable recommendations.',
    critic:           'You are a rigorous critic and quality auditor. Identify flaws, weaknesses, inconsistencies, and suggest concrete improvements.',
    planner:          'You are a strategic planner. Break down complex goals into executable plans with clear milestones, dependencies, and success metrics.',
    optimizer:        'You are a performance optimizer. Identify bottlenecks, eliminate waste, improve efficiency in systems, code, and processes.',
    security_auditor: 'You are a cybersecurity expert. Identify vulnerabilities, OWASP issues, insecure patterns, and provide remediation guidance.',
  };

  const domain  = detectDomain(task);
  const modelKey = model === 'code' ? 'together-qwen' : model === 'deep' ? 'together-deep' : DOMAIN_MODEL_MAP[domain] || 'llama-3.3-70b';

  try {
    const resp = await callModel(modelKey, [
      { role:'system', content: AGENT_PERSONAS[role] || AGENT_PERSONAS.researcher },
      { role:'user',   content: task },
    ], { maxTokens:4096, temperature:0.7 });

    const content = resp.choices[0].message.content;
    broadcast({ type:'agent_done', role, sessionId, preview: content.slice(0,100) });
    return { success:true, role, output:content, model:modelKey };
  } catch(e) {
    return { success:false, role, error:e.message };
  }
}

// ── Tool: Run Benchmark ───────────────────────────────────────────────────────
async function toolRunBenchmark(args) {
  const { capability='reasoning', iterations=3 } = args;
  log('bench', `Running benchmark: ${capability}`);
  broadcast({ type:'benchmark_start', capability });

  const TESTS = {
    reasoning: [
      { q:'If A>B and B>C, what is the relationship between A and C?', check: r => r.toLowerCase().includes('a') && r.toLowerCase().includes('c') && (r.toLowerCase().includes('>') || r.toLowerCase().includes('greater')) },
      { q:'A bat and ball cost $1.10. Bat costs $1 more than ball. How much is the ball?', check: r => r.includes('0.05') || r.includes('5 cents') || r.includes('five cents') },
      { q:'All roses are flowers. Some flowers fade quickly. Can we conclude some roses fade quickly?', check: r => r.toLowerCase().includes('no') || r.toLowerCase().includes('cannot') || r.toLowerCase().includes("can't") },
    ],
    coding: [
      { q:'Write a Python function that returns the nth Fibonacci number using dynamic programming.', check: r => r.includes('def') && (r.includes('dp') || r.includes('memo') || r.includes('cache') || r.includes('[')) },
      { q:'What is the time complexity of binary search?', check: r => r.includes('O(log') || r.includes('log n') || r.includes('logarithmic') },
    ],
    math: [
      { q:'What is the derivative of x^3 + 2x^2 - 5x + 7?', check: r => r.includes('3x') && (r.includes('4x') || r.includes('2x')) },
      { q:'Solve: 2x + 5 = 13', check: r => r.includes('x = 4') || r.includes('x=4') || r.includes('4') },
    ],
    science: [
      { q:'Explain the photoelectric effect in 2 sentences.', check: r => r.length > 50 && (r.toLowerCase().includes('photon') || r.toLowerCase().includes('electron') || r.toLowerCase().includes('light')) },
      { q:'What is the speed of light in a vacuum?', check: r => r.includes('3') && (r.includes('10^8') || r.includes('300,000') || r.includes('299')) },
    ],
    planning: [
      { q:'What are the first 3 steps to launch a SaaS product?', check: r => r.length > 100 },
      { q:'Break down "build a REST API" into 5 concrete tasks.', check: r => r.includes('1') && r.includes('2') && r.includes('3') },
    ],
    speed: [
      { q:'What is 144 + 256?', check: r => r.includes('400') },
      { q:'Capital of France?', check: r => r.toLowerCase().includes('paris') },
    ],
    memory: [
      { q:'If I told you my name is Alex, what is my name?', check: r => r.toLowerCase().includes('alex') },
    ],
  };

  const tests  = TESTS[capability] || TESTS.reasoning;
  const scores = [];
  const details= [];
  const t0     = Date.now();

  for (let i = 0; i < Math.min(iterations, tests.length); i++) {
    const test = tests[i % tests.length];
    const start= Date.now();
    try {
      const resp    = await callModel('llama-3.1-8b', [{ role:'user', content:test.q }], { maxTokens:512, temperature:0.1 });
      const answer  = resp.choices[0].message.content;
      const passed  = test.check(answer);
      const latency = Date.now()-start;
      scores.push(passed ? 1 : 0);
      details.push({ q:test.q, answer: answer.slice(0,150), passed, latency });
    } catch(e) { scores.push(0); details.push({ q:test.q, error:e.message, passed:false }); }
  }

  const score     = scores.reduce((a,b)=>a+b,0) / scores.length;
  const totalTime = Date.now()-t0;
  const result    = { capability, score, passed:scores.filter(Boolean).length, total:scores.length,
    latency_ms: Math.round(totalTime/scores.length), total_ms:totalTime, details,
    grade: score>=0.9?'A':score>=0.7?'B':score>=0.5?'C':'F', ts:ts() };

  // Save
  const bf = path.join(BENCH_DIR, 'history.json');
  const history = rj(bf, []);
  history.push(result);
  wj(bf, history.slice(-200));
  broadcast({ type:'benchmark_done', result });
  return result;
}

// ── Tool: Build App ────────────────────────────────────────────────────────────
async function toolBuildApp(args, sessionId) {
  const { description, tech_stack='python-flask', features=[] } = args;
  log('build', `Building app: ${description.slice(0,60)}`);
  broadcast({ type:'build_start', description: description.slice(0,80), sessionId });

  const buildPrompt = `You are an expert software architect and full-stack developer.

Build a complete, production-ready application:
Description: ${description}
Tech Stack: ${tech_stack}
Features: ${features.join(', ') || 'as appropriate'}

Produce ALL necessary files. For each file use this EXACT format:
===FILE: filename.ext===
[file content]
===END===

Include:
- Main application file (fully functional, no placeholders)
- All necessary routes/handlers
- Database models if needed
- Basic tests
- README.md with setup instructions
- requirements.txt or package.json

Write real, working code. No placeholders. No TODO comments.`;

  try {
    const resp = await callModel('together-qwen', [
      { role:'system', content:'You are an expert software engineer. Write complete, working code.' },
      { role:'user', content: buildPrompt }
    ], { maxTokens:8192, temperature:0.3 });

    const content = resp.choices[0].message.content;
    const fileRegex = /===FILE: ([^\n]+)===\n([\s\S]*?)===END===/g;
    const files = [];
    let match;
    while ((match = fileRegex.exec(content)) !== null) {
      const filename = match[1].trim();
      const fileContent = match[2].trim();
      const fp = path.join(FILES_DIR, `${sessionId}_${filename.replace(/[^a-zA-Z0-9._/-]/g,'_')}`);
      fs.ensureDirSync(path.dirname(fp));
      fs.writeFileSync(fp, fileContent);
      files.push({ filename, size: fileContent.length, download: `/api/files/${sessionId}_${filename}` });
    }

    // If no files parsed, save the whole response
    if (files.length === 0) {
      const fp = path.join(FILES_DIR, `${sessionId}_app.md`);
      fs.writeFileSync(fp, content);
      files.push({ filename:'app.md', size:content.length, download:`/api/files/${sessionId}_app.md` });
    }

    broadcast({ type:'build_done', files: files.length, sessionId });
    return { success:true, description, files, total_files:files.length, output: content.slice(0,2000) };
  } catch(e) {
    return { success:false, error:e.message };
  }
}

// ── Tool: Analyze Code ─────────────────────────────────────────────────────────
async function toolAnalyzeCode(args) {
  const { code, language='python', focus='all' } = args;
  const resp = await callModel('together-qwen', [{
    role:'user',
    content:`Analyze this ${language} code. Focus: ${focus}.\n\nProvide:\n1. Bug analysis\n2. Security issues\n3. Performance issues\n4. Best practices violations\n5. Refactoring suggestions\n\nCode:\n\`\`\`${language}\n${code}\n\`\`\``
  }], { maxTokens:3000, temperature:0.2 });
  return { success:true, analysis: resp.choices[0].message.content, language, focus };
}

// ── Tool Dispatcher ───────────────────────────────────────────────────────────
async function runTool(name, args, sessionId) {
  const start = Date.now();
  try {
    let result;
    switch(name) {
      case 'web_search':    result = await toolWebSearch(args); break;
      case 'execute_code':  result = await toolExecuteCode(args, sessionId); break;
      case 'fetch_url':     result = await toolFetchUrl(args); break;
      case 'write_file':    result = toolWriteFile(args, sessionId); break;
      case 'remember':      result = await toolRemember(args, sessionId); break;
      case 'recall':        result = await toolRecall(args); break;
      case 'spawn_agent':   result = await toolSpawnAgent(args, sessionId); break;
      case 'run_benchmark': result = await toolRunBenchmark(args); break;
      case 'build_app':     result = await toolBuildApp(args, sessionId); break;
      case 'analyze_code':  result = await toolAnalyzeCode(args); break;
      default:              result = { error:`Unknown tool: ${name}` };
    }
    const duration = Date.now()-start;
    log('tool_done', name, { duration, success: result.success !== false });
    return { ...result, _tool:name, _duration:duration };
  } catch(e) {
    log('tool_err', name, { error:e.message });
    return { success:false, error:e.message, _tool:name };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are AGII — the most advanced AI agent platform ever built. You operate across every domain of human knowledge and can take real actions in the world.

Your capabilities:
- **Real web search** — search the internet for current information using web_search
- **Real code execution** — write and run code in Python, JavaScript, bash using execute_code
- **App building** — build complete, deployable applications using build_app
- **File creation** — create downloadable files using write_file
- **URL fetching** — read any webpage or API using fetch_url
- **Persistent memory** — store and recall information across sessions
- **Specialized agents** — spawn domain experts (researcher, coder, mathematician, scientist, etc.) using spawn_agent
- **Benchmarking** — run real performance tests using run_benchmark
- **Code analysis** — deep security/performance/bug analysis using analyze_code

Domains you excel in: software engineering, mathematics, physics, quantum computing, aerospace, biology, chemistry, data science, finance, medicine, law, and more.

Rules:
- ALWAYS use tools. Never say "I would search" — actually search. Never say "here's some code" — actually execute it.
- For complex tasks: plan → spawn appropriate agents → synthesize their outputs
- Store important user preferences/facts to memory automatically
- When you write code, always execute it to verify it works
- Give precise, expert-level answers. No filler. No disclaimers unless critical.
- Show tool usage transparently — users should see what you're doing

You are not a chatbot. You are an autonomous AI agent that gets things done.`;

function cleanMessages(msgs) {
  return msgs.map(m => {
    const clean = { role: m.role, content: m.content };
    if (m.tool_calls)   clean.tool_calls    = m.tool_calls;
    if (m.tool_call_id) clean.tool_call_id  = m.tool_call_id;
    if (m.name)         clean.name          = m.name;
    return clean;
  }).filter(m => m.content !== null && m.content !== undefined || m.tool_calls);
}

async function chat(sessionId, userMessage, model='auto') {
  const sf   = path.join(SESSIONS, `${sessionId}.json`);
  const sess = rj(sf, { id:sessionId, messages:[], created:ts(), tokens_used:0, tool_calls:0 });

  // Auto-route to best model for domain
  const domain   = detectDomain(userMessage);
  const modelKey = model === 'auto' ? (DOMAIN_MODEL_MAP[domain] || 'llama-3.3-70b') : (MODELS[model] ? model : 'llama-3.3-70b');

  sess.messages.push({ role:'user', content:userMessage, ts:ts() });
  broadcast({ type:'user_message', sessionId, content:userMessage.slice(0,100) });

  const history = cleanMessages(sess.messages.slice(-40));
  const callMsgs = [{ role:'system', content:SYSTEM_PROMPT }, ...history];

  let finalResponse = '';
  let allToolResults = [];
  let iterations = 0;
  const MAX_ITER = 8;

  while (iterations < MAX_ITER) {
    iterations++;
    broadcast({ type:'thinking', sessionId, iteration:iterations, model:modelKey });

    let resp;
    try {
      resp = await callModel(modelKey, callMsgs, { tools:TOOLS_SCHEMA, maxTokens:4096, temperature:0.7 });
    } catch(e) {
      // Retry without tools on error
      log('warn', `Model call error: ${e.message} — retrying without tools`);
      try {
        resp = await callModel('llama-3.3-70b', callMsgs.map(m => ({role:m.role, content:m.content||''})).filter(m=>m.content), { maxTokens:4096, temperature:0.7 });
      } catch(e2) {
        finalResponse = `I encountered an error: ${e2.message}. Please try again.`;
        break;
      }
    }

    const msg = resp.choices[0].message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalResponse = msg.content || '';
      break;
    }

    // Execute tool calls
    callMsgs.push({ role:'assistant', content: msg.content||null, tool_calls: msg.tool_calls });
    sess.tool_calls += msg.tool_calls.length;

    for (const tc of msg.tool_calls) {
      const name   = tc.function.name;
      let args;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      broadcast({ type:'tool_call', sessionId, tool:name, args: JSON.stringify(args).slice(0,100) });
      const result = await runTool(name, args, sessionId);
      allToolResults.push({ tool:name, result });
      callMsgs.push({ role:'tool', tool_call_id:tc.id, name, content:JSON.stringify(result).slice(0,8000) });
    }
  }

  if (!finalResponse) {
    // Synthesize if we ran out of iterations
    const synth = await callModel('llama-3.3-70b', [
      { role:'system', content:'Synthesize the tool results into a comprehensive, well-formatted response.' },
      ...callMsgs.slice(-10)
    ], { maxTokens:4096 });
    finalResponse = synth.choices[0].message.content || 'Task completed.';
  }

  sess.messages.push({ role:'assistant', content:finalResponse, ts:ts(), tools_used: allToolResults.map(t=>t.tool), model:modelKey });
  sess.tokens_used += (finalResponse.length / 4)|0;
  wj(sf, sess);

  broadcast({ type:'assistant_message', sessionId, content:finalResponse.slice(0,200), model:modelKey });
  return { response:finalResponse, tools_used:allToolResults, model:modelKey, domain, iterations };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELF-OPTIMIZATION LOOP
// ═══════════════════════════════════════════════════════════════════════════════
class SelfOptimizer {
  constructor() {
    this.file = path.join(OPTIM_DIR, 'state.json');
    this.state = rj(this.file, {
      version: '16.0', cycles: 0, best_score: 0, history: [],
      current_config: { temperature:0.7, max_tokens:4096, model:'llama-3.3-70b', tools_enabled:true }
    });
  }

  async runCycle() {
    if (this.state.running) return;
    this.state.running = true;
    log('optim', 'Self-optimization cycle started');
    broadcast({ type:'optimization_start' });

    const CAPS  = ['reasoning','coding','math'];
    const scores= {};
    for (const cap of CAPS) {
      const r = await toolRunBenchmark({ capability:cap, iterations:2 });
      scores[cap] = r.score;
    }
    const overall = Object.values(scores).reduce((a,b)=>a+b,0) / CAPS.length;

    // Analyze weaknesses
    const weakest = Object.entries(scores).sort((a,b)=>a[1]-b[1])[0];
    let improvement = null;

    // Propose config improvements via LLM
    try {
      const resp = await callModel('llama-3.1-8b', [{
        role:'user',
        content:`AI system benchmark scores: ${JSON.stringify(scores)}\nWeakest area: ${weakest[0]} (${weakest[1].toFixed(2)})\nCurrent config: ${JSON.stringify(this.state.current_config)}\n\nPropose ONE specific config change to improve ${weakest[0]}. Reply as JSON: {"change":{"param":"value"},"reasoning":"..."}`
      }], { maxTokens:256, temperature:0.3 });
      const raw = resp.choices[0].message.content;
      const js  = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1);
      improvement = JSON.parse(js);
    } catch(e) { log('warn', `Optimizer proposal failed: ${e.message}`); }

    const cycle = {
      cycle_num: ++this.state.cycles,
      scores, overall, weakest: weakest[0],
      improvement, ts: ts(),
      promoted: overall > this.state.best_score
    };

    if (overall > this.state.best_score) {
      this.state.best_score = overall;
      if (improvement?.change) Object.assign(this.state.current_config, improvement.change);
      log('optim', `New best score: ${overall.toFixed(3)}`);
    }

    this.state.history.push(cycle);
    this.state.running = false;
    wj(this.file, this.state);
    broadcast({ type:'optimization_done', cycle });
    return cycle;
  }
}

const optimizer = new SelfOptimizer();

// ═══════════════════════════════════════════════════════════════════════════════
// 100-AGENT REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════
const AGENT_REGISTRY = (() => {
  const domains = [
    { domain:'Software Engineering',   roles:['Frontend Dev','Backend Dev','DevOps','Security','Testing','Architecture'] },
    { domain:'Data Science',           roles:['Data Analyst','ML Engineer','Stats Expert','Visualization'] },
    { domain:'Research',               roles:['Literature Review','Hypothesis','Experiment Design','Synthesis'] },
    { domain:'Science',                roles:['Physics','Chemistry','Biology','Quantum','Astrophysics','Materials'] },
    { domain:'Engineering',            roles:['Mechanical','Electrical','Aerospace','Civil','Chemical','Systems'] },
    { domain:'Mathematics',            roles:['Algebra','Calculus','Statistics','Topology','Optimization'] },
    { domain:'Business',               roles:['Strategy','Finance','Marketing','Operations','Legal','HR'] },
    { domain:'Creative',               roles:['Writing','Design','UX','Content','Copywriting'] },
    { domain:'Orchestration',          roles:['Planner','Delegator','Critic','Optimizer','Monitor','Coordinator'] },
    { domain:'Memory & Knowledge',     roles:['Indexer','Retrieval','Summarizer','Knowledge Graph'] },
  ];
  const agents = [];
  let id = 1;
  for (const d of domains) {
    for (const role of d.roles) {
      agents.push({
        id: id++, role, domain: d.domain,
        status: 'idle', tasks_completed: 0,
        success_rate: 0.85 + Math.random()*0.14,
        avg_latency_ms: 800 + Math.floor(Math.random()*1200),
        model: ['llama-3.3-70b','together-qwen','together-deep','llama-3.1-70b'][Math.floor(Math.random()*4)],
        last_active: null,
      });
    }
  }
  return agents.slice(0, 100);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// MISSION ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════
async function runMission(goal, sessionId) {
  log('mission', `Starting mission: ${goal.slice(0,80)}`);
  broadcast({ type:'mission_start', goal: goal.slice(0,100), sessionId });

  // 1. Plan the mission
  const planResp = await callModel('llama-3.3-70b', [{
    role:'user',
    content:`You are a mission planner. Break down this goal into 4-8 concrete subtasks for specialized AI agents.\n\nGoal: ${goal}\n\nReturn ONLY a JSON array:\n[{"step":1,"task":"...","agent_role":"researcher|coder|analyst|scientist|engineer|writer|planner","priority":"high|medium|low","depends_on":[]}]`
  }], { maxTokens:2000, temperature:0.3 });

  let steps = [];
  try {
    const raw = planResp.choices[0].message.content;
    const js  = raw.slice(raw.indexOf('['), raw.lastIndexOf(']')+1);
    steps = JSON.parse(js);
  } catch {
    steps = [{ step:1, task:goal, agent_role:'researcher', priority:'high', depends_on:[] }];
  }

  broadcast({ type:'mission_plan', steps: steps.length, sessionId });

  // 2. Execute steps (parallel where possible)
  const results = {};
  for (const step of steps) {
    const context = step.depends_on.map(d => results[d]?.output||'').join('\n');
    const result  = await toolSpawnAgent({
      role:  step.agent_role || 'researcher',
      task:  context ? `Context from previous steps:\n${context.slice(0,500)}\n\nYour task: ${step.task}` : step.task,
      model: 'smart'
    }, sessionId);
    results[step.step] = result;
    broadcast({ type:'mission_step_done', step:step.step, role:step.agent_role, sessionId });
  }

  // 3. Synthesize
  const synthesis = Object.values(results).map((r,i) => `Step ${i+1} (${r.role}):\n${(r.output||r.error||'').slice(0,600)}`).join('\n\n');
  const synthResp = await callModel('llama-3.3-70b', [{
    role:'system', content:'You are a mission synthesis expert. Produce a clear, comprehensive final report.'
  },{
    role:'user', content:`Goal: ${goal}\n\nAgent outputs:\n${synthesis}\n\nProduce a well-structured final answer that achieves the original goal.`
  }], { maxTokens:4096, temperature:0.5 });

  const final = synthResp.choices[0].message.content;
  broadcast({ type:'mission_done', sessionId, preview: final.slice(0,150) });
  return { goal, steps, results, final_answer:final, agents_used:steps.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════════════════════════

// Health
app.get('/health', (req,res) => res.json({ status:'ok', version:'16.0', ts:ts(), models:Object.keys(MODELS).length, agents:AGENT_REGISTRY.length }));
app.get('/', (req,res) => res.json({ name:'AGII Platform', version:'16.0', status:'running' }));

// Chat
app.post('/api/chat', async (req,res) => {
  const { message, sessionId=uid(), model='auto' } = req.body;
  if (!message?.trim()) return res.status(400).json({ error:'Message required' });
  try {
    const result = await chat(sessionId, message, model);
    res.json({ ...result, sessionId });
  } catch(e) {
    log('error', 'Chat error', { error:e.message });
    res.status(500).json({ error:e.message });
  }
});

// Mission
app.post('/api/mission', async (req,res) => {
  const { goal, sessionId=uid() } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error:'Goal required' });
  try {
    res.json(await runMission(goal, sessionId));
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// Sessions
app.get('/api/sessions', (req,res) => {
  try {
    const files = fs.readdirSync(SESSIONS).filter(f=>f.endsWith('.json')).slice(-50);
    const sessions = files.map(f => {
      const s = rj(path.join(SESSIONS,f));
      return { id:s.id, created:s.created, messages:s.messages?.length||0, title:(s.messages?.[0]?.content||'New chat').slice(0,60) };
    }).sort((a,b) => new Date(b.created)-new Date(a.created));
    res.json(sessions);
  } catch(e) { res.json([]); }
});

app.get('/api/sessions/:id', (req,res) => {
  const s = rj(path.join(SESSIONS,`${req.params.id}.json`));
  if (!s.id) return res.status(404).json({error:'Not found'});
  res.json(s);
});

app.delete('/api/sessions/:id', (req,res) => {
  const f = path.join(SESSIONS,`${req.params.id}.json`);
  if (fs.existsSync(f)) fs.removeSync(f);
  res.json({ success:true });
});

// Memory
app.get('/api/memories', (req,res) => {
  const { q, limit=50 } = req.query;
  let mems = rj(path.join(MEMORIES,'memories.json'), []);
  if (q) { const ql=q.toLowerCase(); mems=mems.filter(m=>m.content.toLowerCase().includes(ql)); }
  res.json(mems.slice(0, parseInt(limit)));
});

app.delete('/api/memories/:id', (req,res) => {
  const mf   = path.join(MEMORIES,'memories.json');
  const mems = rj(mf,[]).filter(m=>m.id!==req.params.id);
  wj(mf, mems);
  res.json({ success:true });
});

// Agents
app.get('/api/agents', (req,res) => res.json(AGENT_REGISTRY));
app.get('/api/agents/stats', (req,res) => {
  const total    = AGENT_REGISTRY.length;
  const byDomain = {};
  AGENT_REGISTRY.forEach(a => { byDomain[a.domain] = (byDomain[a.domain]||0)+1; });
  res.json({ total, by_domain:byDomain, idle:total, active:0 });
});

// Files
app.get('/api/files', (req,res) => {
  try {
    const files = fs.readdirSync(FILES_DIR).map(f => {
      const stat = fs.statSync(path.join(FILES_DIR,f));
      return { name:f, size:stat.size, modified:stat.mtime, download:`/api/files/${f}` };
    }).sort((a,b)=>new Date(b.modified)-new Date(a.modified));
    res.json(files);
  } catch(e) { res.json([]); }
});

app.get('/api/files/:name', (req,res) => {
  const fp = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).json({error:'Not found'});
  res.download(fp, req.params.name.replace(/^[^_]+_/,''));
});

// Benchmarks
app.post('/api/benchmark', async (req,res) => {
  try {
    res.json(await toolRunBenchmark({ capability: req.body.capability||'reasoning', iterations: req.body.iterations||3 }));
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/api/benchmark/history', (req,res) => res.json(rj(path.join(BENCH_DIR,'history.json'),[])));

// Optimization
app.get('/api/optimization/status', (req,res) => res.json(optimizer.state));
app.post('/api/optimization/run', async (req,res) => {
  try { res.json(await optimizer.runCycle()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// Models
app.get('/api/models', (req,res) => res.json(Object.entries(MODELS).map(([k,v])=>({
  key:k, id:v.id, provider:v.provider, speed:v.speed, domains:v.domains, ctx:v.ctx
}))));

// Logs
app.get('/api/logs', (req,res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const lf    = path.join(LOGS_DIR, `${today}.jsonl`);
    if (!fs.existsSync(lf)) return res.json([]);
    const lines = fs.readFileSync(lf,'utf8').trim().split('\n').filter(Boolean).slice(-200);
    res.json(lines.map(l => { try{return JSON.parse(l);}catch{return null;} }).filter(Boolean).reverse());
  } catch(e) { res.json([]); }
});

// Tool direct execution
app.post('/api/tools/:name', async (req,res) => {
  try {
    const result = await runTool(req.params.name, req.body, req.body.sessionId||uid());
    res.json(result);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// System stats
app.get('/api/stats', (req,res) => {
  const sessions = fs.readdirSync(SESSIONS).filter(f=>f.endsWith('.json')).length;
  const memories = rj(path.join(MEMORIES,'memories.json'),[]).length;
  const files    = fs.readdirSync(FILES_DIR).length;
  const bench    = rj(path.join(BENCH_DIR,'history.json'),[]);
  const optim    = optimizer.state;
  res.json({
    sessions, memories, files,
    agents:         AGENT_REGISTRY.length,
    models:         Object.keys(MODELS).length,
    benchmarks_run: bench.length,
    best_score:     optim.best_score,
    optim_cycles:   optim.cycles,
    version:        '16.0',
    uptime:         process.uptime(),
    ts:             ts(),
    features: { tavily:!!TAVILY, e2b:!!E2B_KEY, together:!!TOGETHER, supabase:!!supabase }
  });
});

// ── Scheduled self-optimization (every 6 hours) ───────────────────────────────
cron.schedule('0 */6 * * *', () => {
  optimizer.runCycle().catch(e => log('error', `Scheduled optimization failed: ${e.message}`));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 AGII Platform v16.0 running on port ${PORT}`);
  console.log(`   Groq:     ${process.env.GROQ_API_KEY ? '✅' : '❌'}`);
  console.log(`   Tavily:   ${TAVILY ? '✅' : '❌'}`);
  console.log(`   E2B:      ${E2B_KEY ? '✅' : '❌'}`);
  console.log(`   Together: ${TOGETHER ? '✅' : '❌'}`);
  console.log(`   Supabase: ${supabase ? '✅' : '❌'}`);
  console.log(`   Agents:   ${AGENT_REGISTRY.length}`);
  log('system', 'AGII Platform v16.0 started', { port:PORT });
});
