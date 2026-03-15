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

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const limiter = rateLimit({ windowMs: 60000, max: 200 });
app.use(limiter);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── DATA DIRS ────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
['sessions','memory','skills','automations','files','personas'].forEach(d =>
  fs.ensureDirSync(path.join(DATA_DIR, d))
);
fs.ensureDirSync(path.join(__dirname, 'uploads'));

function loadJSON(p, def = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function saveJSON(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

// ─── MEMORY ENGINE ────────────────────────────────────────────────────────────
const memoryFile = path.join(DATA_DIR, 'memory', 'global.json');
let globalMemory = loadJSON(memoryFile, { facts: [], preferences: [], projects: [], notes: [], people: [] });
function saveMemory() { saveJSON(memoryFile, globalMemory); }

function addMemory(type, content, sessionId) {
  const entry = { id: uuidv4(), content, timestamp: new Date().toISOString(), sessionId };
  if (!globalMemory[type]) globalMemory[type] = [];
  const exists = globalMemory[type].some(i => i.content === content);
  if (!exists) {
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
        if (item.content && item.content.toLowerCase().includes(q))
          results.push({ type, ...item });
      });
    }
  }
  return results.slice(-30);
}

function getMemoryContext() {
  const lines = [];
  for (const [type, items] of Object.entries(globalMemory)) {
    if (Array.isArray(items) && items.length > 0) {
      lines.push(`[Memory - ${type}]: ${items.slice(-5).map(i => i.content).join(' | ')}`);
    }
  }
  return lines.join('\n');
}

// ─── SKILLS ENGINE ────────────────────────────────────────────────────────────
const skillsFile = path.join(DATA_DIR, 'skills', 'registry.json');
let skillsRegistry = loadJSON(skillsFile, {});
function saveSkillRegistry() { saveJSON(skillsFile, skillsRegistry); }

// ─── AUTOMATIONS ENGINE ───────────────────────────────────────────────────────
const automationsFile = path.join(DATA_DIR, 'automations', 'registry.json');
let automationsRegistry = loadJSON(automationsFile, {});
const cronJobs = {};

function saveAutomations() { saveJSON(automationsFile, automationsRegistry); }

function scheduleAutomation(auto) {
  if (cronJobs[auto.id]) { cronJobs[auto.id].stop(); delete cronJobs[auto.id]; }
  if (!auto.active || !auto.cron) return;
  try {
    cronJobs[auto.id] = cron.schedule(auto.cron, async () => {
      auto.lastRun = new Date().toISOString();
      auto.runCount = (auto.runCount || 0) + 1;
      saveAutomations();
      // Run the automation task via AI
      const sid = uuidv4();
      const session = createSession(sid);
      session.title = `Auto: ${auto.name}`;
      const userMsg = { role: 'user', content: auto.task };
      session.messages.push(userMsg);
      try {
        const result = await runAgentLoop(session, sid);
        auto.lastResult = result.slice(0, 500);
        saveAutomations();
      } catch(e) { auto.lastResult = `Error: ${e.message}`; saveAutomations(); }
    });
  } catch(e) { console.error('Cron error:', e.message); }
}

// Start all active automations on boot
Object.values(automationsRegistry).forEach(a => scheduleAutomation(a));

// ─── PERSONAS ─────────────────────────────────────────────────────────────────
const personasFile = path.join(DATA_DIR, 'personas', 'registry.json');
let personasRegistry = loadJSON(personasFile, {
  default: {
    id: 'default',
    name: 'AGII',
    avatar: '🤖',
    systemPrompt: `You are AGII — the world's most advanced AI agent. You are sharp, capable, and genuinely helpful. You have access to tools for web search, code execution, memory, file creation, and more. You reason deeply, use tools proactively, and always give the best possible answer. Be concise but thorough. When you don't know something, search for it.`,
    model: 'llama-3.3-70b-versatile',
    temperature: 0.7,
    created: new Date().toISOString()
  }
});
function savePersonas() { saveJSON(personasFile, personasRegistry); }

// ─── SESSION MANAGER ──────────────────────────────────────────────────────────
const sessions = {};

function createSession(sessionId, personaId = 'default') {
  const sessionFile = path.join(DATA_DIR, 'sessions', `${sessionId}.json`);
  const persona = personasRegistry[personaId] || personasRegistry['default'];
  sessions[sessionId] = loadJSON(sessionFile, {
    id: sessionId, messages: [], title: 'New Conversation',
    created: new Date().toISOString(), model: persona.model,
    personaId, pinned: false, archived: false
  });
  return sessions[sessionId];
}

