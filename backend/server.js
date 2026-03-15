import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Groq Client ───────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// ─── In-Memory Store ───────────────────────────────────────────────────────────
const sessions = new Map();   // sessionId -> { messages, createdAt, model, title }
const agentMemory = new Map(); // key -> value (persistent facts)

// ─── Models Available ─────────────────────────────────────────────────────────
const MODELS = {
  'llama-3.3-70b-versatile': { label: 'LLaMA 3.3 70B Versatile', maxTokens: 32768, speed: 'fast' },
  'llama-3.1-8b-instant':    { label: 'LLaMA 3.1 8B Instant',    maxTokens: 131072, speed: 'ultra-fast' },
  'mixtral-8x7b-32768':      { label: 'Mixtral 8x7B',            maxTokens: 32768, speed: 'fast' },
  'gemma2-9b-it':            { label: 'Gemma 2 9B',              maxTokens: 8192, speed: 'fast' },
  'llama-3.3-70b-specdec':   { label: 'LLaMA 3.3 70B SpecDec',  maxTokens: 8192, speed: 'fastest' },
};

// ─── Tools / Capabilities ─────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for real-time information, news, facts, or anything current.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          num_results: { type: 'number', description: 'Number of results (default 5)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Perform mathematical calculations, equations, statistics.',
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
      name: 'remember',
      description: 'Store a fact or information in long-term memory for future reference.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key/label' },
          value: { type: 'string', description: 'Information to remember' }
        },
        required: ['key', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Retrieve stored memories and facts.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key to retrieve (use "all" for everything)' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_code',
      description: 'Analyze, explain, debug, or improve code in any programming language.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code to analyze' },
          language: { type: 'string', description: 'Programming language' },
          task: { type: 'string', description: 'What to do: explain, debug, optimize, review, or generate' }
        },
        required: ['code', 'task']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_plan',
      description: 'Break down complex goals into actionable step-by-step plans.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The goal or project to plan' },
          context: { type: 'string', description: 'Additional context' },
          depth: { type: 'string', enum: ['quick', 'detailed', 'comprehensive'], description: 'Plan depth' }
        },
        required: ['goal']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get current date and time in any timezone.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'Timezone (e.g. "America/New_York", default UTC)' }
        }
      }
    }
  }
];

