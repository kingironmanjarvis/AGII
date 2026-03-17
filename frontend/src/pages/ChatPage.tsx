import { useState, useEffect, useRef, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'https://agii-v10-backend.onrender.com'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  tools?: ToolCall[]
  domain?: string
}

interface ToolCall {
  name: string
  args: Record<string, unknown>
  result?: Record<string, unknown>
  success?: boolean
}

interface Session {
  id: string
  title: string
  created: string
  messageCount: number
}

const DOMAIN_ICONS: Record<string, string> = {
  search: '🔍', run_code: '⚡', build_app: '🏗️', analyze: '🔬',
  remember: '💾', recall: '🧠', write_file: '📄', calculate: '🧮',
  self_improve: '🔧', get_time: '🕐', read_file: '📖', list_files: '📂'
}

const DOMAIN_COLORS: Record<string, string> = {
  search: '#22dd88', run_code: '#ffcc44', build_app: '#7c6aff',
  analyze: '#60a5fa', remember: '#f472b6', recall: '#a78bfa',
  write_file: '#34d399', calculate: '#fb923c', self_improve: '#ff5566'
}

const SUGGESTIONS = [
  { icon: '⚡', text: 'Build a React dashboard with live charts', domain: 'code' },
  { icon: '🔬', text: 'Explain quantum entanglement mathematically', domain: 'science' },
  { icon: '🚀', text: 'Calculate orbital mechanics for a Mars mission', domain: 'aerospace' },
  { icon: '🧬', text: 'Analyze CRISPR-Cas9 gene editing mechanism', domain: 'biology' },
  { icon: '📊', text: 'Build a Python data analysis pipeline', domain: 'code' },
  { icon: '🌐', text: 'Search for latest AI breakthroughs today', domain: 'search' },
]

