# 🤖 AGII V10 — Advanced AI Agent

> The most advanced AI agent ever built. V10 is a quantum leap beyond any other assistant.

## ✨ Features

- 🧠 **Multi-model support** — LLaMA 3.3 70B, Mixtral, Gemma 2, and more via Groq
- 🔍 **Real-time web search** — DuckDuckGo integration for live information
- 💾 **Persistent memory** — Remember facts and recall them across conversations  
- 🧮 **Precise calculations** — Complex math, equations, statistics
- 💻 **Code expert** — Write, analyze, debug, optimize any language
- 📋 **Strategic planning** — Break down any goal into actionable steps
- ⚡ **Autonomous tool use** — Decides which tools to use automatically
- 🔗 **Multi-tool chaining** — Chains multiple tools for complex problems
- 📡 **Streaming responses** — Real-time token streaming
- 💬 **Session management** — Multiple conversations, all persisted

## 🚀 Deployment

### Backend (Render)
1. Connect this GitHub repo to Render
2. Create a new **Web Service** pointing to `/backend`
3. Add env variable: `GROQ_API_KEY=your_key`
4. Deploy!

### Frontend (Render Static Site)
1. Create a new **Static Site** pointing to `/frontend`
2. Set `AGII_BACKEND_URL` in the HTML to your backend URL
3. Deploy!

### Quick Deploy
Use the `render.yaml` for instant deployment:
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

## 🔧 Local Development

```bash
# Backend
cd backend
cp .env.example .env
# Add your GROQ_API_KEY to .env
npm install
npm run dev

# Frontend - just open index.html in browser
# Or: npx serve frontend
```

## 📡 API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Agent status |
| `/models` | GET | Available models |
| `/sessions` | GET/POST | List/create sessions |
| `/sessions/:id` | GET/DELETE | Get/delete session |
| `/chat` | POST | Send message |
| `/memory` | GET/POST | Memory operations |
| `/memory/:key` | DELETE | Delete memory |

### Chat Request
```json
{
  "message": "Your message",
  "sessionId": "optional-session-id",
  "model": "llama-3.3-70b-versatile",
  "stream": true
}
```

## 🧰 Tools

| Tool | Description |
|------|-------------|
| `web_search` | Real-time web search |
| `calculate` | Math & equations |
| `remember` | Store to memory |
| `recall` | Retrieve from memory |
| `analyze_code` | Code analysis |
| `generate_plan` | Strategic planning |
| `get_current_time` | Time in any timezone |

## 🏗️ Architecture

```
AGII V10
├── backend/          # Node.js + Express + Groq SDK
│   ├── server.js     # Main server with agent loop
│   └── package.json
├── frontend/         # Pure HTML/CSS/JS
│   └── index.html    # Single-file app
├── render.yaml       # Render deployment config
└── README.md
```

Built with ❤️ using Groq API for ultra-fast inference.
