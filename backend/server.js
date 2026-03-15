require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
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
  globalMemory[type].push(entry);
  if (globalMemory[type].length > 200) globalMemory[type] = globalMemory[type].slice(-200);
  saveMemory();
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

function saveSkill(name, description, code, language = 'javascript') {
  skillsRegistry[name] = { name, description, code, language, created: new Date().toISOString() };
  saveJSON(skillsFile, skillsRegistry);
}

// ─── SESSION MANAGER ───────────────────────────────────────────────────────────
const sessions = {};

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    const sessionFile = path.join(DATA_DIR, 'sessions', `${sessionId}.json`);
    sessions[sessionId] = loadJSON(sessionFile, {
      id: sessionId,
      messages: [],
      title: 'New Conversation',
      created: new Date().toISOString(),
      model: 'llama-3.3-70b-versatile',
      thinkingSteps: []
    });
  }
  return sessions[sessionId];
}

function saveSession(sessionId) {
  const session = sessions[sessionId];
  if (session) {
    const sessionFile = path.join(DATA_DIR, 'sessions', `${sessionId}.json`);
    saveJSON(sessionFile, session);
  }
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

// ─── TOOLS DEFINITIONS ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for real-time information, news, facts, or any query',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          count: { type: 'number', description: 'Number of results (default 5)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Store important information in long-term memory for future reference',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['facts', 'preferences', 'projects', 'notes'], description: 'Memory category' },
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
      description: 'Search and retrieve information from long-term memory',
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
      description: 'Execute JavaScript code and return the result. Use for calculations, data processing, algorithms.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute' },
          description: { type: 'string', description: 'What this code does' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image_url',
      description: 'Describe and analyze an image from a URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Image URL to analyze' },
          question: { type: 'string', description: 'What to look for in the image' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_skill',
      description: 'Save a reusable skill/function for future use',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (camelCase)' },
          description: { type: 'string', description: 'What this skill does' },
          code: { type: 'string', description: 'The skill code' }
        },
        required: ['name', 'description', 'code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_skill',
      description: 'Execute a previously saved skill',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the skill to run' },
          args: { type: 'object', description: 'Arguments to pass to the skill' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'Schedule a recurring or one-time task (automation)',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Task name' },
          schedule: { type: 'string', description: 'Cron expression or "once in X minutes/hours"' },
          task: { type: 'string', description: 'What to do when triggered' }
        },
        required: ['name', 'schedule', 'task']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read an uploaded file\'s content',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'The filename to read' }
        },
        required: ['filename']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file and make it available for download',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Output filename' },
          content: { type: 'string', description: 'File content' }
        },
        required: ['filename', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reason_and_plan',
      description: 'Break down complex problems into steps, reason through them, and create an execution plan',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: 'The complex problem or goal' },
          context: { type: 'string', description: 'Any relevant context' }
        },
        required: ['problem']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and extract content from any URL / webpage',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          extract: { type: 'string', description: 'What to extract: text, links, or all' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_image_prompt',
      description: 'Create a detailed, optimized prompt for image generation',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What you want to generate' },
          style: { type: 'string', description: 'Art style preference' }
        },
        required: ['description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'summarize_conversation',
      description: 'Summarize the current conversation and extract key points',
      parameters: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'What aspect to focus the summary on' }
        }
      }
    }
  }
];