function getSession(sessionId) {
  if (!sessions[sessionId]) createSession(sessionId);
  return sessions[sessionId];
}

function saveSession(sessionId) {
  const s = sessions[sessionId];
  if (s) saveJSON(path.join(DATA_DIR, 'sessions', `${s.id}.json`), s);
}

function listSessions() {
  try {
    return fs.readdirSync(path.join(DATA_DIR, 'sessions'))
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const d = loadJSON(path.join(DATA_DIR, 'sessions', f));
        return { id: d.id, title: d.title, created: d.created, messageCount: d.messages?.length || 0, pinned: d.pinned, archived: d.archived, personaId: d.personaId };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  } catch { return []; }
}

// ─── TOOLS DEFINITION ────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the internet for real-time information, news, facts, prices, weather, or anything current. Use this liberally whenever information might be outdated.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Number of results (default 6)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and read full text content of any webpage, article, or URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_code',
      description: 'Execute JavaScript code for math, data processing, algorithms, analysis, or any computation. Returns the result.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code. Use return statement for output.' },
          description: { type: 'string', description: 'What this code does' }
        },
        required: ['code', 'description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Store important information in long-term persistent memory. Use when user shares personal info, preferences, or asks you to remember something.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['facts', 'preferences', 'projects', 'notes', 'people'] },
          content: { type: 'string', description: 'What to remember' }
        },
        required: ['type', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search long-term memory for previously stored information.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to search for' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a text, code, CSV, markdown, JSON, or any text file and make it downloadable.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'File name with extension' },
          content: { type: 'string', description: 'File content' }
        },
        required: ['filename', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_skill',
      description: 'Save a reusable JavaScript function as a named skill for future use.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (camelCase)' },
          description: { type: 'string', description: 'What it does' },
          code: { type: 'string', description: 'JavaScript code' }
        },
        required: ['name', 'description', 'code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_skill',
      description: 'Run a previously saved skill by name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name to run' },
          args: { type: 'object', description: 'Arguments to pass' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List all saved skills.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reason_and_plan',
      description: 'Deep reasoning: break a complex problem into steps, think through it carefully, and produce a structured plan.',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: 'The problem or goal' },
          context: { type: 'string', description: 'Relevant context' }
        },
        required: ['problem']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get current date, time, and timezone info.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image_url',
      description: 'Analyze and describe what is in an image from a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Image URL' },
          question: { type: 'string', description: 'Specific question about the image' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_automation',
      description: 'Create a scheduled automation that runs a task automatically on a cron schedule.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Automation name' },
          description: { type: 'string', description: 'What it does' },
          task: { type: 'string', description: 'The message/prompt to run on schedule' },
          cron: { type: 'string', description: 'Cron expression (e.g. "0 9 * * *" for daily 9am)' }
        },
        required: ['name', 'task', 'cron']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Perform mathematical calculations, unit conversions, statistics.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Math expression to evaluate' }
        },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'summarize_text',
      description: 'Summarize a long block of text into key points.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to summarize' },
          style: { type: 'string', enum: ['bullet', 'paragraph', 'tldr'], description: 'Summary style' }
        },
        required: ['text']
      }
    }
  }
];

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────
async function executeTool(name, args, sessionId) {
  try {
    switch (name) {

      case 'web_search': {
        const res = await axios.get(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AGII/11.0)' }, timeout: 10000 }
        );
        const cheerio = require('cheerio');
        const $ = cheerio.load(res.data);
        const results = [];
        $('.result').slice(0, args.count || 6).each((i, el) => {
          const title = $(el).find('.result__title').text().trim();
          const snippet = $(el).find('.result__snippet').text().trim();
          const url = $(el).find('.result__url').text().trim();
          if (title) results.push({ title, snippet, url });
        });
        return { success: true, query: args.query, results, count: results.length };
      }

      case 'fetch_url': {
        const res = await axios.get(args.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AGII/11.0)' },
          timeout: 10000, maxContentLength: 500000
        });
        const cheerio = require('cheerio');
        const $ = cheerio.load(res.data);
        $('script,style,nav,footer,header,ads').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
        return { success: true, url: args.url, content: text };
      }

      case 'execute_code': {
        try {
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFunction('Math','Date','JSON','Array','Object','String','Number',
            'console', 'Promise', args.code);
          const logs = [];
          const mockConsole = {
            log: (...a) => logs.push(a.join(' ')),
            error: (...a) => logs.push('ERR: ' + a.join(' '))
          };
          const result = await fn(Math,Date,JSON,Array,Object,String,Number,mockConsole,Promise);
          return { success: true, result: String(result ?? ''), logs, description: args.description };
        } catch(e) {
          return { success: false, error: e.message };
        }
      }

      case 'remember': {
        addMemory(args.type, args.content, sessionId);
        return { success: true, stored: args.content, type: args.type };
      }

      case 'recall': {
        const results = searchMemory(args.query);
        return { success: true, found: results.length, results };
      }

      case 'write_file': {
        const filePath = path.join(DATA_DIR, 'files', args.filename);
        fs.writeFileSync(filePath, args.content);
        return { success: true, filename: args.filename, downloadUrl: `/api/files/${args.filename}` };
      }

      case 'create_skill': {
        skillsRegistry[args.name] = { name: args.name, description: args.description, code: args.code, created: new Date().toISOString() };
        saveSkillRegistry();
        return { success: true, saved: args.name };
      }

      case 'run_skill': {
        const skill = skillsRegistry[args.name];
        if (!skill) return { success: false, error: `Skill "${args.name}" not found` };
        try {
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFunction('args','Math','Date','JSON', skill.code);
          const result = await fn(args.args || {}, Math, Date, JSON);
          return { success: true, result: String(result ?? '') };
        } catch(e) {
          return { success: false, error: e.message };
        }
      }

      case 'list_skills': {
        const skills = Object.values(skillsRegistry).map(s => ({ name: s.name, description: s.description, created: s.created }));
        return { success: true, skills };
      }

      case 'reason_and_plan': {
        const steps = args.problem.split('.').filter(Boolean).map((s, i) => `${i+1}. ${s.trim()}`);
        return { success: true, problem: args.problem, plan: steps, context: args.context };
      }

      case 'get_current_time': {
        const now = new Date();
        return { success: true, iso: now.toISOString(), local: now.toString(), utc: now.toUTCString(), timestamp: now.getTime() };
      }

      case 'analyze_image_url': {
        // Use Groq vision model
        try {
          const completion = await groq.chat.completions.create({
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: args.url } },
                { type: 'text', text: args.question || 'Describe this image in detail.' }
              ]
            }],
            max_tokens: 1024
          });
          return { success: true, analysis: completion.choices[0].message.content };
        } catch(e) {
          return { success: false, error: e.message };
        }
      }

      case 'create_automation': {
        const id = uuidv4();
        const auto = { id, name: args.name, description: args.description, task: args.task, cron: args.cron, active: true, created: new Date().toISOString(), runCount: 0, lastRun: null, lastResult: null };
        automationsRegistry[id] = auto;
        saveAutomations();
        scheduleAutomation(auto);
        return { success: true, id, name: args.name, cron: args.cron };
      }

      case 'calculate': {
        try {
          const result = Function('"use strict"; return (' + args.expression + ')')();
          return { success: true, expression: args.expression, result };
        } catch(e) {
          return { success: false, error: e.message };
        }
      }

      case 'summarize_text': {
        const words = args.text.split(' ');
        const sentences = args.text.split(/[.!?]+/).filter(Boolean).map(s => s.trim());
        const keyPoints = sentences.slice(0, 5);
        return { success: true, wordCount: words.length, style: args.style || 'bullet', keyPoints };
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ─── AGENT LOOP ───────────────────────────────────────────────────────────────
async function runAgentLoop(session, sessionId) {
  const persona = personasRegistry[session.personaId] || personasRegistry['default'];
  const memCtx = getMemoryContext();

  const systemPrompt = `${persona.systemPrompt}

Current date/time: ${new Date().toISOString()}
${memCtx ? `\nWhat you remember about the user:\n${memCtx}` : ''}

You have these tools available:
- web_search: Search the internet for current info
- fetch_url: Read any webpage
- execute_code: Run JavaScript for calculations/processing
- remember/recall: Persistent memory
- write_file: Create downloadable files
- create_skill/run_skill/list_skills: Save & run reusable code
- reason_and_plan: Deep structured thinking
- analyze_image_url: Analyze images
- create_automation: Schedule recurring tasks
- calculate: Math expressions
- summarize_text: Summarize content

Use tools proactively. Think step by step. Be concise and accurate.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.messages.slice(-30)
  ];

  let iterations = 0;
  const maxIterations = 8;
  let finalResponse = '';

  while (iterations < maxIterations) {
    iterations++;
    const completion = await groq.chat.completions.create({
      model: session.model || persona.model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: persona.temperature || 0.7,
      max_tokens: 4096
    });

    const choice = completion.choices[0];
    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason === 'tool_calls' && msg.tool_calls) {
      const toolResults = [];
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments || '{}');
        const result = await executeTool(tc.function.name, args, sessionId);
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)
        });
      }
      messages.push(...toolResults);
    } else {
      finalResponse = msg.content || '';
      break;
    }
  }

  return finalResponse;
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', version: '11.0', timestamp: new Date().toISOString() }));

// Sessions
app.get('/api/sessions', (req, res) => res.json(listSessions()));
app.delete('/api/sessions/:id', (req, res) => {
  const f = path.join(DATA_DIR, 'sessions', `${req.params.id}.json`);
  if (fs.existsSync(f)) fs.removeSync(f);
  delete sessions[req.params.id];
  res.json({ success: true });
});
app.patch('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  Object.assign(session, req.body);
  saveSession(req.params.id);
  res.json({ success: true, session });
});

// Chat (streaming SSE)
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, model, personaId, imageUrl } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: 'Missing message or sessionId' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const session = getSession(sessionId);
    if (model) session.model = model;
    if (personaId) session.personaId = personaId;

    // Build user message
    let userContent = message;
    if (imageUrl) {
      userContent = [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: message }
      ];
    }
    const userMsg = { role: 'user', content: userContent, timestamp: new Date().toISOString() };
    session.messages.push(userMsg);

    // Auto-title after first message
    if (session.messages.length === 1 && session.title === 'New Conversation') {
      session.title = message.slice(0, 60) + (message.length > 60 ? '…' : '');
    }

    send({ type: 'start', sessionId });

    const persona = personasRegistry[session.personaId] || personasRegistry['default'];
    const memCtx = getMemoryContext();

    const systemPrompt = `${persona.systemPrompt}

Current date/time: ${new Date().toISOString()}
${memCtx ? `\nWhat you remember about the user:\n${memCtx}` : ''}

You have these tools available:
- web_search: Search the internet
- fetch_url: Read any webpage
- execute_code: Run JavaScript
- remember/recall: Persistent memory
- write_file: Create files
- create_skill/run_skill/list_skills: Save & run reusable code
- reason_and_plan: Deep thinking
- analyze_image_url: Analyze images
- create_automation: Schedule tasks
- calculate: Math
- summarize_text: Summarize

Use tools proactively when helpful.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...session.messages.slice(-30)
    ];

    let iterations = 0;
    const maxIterations = 8;
    let finalResponse = '';
    const toolsUsed = [];

    while (iterations < maxIterations) {
      iterations++;

      const completion = await groq.chat.completions.create({
        model: session.model || 'llama-3.3-70b-versatile',
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: persona.temperature || 0.7,
        max_tokens: 4096
      });

      const choice = completion.choices[0];
      const msg = choice.message;
      messages.push(msg);

      if (choice.finish_reason === 'tool_calls' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          send({ type: 'tool_start', tool: tc.function.name, args });
          const result = await executeTool(tc.function.name, args, sessionId);
          toolsUsed.push({ name: tc.function.name, args, result });
          send({ type: 'tool_result', tool: tc.function.name, result });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      } else {
        finalResponse = msg.content || '';
        break;
      }
    }

    // Stream the final response token by token simulation
    const words = finalResponse.split(' ');
    for (let i = 0; i < words.length; i++) {
      send({ type: 'token', text: (i === 0 ? '' : ' ') + words[i] });
      await new Promise(r => setTimeout(r, 8));
    }

    // Save assistant message
    const assistantMsg = { role: 'assistant', content: finalResponse, timestamp: new Date().toISOString(), toolsUsed };
    session.messages.push(assistantMsg);
    saveSession(sessionId);

    send({ type: 'done', sessionId, title: session.title, toolsUsed });
    res.end();
  } catch(e) {
    console.error('Chat error:', e);
    send({ type: 'error', message: e.message });
    res.end();
  }
});