function ToolBadge({ tool, result }: { tool: ToolCall; result?: boolean }) {
  const icon = DOMAIN_ICONS[tool.name] || '⚙️'
  const color = DOMAIN_COLORS[tool.name] || '#8888aa'
  const isRunning = result === undefined
  return (
    <div className="tool-card" style={{ borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ color, fontWeight: 600, fontSize: 13 }}>{tool.name}</span>
        {isRunning ? (
          <span style={{ marginLeft: 'auto', color: '#ffcc44', fontSize: 12 }}>
            <span className="animate-pulse-glow">● running</span>
          </span>
        ) : (
          <span style={{ marginLeft: 'auto', color: result !== false ? '#22dd88' : '#ff5566', fontSize: 12 }}>
            {result !== false ? '✓ done' : '✗ failed'}
          </span>
        )}
      </div>
      {tool.args && Object.keys(tool.args).length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono, monospace' }}>
          {Object.entries(tool.args).slice(0,2).map(([k,v]) => (
            <span key={k} style={{ marginRight: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>{k}:</span>{' '}
              <span>{String(v).slice(0,80)}</span>
            </span>
          ))}
        </div>
      )}
      {tool.result && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
          {tool.name === 'search' && tool.result.results && (
            <div>{(tool.result.results as {title:string}[]).slice(0,3).map((r,i) => <div key={i}>· {r.title?.slice(0,60)}</div>)}</div>
          )}
          {tool.name === 'run_code' && (
            <div style={{ color: '#22dd88' }}>{String(tool.result.output || '').slice(0,200)}</div>
          )}
          {tool.name === 'build_app' && (
            <div style={{ color: '#7c6aff' }}>{String(tool.result.message || '')}</div>
          )}
          {['remember','recall','calculate','get_time'].includes(tool.name) && (
            <div>{JSON.stringify(tool.result).slice(0,120)}</div>
          )}
        </div>
      )}
    </div>
  )
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```|`[^`]+`)/g)
  return (
    <div style={{ lineHeight: 1.7, fontSize: 15 }}>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const lines = part.slice(3, -3).split('\n')
          const lang = lines[0].trim()
          const code = lines.slice(1).join('\n')
          return (
            <pre key={i} style={{ position: 'relative' }}>
              {lang && <span style={{ position: 'absolute', top: 8, right: 12, fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{lang}</span>}
              <code>{code || lines.join('\n')}</code>
            </pre>
          )
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={i}>{part.slice(1,-1)}</code>
        }
        return <span key={i} dangerouslySetInnerHTML={{ __html: part
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/^### (.+)$/gm, '<h3 style="color:var(--accent-bright);margin:16px 0 8px;font-size:16px">$1</h3>')
          .replace(/^## (.+)$/gm, '<h2 style="color:var(--text-primary);margin:20px 0 10px;font-size:18px">$1</h2>')
          .replace(/^# (.+)$/gm, '<h1 style="color:var(--text-primary);margin:24px 0 12px;font-size:22px">$1</h1>')
          .replace(/^[\-\*] (.+)$/gm, '<div style="padding:2px 0 2px 16px;color:var(--text-secondary)">· $1</div>')
          .replace(/\n\n/g, '<br/><br/>')
          .replace(/\n/g, '<br/>')
        }} />
      })}
    </div>
  )
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [activeTools, setActiveTools] = useState<Map<string, ToolCall>>(new Map())
  const [streamingMsg, setStreamingMsg] = useState('')
  const [tab, setTab] = useState<'chat'|'files'|'memory'>('chat')
  const [files, setFiles] = useState<{name:string,size:number,modified:string}[]>([])
  const [memory, setMemory] = useState<{memories:Record<string,{content:string}>,improvementCount:number,systemVersion:number}>({memories:{},improvementCount:0,systemVersion:1})
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const msgIdCounter = useRef(0)

  const newId = () => `msg_${++msgIdCounter.current}_${Date.now()}`

  useEffect(() => { loadSessions() }, [])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, streamingMsg])

  async function loadSessions() {
    try {
      const r = await fetch(`${API}/api/sessions`)
      const data = await r.json()
      setSessions(Array.isArray(data) ? data : [])
    } catch {}
  }

  async function loadSession(id: string) {
    try {
      const r = await fetch(`${API}/api/sessions/${id}`)
      const data = await r.json()
      setCurrentSessionId(id)
      setMessages(data.messages?.map((m: Message) => ({ ...m, id: newId() })) || [])
    } catch {}
  }

  async function loadFiles() {
    try {
      const r = await fetch(`${API}/api/files`)
      setFiles(await r.json())
    } catch {}
  }

  async function loadMemory() {
    try {
      const r = await fetch(`${API}/api/memory`)
      setMemory(await r.json())
    } catch {}
  }

  function newChat() {
    setCurrentSessionId('')
    setMessages([])
    setStreamingMsg('')
    setActiveTools(new Map())
    setInput('')
    inputRef.current?.focus()
  }

  async function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    await fetch(`${API}/api/sessions/${id}`, { method: 'DELETE' })
    if (id === currentSessionId) newChat()
    loadSessions()
  }

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return
    const userMsg = input.trim()
    setInput('')
    setStreaming(true)
    setStreamingMsg('')
    setActiveTools(new Map())

    const sessionId = currentSessionId || `s_${Date.now()}`
    if (!currentSessionId) setCurrentSessionId(sessionId)

    const userMessage: Message = { id: newId(), role: 'user', content: userMsg, timestamp: new Date().toISOString() }
    setMessages(prev => [...prev, userMessage])

    const toolsForMsg: ToolCall[] = []
    let fullResponse = ''

    try {
      const resp = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, sessionId })
      })

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'tool_start') {
              const tc: ToolCall = { name: event.tool, args: event.args || {} }
              toolsForMsg.push(tc)
              setActiveTools(prev => new Map(prev).set(event.tool + toolsForMsg.length, tc))
            } else if (event.type === 'tool_result') {
              const idx = toolsForMsg.findIndex(t => t.name === event.tool && !t.result)
              if (idx >= 0) {
                toolsForMsg[idx] = { ...toolsForMsg[idx], result: event.result, success: event.success }
                setActiveTools(prev => {
                  const m = new Map(prev)
                  const key = event.tool + (idx + 1)
                  m.set(key, toolsForMsg[idx])
                  return m
                })
              }
            } else if (event.type === 'token') {
              fullResponse += event.text
              setStreamingMsg(fullResponse)
            } else if (event.type === 'done') {
              setStreamingMsg('')
              const aiMsg: Message = { id: newId(), role: 'assistant', content: fullResponse, timestamp: new Date().toISOString(), tools: toolsForMsg.length ? [...toolsForMsg] : undefined }
              setMessages(prev => [...prev, aiMsg])
              loadSessions()
            } else if (event.type === 'error') {
              setStreamingMsg('')
              const errMsg: Message = { id: newId(), role: 'assistant', content: `⚠️ Error: ${event.message}`, timestamp: new Date().toISOString() }
              setMessages(prev => [...prev, errMsg])
            }
          } catch {}
        }
      }
    } catch (e) {
      const errMsg: Message = { id: newId(), role: 'assistant', content: `⚠️ Connection error. Make sure the backend is running.`, timestamp: new Date().toISOString() }
      setMessages(prev => [...prev, errMsg])
    }
    setActiveTools(new Map())
    setStreaming(false)
  }, [input, streaming, currentSessionId])

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const isEmpty = messages.length === 0 && !streamingMsg

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--bg-primary)', overflow: 'hidden' }}>

      {/* SIDEBAR */}
      <div style={{
        width: sidebarOpen ? 280 : 0,
        minWidth: sidebarOpen ? 280 : 0,
        transition: 'all 0.3s cubic-bezier(0.4,0,0.2,1)',
        overflow: 'hidden',
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        flexShrink: 0
      }}>
        <div style={{ padding: '20px 16px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: 'linear-gradient(135deg, var(--accent), #60a5fa)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, flexShrink: 0
            }}>⚡</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.3px' }}>NEXUS</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Self-Optimizing AI Agent</div>
            </div>
          </div>
          <button onClick={newChat} style={{
            width: '100%', padding: '10px 14px', borderRadius: 8,
            background: 'linear-gradient(135deg, var(--accent), #5b4fdd)',
            color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600,
            fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
            justifyContent: 'center', transition: 'opacity 0.15s'
          }}>
            <span style={{ fontSize: 16 }}>+</span> New Chat
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', padding: '8px 12px', gap: 4, borderBottom: '1px solid var(--border)' }}>
          {(['chat','files','memory'] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); if(t==='files') loadFiles(); if(t==='memory') loadMemory(); }} style={{
              flex: 1, padding: '6px 0', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: tab === t ? 'var(--bg-elevated)' : 'transparent',
              color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)',
              fontSize: 12, fontWeight: 500, transition: 'all 0.15s',
              textTransform: 'capitalize'
            }}>{t}</button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
          {tab === 'chat' && (
            <>
              {sessions.length === 0 && (
                <div style={{ padding: '20px 8px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                  No conversations yet.<br/>Start a new chat!
                </div>
              )}
              {sessions.map(s => (
                <div key={s.id} className={`sidebar-item ${s.id === currentSessionId ? 'active' : ''}`}
                  onClick={() => loadSession(s.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
                  <span style={{ fontSize: 14, flexShrink: 0 }}>💬</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.messageCount} messages</div>
                  </div>
                  <button onClick={(e) => deleteSession(s.id, e)} style={{
                    background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                    padding: 4, borderRadius: 4, fontSize: 14, flexShrink: 0, opacity: 0,
                    transition: 'opacity 0.15s'
                  }} className="delete-btn">✕</button>
                </div>
              ))}
            </>
          )}
          {tab === 'files' && (
            <div>
              {files.length === 0 ? (
                <div style={{ padding: '20px 8px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>No files yet.<br/>Ask NEXUS to create one!</div>
              ) : files.map(f => (
                <div key={f.name} className="sidebar-item" style={{ marginBottom: 2 }}
                  onClick={() => window.open(`${API}/api/files/${f.name}`)}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>📄 {f.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{(f.size/1024).toFixed(1)}KB</div>
                </div>
              ))}
            </div>
          )}
          {tab === 'memory' && (
            <div>
              <div style={{ padding: '8px 8px 4px', fontSize: 11, color: 'var(--text-muted)' }}>
                System v{memory.systemVersion} · {memory.improvementCount} improvements
              </div>
              {Object.entries(memory.memories || {}).length === 0 ? (
                <div style={{ padding: '20px 8px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>No memories yet.</div>
              ) : Object.entries(memory.memories || {}).map(([k, v]) => (
                <div key={k} className="sidebar-item" style={{ marginBottom: 2 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-bright)' }}>🧠 {k}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{v.content?.slice(0,80)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#22dd88' }}>● Tavily</span>
            <span style={{ color: '#22dd88' }}>● E2B</span>
            <span style={{ color: '#22dd88' }}>● Together</span>
            <span style={{ color: '#22dd88' }}>● Groq</span>
          </div>
        </div>
      </div>

      {/* MAIN AREA */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>

        {/* HEADER */}
        <div style={{
          padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)',
          flexShrink: 0
        }}>
          <button onClick={() => setSidebarOpen(o => !o)} style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', borderRadius: 8, padding: '6px 10px',
            cursor: 'pointer', fontSize: 16, transition: 'all 0.15s', flexShrink: 0
          }}>
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }} className="gradient-text">
              {messages.length > 0
                ? sessions.find(s => s.id === currentSessionId)?.title || 'NEXUS'
                : 'NEXUS — Advanced AI Agent'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {streaming ? '⚡ Working...' : `${TOOLS.length} tools · Multi-model · Self-optimizing`}
            </div>
          </div>
          {streaming && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ffcc44', fontSize: 12 }}>
              <div className="animate-spin" style={{ width: 14, height: 14, border: '2px solid #ffcc44', borderTopColor: 'transparent', borderRadius: '50%' }} />
              Processing
            </div>
          )}
        </div>

        {/* MESSAGES */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px' }}>
          {isEmpty && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center' }}>
              <div style={{
                width: 72, height: 72, borderRadius: 20,
                background: 'linear-gradient(135deg, var(--accent), #60a5fa)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 36, marginBottom: 24,
                boxShadow: '0 0 40px var(--accent-glow)'
              }}>⚡</div>
              <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px' }} className="gradient-text">NEXUS</h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: 16, margin: '0 0 40px', maxWidth: 480 }}>
                The most advanced self-optimizing AI agent. Real web search, code execution, app building, expert analysis across every domain.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, maxWidth: 600, width: '100%' }}>
                {SUGGESTIONS.map((s, i) => (
                  <button key={i} onClick={() => { setInput(s.text); inputRef.current?.focus() }} style={{
                    padding: '14px 16px', borderRadius: 12, textAlign: 'left',
                    background: 'var(--bg-surface)', border: '1px solid var(--border)',
                    cursor: 'pointer', transition: 'all 0.2s', color: 'var(--text-primary)'
                  }}
                  onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = 'var(--accent)'; (e.target as HTMLElement).style.background = 'var(--bg-elevated)' }}
                  onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.background = 'var(--bg-surface)' }}>
                    <div style={{ fontSize: 18, marginBottom: 6 }}>{s.icon}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{s.text}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className="animate-fade-in" style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {msg.role === 'user' ? (
                <div className="message-user" style={{ maxWidth: '72%', padding: '12px 16px' }}>
                  <div style={{ fontSize: 15, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                </div>
              ) : (
                <div style={{ maxWidth: '88%', width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: 6,
                      background: 'linear-gradient(135deg, var(--accent), #60a5fa)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12
                    }}>⚡</div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-bright)' }}>NEXUS</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  </div>
                  {msg.tools?.map((t, i) => <ToolBadge key={i} tool={t} result={t.success} />)}
                  <div className="message-ai" style={{ padding: '14px 18px' }}>
                    <MessageContent content={msg.content} />
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Streaming */}
          {(streaming || streamingMsg) && (
            <div className="animate-fade-in" style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: 'linear-gradient(135deg, var(--accent), #60a5fa)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>⚡</div>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-bright)' }}>NEXUS</span>
              </div>
              {Array.from(activeTools.values()).map((t, i) => (
                <ToolBadge key={i} tool={t} result={t.result !== undefined ? t.success : undefined} />
              ))}
              {streamingMsg && (
                <div className="message-ai" style={{ padding: '14px 18px', maxWidth: '88%' }}>
                  <MessageContent content={streamingMsg} />
                  <span className="cursor-blink" style={{ color: 'var(--accent)', marginLeft: 2 }}>▌</span>
                </div>
              )}
              {!streamingMsg && streaming && (
                <div style={{ display: 'flex', gap: 4, padding: '14px 18px', background: 'var(--bg-surface)', borderRadius: 12, border: '1px solid var(--border)', maxWidth: 80 }}>
                  {[0,1,2].map(i => (
                    <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: `pulse-glow 1.2s ease-in-out ${i*0.2}s infinite` }} className="animate-pulse-glow" />
                  ))}
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* INPUT AREA */}
        <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
          <div style={{
            display: 'flex', gap: 10, alignItems: 'flex-end',
            background: 'var(--bg-surface)', borderRadius: 14,
            border: '1px solid var(--border-bright)', padding: '4px 4px 4px 16px',
            transition: 'border-color 0.15s',
          }}
          onFocusCapture={e => e.currentTarget.style.borderColor = 'var(--accent)'}
          onBlurCapture={e => e.currentTarget.style.borderColor = 'var(--border-bright)'}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask anything... search the web, build apps, analyze science, execute code..."
              disabled={streaming}
              style={{
                flex: 1, background: 'none', border: 'none', outline: 'none',
                color: 'var(--text-primary)', fontSize: 15, resize: 'none',
                padding: '10px 0', minHeight: 24, maxHeight: 200, lineHeight: 1.5,
                fontFamily: 'Inter, sans-serif'
              }}
              rows={1}
              onInput={e => {
                const t = e.target as HTMLTextAreaElement
                t.style.height = 'auto'
                t.style.height = Math.min(t.scrollHeight, 200) + 'px'
              }}
            />
            <button onClick={sendMessage} disabled={!input.trim() || streaming} style={{
              width: 42, height: 42, borderRadius: 10, border: 'none', cursor: 'pointer',
              background: !input.trim() || streaming ? 'var(--bg-elevated)' : 'linear-gradient(135deg, var(--accent), #5b4fdd)',
              color: !input.trim() || streaming ? 'var(--text-muted)' : '#fff',
              fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s', flexShrink: 0
            }}>
              {streaming ? <div className="animate-spin" style={{ width: 16, height: 16, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%' }} /> : '↑'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {['🔍 Search', '⚡ Run Code', '🏗️ Build App', '🔬 Analyze', '🧮 Calculate'].map(cmd => (
              <button key={cmd} onClick={() => { setInput(cmd.split(' ').slice(1).join(' ') + ' '); inputRef.current?.focus() }} style={{
                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-muted)', fontSize: 12,
                cursor: 'pointer', transition: 'all 0.15s'
              }}
              onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = 'var(--accent)'; (e.target as HTMLElement).style.color = 'var(--accent-bright)' }}
              onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.color = 'var(--text-muted)' }}>
                {cmd}
              </button>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        .sidebar-item:hover .delete-btn { opacity: 1 !important; }
        @keyframes pulse-glow { 0%,100%{opacity:0.4} 50%{opacity:1} }
      `}</style>
    </div>
  )
}