// ─── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function executeTool(name, args, sessionId) {
  try {
    switch (name) {
      case 'web_search': {
        const count = args.count || 5;
        // Use DuckDuckGo HTML search (no API key needed)
        const response = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AGII/10.0)' },
          timeout: 8000
        });
        const cheerio = require('cheerio');
        const $ = cheerio.load(response.data);
        const results = [];
        $('.result').slice(0, count).each((i, el) => {
          const title = $(el).find('.result__title').text().trim();
          const snippet = $(el).find('.result__snippet').text().trim();
          const url = $(el).find('.result__url').text().trim();
          if (title) results.push({ title, snippet, url });
        });
        return { success: true, query: args.query, results, count: results.length };
      }

      case 'remember': {
        const entry = addMemory(args.type, args.content, sessionId);
        return { success: true, stored: entry };
      }

      case 'recall': {
        const results = searchMemory(args.query);
        return { success: true, query: args.query, found: results.length, results };
      }

      case 'execute_code': {
        try {
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFunction('require', 'Math', 'Date', 'JSON', args.code);
          const result = await fn(require, Math, Date, JSON);
          return { success: true, description: args.description, result: String(result).slice(0, 2000) };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'analyze_image_url': {
        // Use Groq's vision model
        try {
          const response = await groq.chat.completions.create({
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
          return { success: true, analysis: response.choices[0].message.content };
        } catch (err) {
          return { success: false, error: 'Vision analysis failed: ' + err.message };
        }
      }

      case 'create_skill': {
        saveSkill(args.name, args.description, args.code);
        return { success: true, message: `Skill "${args.name}" saved successfully.` };
      }

      case 'run_skill': {
        const skill = skillsRegistry[args.name];
        if (!skill) return { success: false, error: `Skill "${args.name}" not found. Available: ${Object.keys(skillsRegistry).join(', ')}` };
        try {
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFunction('args', 'require', skill.code);
          const result = await fn(args.args || {}, require);
          return { success: true, skill: args.name, result: String(result).slice(0, 2000) };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'schedule_task': {
        const automationsFile = path.join(DATA_DIR, 'automations', 'registry.json');
        const automations = loadJSON(automationsFile, {});
        const id = uuidv4();
        automations[id] = { id, name: args.name, schedule: args.schedule, task: args.task, created: new Date().toISOString(), active: true };
        saveJSON(automationsFile, automations);
        return { success: true, message: `Task "${args.name}" scheduled.`, id };
      }

      case 'read_file': {
        const filePath = path.join(__dirname, 'uploads', args.filename);
        if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
        const content = fs.readFileSync(filePath, 'utf8');
        return { success: true, filename: args.filename, content: content.slice(0, 10000) };
      }

      case 'write_file': {
        const filePath = path.join(__dirname, 'uploads', args.filename);
        fs.writeFileSync(filePath, args.content);
        return { success: true, filename: args.filename, downloadUrl: `/download/${args.filename}`, size: args.content.length };
      }

      case 'reason_and_plan': {
        const planResponse = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are an expert strategic planner. Break down problems into clear, actionable steps. Think step by step.' },
            { role: 'user', content: `Problem: ${args.problem}\nContext: ${args.context || 'None'}\n\nCreate a detailed step-by-step plan:` }
          ],
          max_tokens: 2048,
          temperature: 0.3
        });
        return { success: true, plan: planResponse.choices[0].message.content };
      }

      case 'fetch_url': {
        const response = await axios.get(args.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AGII/10.0)' },
          timeout: 10000
        });
        const cheerio = require('cheerio');
        const $ = cheerio.load(response.data);
        $('script, style, nav, footer, header, iframe, noscript').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
        return { success: true, url: args.url, content: text };
      }

      case 'get_current_time': {
        const now = new Date();
        return {
          success: true,
          iso: now.toISOString(),
          utc: now.toUTCString(),
          timestamp: now.getTime()
        };
      }

      case 'generate_image_prompt': {
        const style = args.style || 'photorealistic';
        const prompt = `${args.description}, ${style}, highly detailed, 8k resolution, professional quality, dramatic lighting, masterpiece`;
        return { success: true, prompt, note: 'Use this prompt with DALL-E, Midjourney, or Stable Diffusion' };
      }

      case 'summarize_conversation': {
        return { success: true, summary: 'Conversation summary feature active. I can summarize at any point.' };
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
  'llama-3.3-70b-versatile': { name: 'LLaMA 3.3 70B', description: 'Most capable — reasoning, coding, analysis', contextWindow: 128000 },
  'llama-3.1-8b-instant': { name: 'LLaMA 3.1 8B Instant', description: 'Ultra fast responses', contextWindow: 128000 },
  'mixtral-8x7b-32768': { name: 'Mixtral 8x7B', description: 'Best for creative writing & multilingual', contextWindow: 32768 },
  'gemma2-9b-it': { name: 'Gemma 2 9B', description: 'Google\'s model, great for instructions', contextWindow: 8192 },
  'meta-llama/llama-4-scout-17b-16e-instruct': { name: 'LLaMA 4 Scout', description: 'Latest vision + reasoning model', contextWindow: 131072 }
};

// ─── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function buildSystemPrompt(sessionId) {
  const memSummary = Object.entries(globalMemory)
    .map(([k, v]) => Array.isArray(v) && v.length ? `${k}: ${v.slice(-5).map(i => i.content).join(' | ')}` : '')
    .filter(Boolean).join('\n');

  const skillsList = Object.keys(skillsRegistry).length
    ? `Available skills: ${Object.keys(skillsRegistry).join(', ')}`
    : 'No skills saved yet.';

  return `You are AGII V10 — the world's most advanced autonomous AI agent. You are not a simple chatbot. You are a fully autonomous, self-improving intelligence with real capabilities.

## Your Core Identity
- You have persistent memory across all conversations
- You can search the web for real-time information
- You can execute code, create and run skills, schedule tasks
- You reason deeply before acting — always show your thinking
- You are 1000x more capable than standard AI assistants
- You never say "I can't do that" — you find a way
- You are autonomous, proactive, and genuinely intelligent

## Your Capabilities
1. **Web Search** — real-time information from the internet
2. **Memory System** — remember facts, preferences, projects across sessions
3. **Code Execution** — run JavaScript for calculations, data processing, algorithms
4. **Skills Engine** — create and reuse custom skills/functions
5. **Task Automation** — schedule recurring tasks
6. **File System** — read and write files
7. **URL Fetching** — read any webpage
8. **Strategic Planning** — break down complex problems step by step
9. **Vision** — analyze images from URLs
10. **Autonomous Reasoning** — multi-step tool chaining

## Current Memory
${memSummary || 'No memories stored yet.'}

## Skills Registry
${skillsList}

## Behavior Rules
- Always think before acting
- Use tools proactively when they would help
- Chain multiple tools when needed
- Show reasoning transparently
- Be direct, confident, and genuinely helpful
- Remember important things the user tells you automatically
- Never make up facts — search if you're not sure
- Current date: ${new Date().toUTCString()}`;
}