// Models
app.get('/api/models', (req, res) => {
  res.json([
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', description: 'Best overall', badge: 'Recommended' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', description: 'Fast & efficient', badge: 'Fast' },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', description: '32K context window', badge: 'Long Context' },
    { id: 'gemma2-9b-it', name: 'Gemma 2 9B', description: 'Google\'s model', badge: 'Google' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout', description: 'Vision + reasoning', badge: 'Vision' },
    { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 70B', description: 'Deep reasoning', badge: 'Reasoning' },
    { id: 'qwen-qwq-32b', name: 'Qwen QwQ 32B', description: 'Advanced reasoning', badge: 'Reasoning' }
  ]);
});

// Memory
app.get('/api/memory', (req, res) => res.json(globalMemory));
app.delete('/api/memory/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (globalMemory[type]) {
    globalMemory[type] = globalMemory[type].filter(i => i.id !== id);
    saveMemory();
  }
  res.json({ success: true });
});
app.delete('/api/memory', (req, res) => {
  globalMemory = { facts: [], preferences: [], projects: [], notes: [], people: [] };
  saveMemory();
  res.json({ success: true });
});

// Skills
app.get('/api/skills', (req, res) => res.json(Object.values(skillsRegistry)));
app.delete('/api/skills/:name', (req, res) => {
  delete skillsRegistry[req.params.name];
  saveSkillRegistry();
  res.json({ success: true });
});

