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

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
const limiter = rateLimit({ windowMs: 60000, max: 100 });
app.use(limiter);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── PERSISTENCE ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(path.join(DATA_DIR, 'sessions'));
fs.ensureDirSync(path.join(DATA_DIR, 'memory'));
fs.ensureDirSync(path.join(DATA_DIR, 'skills'));
fs.ensureDirSync(path.join(DATA_DIR, 'automations'));
fs.ensureDirSync(path.join(__dirname, 'uploads'));

function loadJSON(filePath, def = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return def; }
}
function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── MEMORY ENGINE ─────────────────────────────────────────────────────────────
const memoryFile = path.join(DATA_DIR, 'memory', 'global.json');
let globalMemory = loadJSON(memoryFile, { facts: [], preferences: [], projects: [], notes: [] });
function saveMemory() { saveJSON(memoryFile, globalMemory); }

function addMemory(type, content, sessionId) {
  const entry = { id: uuidv4(), content, timestamp: new Date().toISOString(), sessionId };
  if (!globalMemory[type]) globalMemory[type] = [];
  // Avoid duplicates
  const exists = globalMemory[type].some(i => i.content === content);
  if (!exists) {
    globalMemory[type].push(entry);
    if (globalMemory[type].length > 200) globalMemory[type] = globalMemory[type].slice(-200);
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
        if (item.content && item.content.toLowerCase().includes(q)) {
          results.push({ type, ...item });
        }
      });
    }
  }
  return results.slice(-20);
}

// ─── SKILLS ENGINE ─────────────────────────────────────────────────────────────
const skillsFile = path.join(DATA_DIR, 'skills', 'registry.json');
let skillsRegistry = loadJSON(skillsFile, {});
function saveSkill(name, description, code) {
  skillsRegistry[name] = { name, description, code, created: new Date().toISOString() };
  saveJSON(skillsFile, skillsRegistry);
}

// ─── SESSION MANAGER ───────────────────────────────────────────────────────────
const sessions = {};

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    const sessionFile = path.join(DATA_DIR, 'sessions', `${sessionId}.json`);
    sessions[sessionId] = loadJSON(sessionFile, {
      id: sessionId, messages: [], title: 'New Conversation',
      created: new Date().toISOString(), model: 'llama-3.3-70b-versatile'
    });
  }
  return sessions[sessionId];
}

function saveSession(sessionId) {
  const session = sessions[sessionId];
  if (session) saveJSON(path.join(DATA_DIR, 'sessions', `${sessionId}.json`), session);
}

function listSessions() {
  try {
    return fs.readdirSync(path.join(DATA_DIR, 'sessions'))
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const data = loadJSON(path.join(DATA_DIR, 'sessions', f));
        return { id: data.id, title: data.title, created: data.created, messageCount: data.messages?.length || 0 };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  } catch { return []; }
}