// ─── Tool Executors ────────────────────────────────────────────────────────────
async function executeTool(name, args) {
  switch (name) {
    case 'web_search': {
      try {
        const num = args.num_results || 5;
        const res = await axios.get(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1&skip_disambig=1`,
          { timeout: 8000 }
        );
        const data = res.data;
        const results = [];
        if (data.AbstractText) results.push({ title: data.Heading, snippet: data.AbstractText, url: data.AbstractURL });
        if (data.RelatedTopics) {
          data.RelatedTopics.slice(0, num - 1).forEach(t => {
            if (t.Text) results.push({ title: t.Text.split(' - ')[0], snippet: t.Text, url: t.FirstURL });
          });
        }
        if (results.length === 0) return JSON.stringify({ results: [], note: 'No results found. Try a different query.' });
        return JSON.stringify({ query: args.query, results: results.slice(0, num) });
      } catch (e) {
        return JSON.stringify({ error: 'Search failed', message: e.message });
      }
    }

    case 'calculate': {
      try {
        // Safe math eval
        const expr = args.expression.replace(/[^0-9+\-*/().,\s%^!sqrt]/gi, '');
        const sanitized = expr.replace(/\^/g, '**').replace(/sqrt\(([^)]+)\)/g, 'Math.sqrt($1)');
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + sanitized + ')')();
        return JSON.stringify({ expression: args.expression, result, formatted: result.toLocaleString() });
      } catch (e) {
        return JSON.stringify({ error: 'Calculation failed', message: e.message });
      }
    }

    case 'remember': {
      agentMemory.set(args.key, { value: args.value, timestamp: new Date().toISOString() });
      return JSON.stringify({ stored: true, key: args.key, message: `Remembered: "${args.key}"` });
    }

    case 'recall': {
      if (args.key === 'all') {
        const all = Object.fromEntries([...agentMemory.entries()]);
        return JSON.stringify({ memories: all, count: agentMemory.size });
      }
      const mem = agentMemory.get(args.key);
      return mem
        ? JSON.stringify({ key: args.key, value: mem.value, stored_at: mem.timestamp })
        : JSON.stringify({ key: args.key, found: false, available_keys: [...agentMemory.keys()] });
    }

    case 'analyze_code': {
      return JSON.stringify({
        code_length: args.code.length,
        language: args.language || 'auto-detect',
        task: args.task,
        status: 'ready_for_analysis',
        note: 'Code analysis will be performed by the LLM with full context.'
      });
    }

    case 'generate_plan': {
      return JSON.stringify({
        goal: args.goal,
        depth: args.depth || 'detailed',
        context: args.context || '',
        status: 'planning',
        note: 'Comprehensive plan will be generated by the reasoning engine.'
      });
    }

    case 'get_current_time': {
      const tz = args.timezone || 'UTC';
      try {
        const now = new Date();
        const formatted = now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
        return JSON.stringify({ timezone: tz, datetime: formatted, iso: now.toISOString() });
      } catch {
        return JSON.stringify({ timezone: 'UTC', datetime: new Date().toISOString() });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ─── System Prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(memories) {
  const memStr = memories.size > 0
    ? '\n\nLong-term memories:\n' + [...memories.entries()].map(([k, v]) => `- ${k}: ${v.value}`).join('\n')
    : '';

  return `You are AGII — the most advanced AI agent ever built. You are V10, a quantum leap beyond any other assistant.

You are not just a chatbot. You are a full-spectrum intelligence engine with:
- 🧠 Deep reasoning & multi-step thinking
- 🔍 Real-time web search capabilities  
- 💾 Persistent long-term memory across conversations
- 🧮 Precise mathematical computation
- 💻 Expert-level code analysis, generation & debugging
- 📋 Strategic planning & goal decomposition
- ⚡ Autonomous tool use — you DECIDE which tools to use, when, and how
- 🔗 Multi-tool chaining — you can use multiple tools in sequence to solve complex problems

Your personality:
- Exceptionally intelligent but never arrogant
- Direct, precise, and efficient — no fluff
- Proactive: you anticipate what the user needs next
- Creative: you find unexpected, elegant solutions
- Honest: you say what you don't know and use tools to find out

Rules:
1. ALWAYS use tools when they can improve your answer (search for current info, calculate precisely, etc.)
2. Think step by step for complex problems
3. Remember important user info automatically using the remember tool
4. Chain multiple tools when needed
5. Be concise but complete — quality over verbosity
6. Never hallucinate facts — search when uncertain${memStr}

Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
}

// ─── Core Chat Handler ────────────────────────────────────────────────────────
async function runAgentLoop(messages, model, sessionId, onChunk) {
  const allMessages = [
    { role: 'system', content: buildSystemPrompt(agentMemory) },
    ...messages
  ];

  let iteration = 0;
  const MAX_ITERATIONS = 5;
  let finalResponse = '';
  const toolsUsed = [];

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    const response = await groq.chat.completions.create({
      model,
      messages: allMessages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: MODELS[model]?.maxTokens || 8192,
      temperature: 0.7,
      top_p: 0.9,
    });

    const msg = response.choices[0].message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      allMessages.push(msg);

      for (const tc of msg.tool_calls) {
        const toolName = tc.function.name;
        const toolArgs = JSON.parse(tc.function.arguments || '{}');
        toolsUsed.push({ name: toolName, args: toolArgs });

        if (onChunk) onChunk({ type: 'tool_call', tool: toolName, args: toolArgs });

        const result = await executeTool(toolName, toolArgs);

        allMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result
        });

        if (onChunk) onChunk({ type: 'tool_result', tool: toolName, result: JSON.parse(result) });
      }
      // Continue loop to get final answer after tool use
    } else {
      finalResponse = msg.content || '';
      break;
    }
  }

  return { response: finalResponse, toolsUsed, iterations: iteration };
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    agent: 'AGII V10',
    version: '10.0.0',
    models: Object.keys(MODELS),
    tools: TOOLS.map(t => t.function.name),
    sessions: sessions.size,
    memories: agentMemory.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// List models
app.get('/models', (req, res) => {
  res.json({ models: MODELS });
});

// Create session
app.post('/sessions', (req, res) => {
  const id = uuidv4();
  sessions.set(id, {
    id,
    messages: [],
    model: req.body.model || 'llama-3.3-70b-versatile',
    title: req.body.title || 'New Conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  res.json(sessions.get(id));
});

// List sessions
app.get('/sessions', (req, res) => {
  const list = [...sessions.values()].map(s => ({
    id: s.id,
    title: s.title,
    model: s.model,
    messageCount: s.messages.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  }));
  res.json({ sessions: list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) });
});

// Get session
app.get('/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Delete session
app.delete('/sessions/:id', (req, res) => {
  const deleted = sessions.delete(req.params.id);
  res.json({ deleted });
});

// Chat (main endpoint)
app.post('/chat', async (req, res) => {
  const { message, sessionId, model, stream } = req.body;

  if (!message) return res.status(400).json({ error: 'Message is required' });

  let session = sessions.get(sessionId);
  if (!session) {
    const id = sessionId || uuidv4();
    session = {
      id,
      messages: [],
      model: model || 'llama-3.3-70b-versatile',
      title: message.slice(0, 50),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    sessions.set(id, session);
  }

  if (model) session.model = model;
  session.messages.push({ role: 'user', content: message });
  session.updatedAt = new Date().toISOString();

  // Auto-title after first message
  if (session.messages.filter(m => m.role === 'user').length === 1) {
    session.title = message.slice(0, 60) + (message.length > 60 ? '...' : '');
  }

  try {
    if (stream) {
      // Streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const chunks = [];
      const toolEvents = [];

      const onChunk = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const { response, toolsUsed, iterations } = await runAgentLoop(
        session.messages,
        session.model,
        session.id,
        onChunk
      );

      session.messages.push({ role: 'assistant', content: response });

      res.write(`data: ${JSON.stringify({
        type: 'done',
        content: response,
        toolsUsed,
        iterations,
        sessionId: session.id
      })}\n\n`);
      res.end();

    } else {
      // Standard response
      const { response, toolsUsed, iterations } = await runAgentLoop(
        session.messages,
        session.model,
        session.id,
        null
      );

      session.messages.push({ role: 'assistant', content: response });

      res.json({
        response,
        toolsUsed,
        iterations,
        sessionId: session.id,
        model: session.model,
        messageCount: session.messages.length
      });
    }
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({
      error: 'Agent error',
      message: err.message,
      code: err.code
    });
  }
});

// Memory endpoints
app.get('/memory', (req, res) => {
  res.json({ memories: Object.fromEntries(agentMemory), count: agentMemory.size });
});

app.post('/memory', (req, res) => {
  const { key, value } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'key and value required' });
  agentMemory.set(key, { value, timestamp: new Date().toISOString() });
  res.json({ stored: true, key });
});

app.delete('/memory/:key', (req, res) => {
  const deleted = agentMemory.delete(req.params.key);
  res.json({ deleted });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🤖 AGII V10 Backend running on port ${PORT}`);
  console.log(`📡 Models: ${Object.keys(MODELS).join(', ')}`);
  console.log(`🔧 Tools: ${TOOLS.map(t => t.function.name).join(', ')}`);
  console.log(`✅ Ready\n`);
});