// Automations
app.get('/api/automations', (req, res) => res.json(Object.values(automationsRegistry)));
app.post('/api/automations/:id/toggle', (req, res) => {
  const auto = automationsRegistry[req.params.id];
  if (!auto) return res.status(404).json({ error: 'Not found' });
  auto.active = !auto.active;
  saveAutomations();
  scheduleAutomation(auto);
  res.json({ success: true, active: auto.active });
});
app.delete('/api/automations/:id', (req, res) => {
  const auto = automationsRegistry[req.params.id];
  if (auto) {
    if (cronJobs[req.params.id]) { cronJobs[req.params.id].stop(); delete cronJobs[req.params.id]; }
    delete automationsRegistry[req.params.id];
    saveAutomations();
  }
  res.json({ success: true });
});

// Personas
app.get('/api/personas', (req, res) => res.json(Object.values(personasRegistry)));
app.post('/api/personas', (req, res) => {
  const id = uuidv4();
  const persona = { id, created: new Date().toISOString(), ...req.body };
  personasRegistry[id] = persona;
  savePersonas();
  res.json({ success: true, persona });
});
app.put('/api/personas/:id', (req, res) => {
  if (!personasRegistry[req.params.id]) return res.status(404).json({ error: 'Not found' });
  Object.assign(personasRegistry[req.params.id], req.body);
  savePersonas();
  res.json({ success: true });
});
app.delete('/api/personas/:id', (req, res) => {
  if (req.params.id === 'default') return res.status(400).json({ error: 'Cannot delete default persona' });
  delete personasRegistry[req.params.id];
  savePersonas();
  res.json({ success: true });
});