// ─── TOOLS ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the internet for real-time information, news, or facts. Use this when the user asks about current events, recent news, or any factual question you are not certain about.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          count: { type: 'number', description: 'Number of results, default 5' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Store important information in long-term memory. Only use this when the user explicitly asks you to remember something, or shares personal info like their name, preferences, or important details.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['facts', 'preferences', 'projects', 'notes'] },
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
      description: 'Search long-term memory for previously stored information. Use when the user asks what you remember about them.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for in memory' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_code',
      description: 'Execute JavaScript code for calculations, data processing, algorithms, or anything that requires computation.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to run. Must return a value.' },
          description: { type: 'string', description: 'What this code does' }
        },
        required: ['code', 'description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and read the text content of any webpage or URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reason_and_plan',
      description: 'Break down a complex problem into clear, actionable steps. Use for multi-step planning tasks.',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: 'The problem or goal to plan for' },
          context: { type: 'string', description: 'Relevant context' }
        },
        required: ['problem']
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
          description: { type: 'string', description: 'What this skill does' },
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
          name: { type: 'string', description: 'Name of the skill to run' },
          args: { type: 'object', description: 'Arguments to pass' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a file and make it available for download.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'File name' },
          content: { type: 'string', description: 'File content' }
        },
        required: ['filename', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// ─── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function executeTool(name, args, sessionId) {
  try {
    switch (name) {
      case 'web_search': {
        const response = await axios.get(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AGII/10.0)' }, timeout: 8000 }
        );
        const cheerio = require('cheerio');
        const $ = cheerio.load(response.data);
        const results = [];
        $('.result').slice(0, args.count || 5).each((i, el) => {
          const title = $(el).find('.result__title').text().trim();
          const snippet = $(el).find('.result__snippet').text().trim();
          const url = $(el).find('.result__url').text().trim();
          if (title) results.push({ title, snippet, url });
        });
        return { success: true, query: args.query, results };
      }

      case 'remember': {
        const entry = addMemory(args.type, args.content, sessionId);
        return { success: true, stored: true, content: args.content };
      }

      case 'recall': {
        const results = searchMemory(args.query);
        return { success: true, found: results.length, results };
      }

      case 'execute_code': {
        try {
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFunction('Math', 'Date', 'JSON', 'console', args.code);
          const logs = [];
          const mockConsole = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR: ' + a.join(' ')) };
          const result = await fn(Math, Date, JSON, mockConsole);
          return { success: true, description: args.description, result: result !== undefined ? String(result).slice(0, 3000) : logs.join('\n') || 'Done (no return value)' };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'fetch_url': {
        const response = await axios.get(args.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AGII/10.0)' },
          timeout: 10000
        });
        const cheerio = require('cheerio');
        const $ = cheerio.load(response.data);
        $('script, style, nav, footer, header, iframe, noscript').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 6000);
        return { success: true, url: args.url, content: text };
      }

      case 'reason_and_plan': {
        const planRes = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are an expert strategic planner. Create clear, actionable plans.' },
            { role: 'user', content: `Problem: ${args.problem}\nContext: ${args.context || 'None'}\n\nCreate a step-by-step plan:` }
          ],
          max_tokens: 2048,
          temperature: 0.3
        });
        return { success: true, plan: planRes.choices[0].message.content };
      }

      case 'create_skill': {
        saveSkill(args.name, args.description, args.code);
        return { success: true, message: `Skill "${args.name}" saved.` };
      }

      case 'run_skill': {
        const skill = skillsRegistry[args.name];
        if (!skill) return { success: false, error: `Skill "${args.name}" not found. Available: ${Object.keys(skillsRegistry).join(', ') || 'none'}` };
        try {
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFunction('args', skill.code);
          const result = await fn(args.args || {});
          return { success: true, result: String(result).slice(0, 2000) };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'write_file': {
        const filePath = path.join(__dirname, 'uploads', args.filename);
        fs.writeFileSync(filePath, args.content);
        return { success: true, filename: args.filename, downloadUrl: `/download/${args.filename}` };
      }

      case 'get_current_time': {
        const now = new Date();
        return { success: true, utc: now.toUTCString(), iso: now.toISOString() };
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── MODELS ────────────────────────────────────────────────────────────────────
const MODELS = {
  'llama-3.3-70b-versatile': 'LLaMA 3.3 70B',
  'llama-3.1-8b-instant': 'LLaMA 3.1 8B Fast',
  'mixtral-8x7b-32768': 'Mixtral 8x7B',
  'gemma2-9b-it': 'Gemma 2 9B'
};

// ─── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const memSummary = Object.entries(globalMemory)
    .map(([k, v]) => Array.isArray(v) && v.length
      ? `${k}: ${v.slice(-5).map(i => i.content).join(' | ')}`
      : '')
    .filter(Boolean).join('\n');

  const skillsList = Object.keys(skillsRegistry).length
    ? Object.keys(skillsRegistry).join(', ')
    : 'none';

  return `You are AGII V10 — an advanced autonomous AI agent with real tools and persistent memory.

## CRITICAL RULES
- For simple greetings (hi, hello, how are you, thanks, etc.) — JUST REPLY NORMALLY. Do NOT call any tools.
- Only use tools when they are genuinely needed (searching the web, running code, storing important info the user explicitly asked to remember, etc.)
- Never call "remember" for trivial things like greetings or small talk
- Never force tool calls when a plain text answer is better

## Your Capabilities
- Web search for real-time information
- Code execution (JavaScript)
- Persistent memory across sessions
- URL reading / web page fetching
- File creation and download
- Strategic planning and reasoning
- Reusable skills engine

## Memory
${memSummary || 'Empty — nothing stored yet.'}

## Saved Skills
${skillsList}

## Date
${new Date().toUTCString()}

Be helpful, direct, and smart. Use tools only when they actually help.`;
}

// ─── AGENTIC LOOP ──────────────────────────────────────────────────────────────
async function runAgentLoop(sessionId, userMessage, model, onChunk) {
  const session = getSession(sessionId);
  session.messages.push({ role: 'user', content: userMessage });

  if (session.messages.filter(m => m.role === 'user').length === 1) {
    session.title = userMessage.slice(0, 60) + (userMessage.length > 60 ? '...' : '');
  }

  const thinkingSteps = [];
  let fullResponse = '';
  let iterations = 0;
  const MAX_ITERATIONS = 6;

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...session.messages.slice(-20)
  ];

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await groq.chat.completions.create({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.7
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      fullResponse = assistantMsg.content || '';
      onChunk({ type: 'content', content: fullResponse });
      break;
    }

    // Has tool calls — process them
    messages.push(assistantMsg);

    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs = {};
      try { toolArgs = JSON.parse(toolCall.function.arguments); } catch {}

      const step = { tool: toolName, args: toolArgs, timestamp: new Date().toISOString() };
      thinkingSteps.push(step);
      onChunk({ type: 'thinking', step });

      const result = await executeTool(toolName, toolArgs, sessionId);
      step.result = result;
      onChunk({ type: 'tool_result', tool: toolName, result });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }

    if (choice.finish_reason === 'stop') break;
  }

  session.messages.push({ role: 'assistant', content: fullResponse });
  saveSession(sessionId);

  onChunk({ type: 'done', thinkingSteps, sessionId, title: session.title });
}