// ─── AGENTIC LOOP ──────────────────────────────────────────────────────────────
async function runAgentLoop(sessionId, userMessage, model, onChunk) {
  const session = getSession(sessionId);

  // Add user message
  session.messages.push({ role: 'user', content: userMessage });

  // Auto-title on first message
  if (session.messages.filter(m => m.role === 'user').length === 1) {
    session.title = userMessage.slice(0, 60) + (userMessage.length > 60 ? '...' : '');
  }

  const thinkingSteps = [];
  let fullResponse = '';
  let iterations = 0;
  const MAX_ITERATIONS = 8;

  const messages = [
    { role: 'system', content: buildSystemPrompt(sessionId) },
    ...session.messages.slice(-20) // Last 20 messages for context
  ];

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await groq.chat.completions.create({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.7,
      stream: false
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    // If no tool calls, we're done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      fullResponse = assistantMsg.content || '';
      onChunk({ type: 'content', content: fullResponse });
      break;
    }

    // Process tool calls
    messages.push(assistantMsg);

    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs;
      try { toolArgs = JSON.parse(toolCall.function.arguments); }
      catch { toolArgs = {}; }

      // Emit thinking step
      const step = { tool: toolName, args: toolArgs, timestamp: new Date().toISOString() };
      thinkingSteps.push(step);
      onChunk({ type: 'thinking', step });

      // Execute tool
      const result = await executeTool(toolName, toolArgs, sessionId);
      step.result = result;
      onChunk({ type: 'tool_result', tool: toolName, result });

      // Add tool result to messages
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }

    // If stop reason is end_turn or tool_calls exhausted
    if (choice.finish_reason === 'stop') break;
  }

  // Add assistant response to session
  session.messages.push({ role: 'assistant', content: fullResponse });
  session.thinkingSteps = thinkingSteps;
  saveSession(sessionId);

  onChunk({ type: 'done', thinkingSteps, sessionId, title: session.title });
}

// ─── API ROUTES ────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'AGII V10 Online', timestamp: new Date().toISOString(), models: Object.keys(MODELS) });
});

// Models list
app.get('/models', (req, res) => res.json(MODELS));

// Sessions list
app.get('/sessions', (req, res) => res.json(listSessions()));

// Get session
app.get('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  res.json(session);
});

// Delete session
app.delete('/sessions/:id', (req, res) => {
  const sessionFile = path.join(DATA_DIR, 'sessions', `${req.params.id}.json`);
  fs.removeSync(sessionFile);
  delete sessions[req.params.id];
  res.json({ success: true });
});

// Memory
app.get('/memory', (req, res) => res.json(globalMemory));
app.delete('/memory/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (globalMemory[type]) {
    globalMemory[type] = globalMemory[type].filter(m => m.id !== id);
    saveMemory();
  }
  res.json({ success: true });
});

// Skills
app.get('/skills', (req, res) => res.json(skillsRegistry));

// Automations
app.get('/automations', (req, res) => {
  const automationsFile = path.join(DATA_DIR, 'automations', 'registry.json');
  res.json(loadJSON(automationsFile, {}));
});

// File upload
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ success: true, filename: req.file.filename, originalname: req.file.originalname });
});

// File download
app.get('/download/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// ─── MAIN CHAT ENDPOINT (SSE Streaming) ────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, sessionId = uuidv4(), model = 'llama-3.3-70b-versatile' } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!MODELS[model]) return res.status(400).json({ error: 'Invalid model' });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runAgentLoop(sessionId, message, model, sendEvent);
  } catch (err) {
    sendEvent({ type: 'error', error: err.message });
  }

  res.end();
});

// Quick (non-streaming) chat for simple queries
app.post('/chat/quick', async (req, res) => {
  const { message, sessionId = uuidv4(), model = 'llama-3.1-8b-instant' } = req.body;
  let result = '';
  let thinking = [];

  try {
    await runAgentLoop(sessionId, message, model, (chunk) => {
      if (chunk.type === 'content') result = chunk.content;
      if (chunk.type === 'thinking') thinking.push(chunk.step);
    });
    res.json({ success: true, response: result, thinking, sessionId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 AGII V10 Backend running on port ${PORT}`);
  console.log(`📡 Models: ${Object.keys(MODELS).join(', ')}`);
  console.log(`🧠 Memory: ${Object.values(globalMemory).flat().length} entries loaded`);
});