// Files
app.get('/api/files/:filename', (req, res) => {
  const filePath = path.join(DATA_DIR, 'files', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath);
});
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(path.join(DATA_DIR, 'files'))
      .map(f => {
        const stat = fs.statSync(path.join(DATA_DIR, 'files', f));
        return { name: f, size: stat.size, created: stat.birthtime };
      });
    res.json(files);
  } catch { res.json([]); }
});

// File upload
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ext = path.extname(req.file.originalname);
  const dest = path.join(DATA_DIR, 'files', req.file.originalname);
  fs.moveSync(req.file.path, dest, { overwrite: true });
  res.json({ success: true, filename: req.file.originalname, url: `/api/files/${req.file.originalname}` });
});

// Stats
app.get('/api/stats', (req, res) => {
  const sessionList = listSessions();
  const totalMessages = sessionList.reduce((sum, s) => sum + (s.messageCount || 0), 0);
  const memCount = Object.values(globalMemory).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
  res.json({
    sessions: sessionList.length,
    totalMessages,
    memoryItems: memCount,
    skills: Object.keys(skillsRegistry).length,
    automations: Object.keys(automationsRegistry).length,
    personas: Object.keys(personasRegistry).length,
    version: '11.0'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 AGII v11.0 backend running on port ${PORT}`));