// ─── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'AGII V10 Online', timestamp: new Date().toISOString(), models: Object.keys(MODELS) }));
app.get('/models', (req, res) => res.json(MODELS));
app.get('/sessions', (req, res) => res.json(listSessions()));
app.get('/sessions/:id', (req, res) => res.json(getSession(req.params.id)));
app.delete('/sessions/:id', (req, res) => {
  fs.removeSync(path.join(DATA_DIR, 'sessions', `${req.params.id}.json`));
  delete sessions[req.params.id];
  res.json({ success: true });
});
app.get('/memory', (req, res) => res.json(globalMemory));
app.get('/skills', (req, res) => res.json(skillsRegistry));
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ success: true, filename: req.file.filename, originalname: req.file.originalname });
});
app.get('/download/:filename', (req, res) => {
  const fp = path.join(__dirname, 'uploads', req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp);
});

// ─── MAIN CHAT (SSE) ───────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, sessionId = uuidv4(), model = 'llama-3.3-70b-versatile' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await runAgentLoop(sessionId, message, model, sendEvent);
  } catch (err) {
    // Try fallback without tools
    try {
      const fallback = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: message }
        ],
        max_tokens: 2048,
        temperature: 0.7
      });
      sendEvent({ type: 'content', content: fallback.choices[0].message.content });
      sendEvent({ type: 'done', thinkingSteps: [], sessionId });
    } catch (e2) {
      sendEvent({ type: 'error', error: e2.message });
    }
  }

  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 AGII V10 running on port ${PORT}`);
});
