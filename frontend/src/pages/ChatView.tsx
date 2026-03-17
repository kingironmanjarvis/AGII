import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, Loader2, Wrench, Bot, Sparkles } from 'lucide-react';
import { streamChat, apiFetch } from '../hooks/useApi';
import type { SessionDetail, ModelInfo, StreamEvent } from '../types/api';

interface ChatViewProps {
  sessionId: string;
  onSessionCreated: (id: string) => void;
  model: string;
  models: ModelInfo[];
  onModelChange: (model: string) => void;
}

interface ActivityItem {
  id: string;
  type: 'tool' | 'agent' | 'status' | 'mission';
  label: string;
  detail?: string;
  done: boolean;
}

interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  activities?: ActivityItem[];
}

export function ChatView({ sessionId, onSessionCreated, model, models, onModelChange }: ChatViewProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [useMission, setUseMission] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(sessionId);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setCurrentSessionId(sessionId);
    if (sessionId) {
      loadSession(sessionId);
    } else {
      setMessages([]);
    }
  }, [sessionId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  async function loadSession(id: string) {
    try {
      const data = await apiFetch<SessionDetail>('/api/sessions/' + id);
      setMessages(
        data.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, ts: m.ts }))
      );
    } catch {
      /* session load failed */
    }
  }

  const handleSend = useCallback(
    (text?: string) => {
      const msg = text || input.trim();
      if (!msg || streaming) return;
      setInput('');

      const sid = currentSessionId || crypto.randomUUID();
      if (!currentSessionId) {
        setCurrentSessionId(sid);
      }

      setMessages((prev) => [...prev, { role: 'user', content: msg, ts: new Date().toISOString() }]);
      setStreaming(true);
      setStreamText('');
      setActivities([]);

      const ctrl = streamChat(
        msg, sid, model, useMission,
        (event: Record<string, unknown>) => {
          const e = event as unknown as StreamEvent;
          switch (e.type) {
            case 'token':
              setStreamText((prev) => prev + (e.text || ''));
              break;
            case 'tool_start':
              setActivities((prev) => [
                ...prev,
                { id: crypto.randomUUID(), type: 'tool', label: String(e.tool), detail: '', done: false },
              ]);
              break;
            case 'tool_result':
              setActivities((prev) =>
                prev.map((a, i) => (i === prev.length - 1 ? { ...a, done: true, detail: e.success ? 'Done' : 'Failed' } : a))
              );
              break;
            case 'agent_start':
              setActivities((prev) => [
                ...prev,
                { id: crypto.randomUUID(), type: 'agent', label: (e.emoji || '') + ' ' + e.agent, done: false },
              ]);
              break;
            case 'agent_done':
              setActivities((prev) =>
                prev.map((a) => (a.type === 'agent' && a.label.includes(e.agent || '') ? { ...a, done: true } : a))
              );
              break;
            case 'mission_start':
              setActivities((prev) => [
                ...prev,
                { id: crypto.randomUUID(), type: 'mission', label: 'Multi-agent mission started', done: false },
              ]);
              break;
            case 'mission_plan':
              setActivities((prev) =>
                prev.map((a) => (a.type === 'mission' ? { ...a, label: 'Plan: ' + e.plan, detail: e.taskCount + ' tasks', done: true } : a))
              );
              break;
            case 'status':
              setActivities((prev) => [
                ...prev,
                { id: crypto.randomUUID(), type: 'status', label: e.text || '', done: true },
              ]);
              break;
            case 'done':
              if (!currentSessionId) {
                onSessionCreated(sid);
              }
              break;
            case 'error':
              setStreamText((prev) => prev + '\n\nError: ' + e.message);
              break;
          }
        },
        () => {
          setStreaming(false);
          setStreamText((prev) => {
            if (prev) {
              setMessages((msgs) => [
                ...msgs,
                { role: 'assistant', content: prev, ts: new Date().toISOString(), activities: [...activities] },
              ]);
            }
            return '';
          });
          if (!currentSessionId) onSessionCreated(sid);
        },
        (err) => {
          setStreaming(false);
          setStreamText('');
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: 'Connection error: ' + err + '. Please check the backend is running.', ts: new Date().toISOString() },
          ]);
        }
      );
      abortRef.current = ctrl;
    },
    [input, streaming, currentSessionId, model, useMission, activities, onSessionCreated]
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const quickActions = [
    { label: 'Research AI frameworks', msg: 'Research the top 5 AI agent frameworks in 2025, compare them technically and write a structured report' },
    { label: 'Build a REST API', msg: 'Write a complete production-ready Python FastAPI backend with JWT auth, SQLite database, and full CRUD API for a task manager' },
    { label: 'Deep analysis', msg: 'Analyze the competitive landscape of AI startups in 2025, identify market gaps, and recommend a strategy for a new entrant' },
    { label: 'Platform capabilities', msg: 'Show me your capabilities. What tools do you have, how many agents, and what can you build?' },
  ];

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white flex-shrink-0">
        <h1 className="text-sm font-medium text-gray-700 pl-10 lg:pl-0">
          {messages.length > 0 ? 'Chat' : 'AGII Platform'}
        </h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={useMission}
              onChange={(e) => setUseMission(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5"
            />
            <span className="text-xs text-gray-500">Multi-Agent</span>
          </label>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="text-xs bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 && !streaming ? (
          <div className="flex flex-col items-center justify-center h-full px-6">
            <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center text-white font-bold text-xl mb-4 shadow-lg shadow-blue-200">
              A
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">AGII Agent Platform</h2>
            <p className="text-sm text-gray-500 text-center max-w-md mb-8">
              Multi-agent AI system with real tool execution, persistent memory, and mission orchestration.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg">
              {quickActions.map((qa) => (
                <button
                  key={qa.label}
                  onClick={() => handleSend(qa.msg)}
                  className="text-left p-3 rounded-xl border border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm transition-all group"
                >
                  <div className="text-xs font-medium text-gray-800 mb-1 group-hover:text-blue-700">{qa.label}</div>
                  <div className="text-[11px] text-gray-400 line-clamp-2">{qa.msg.slice(0, 80)}...</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}
            {streaming && (
              <div className="space-y-2">
                {activities.length > 0 && (
                  <div className="ml-10 space-y-1.5">
                    {activities.map((act) => (
                      <div
                        key={act.id}
                        className={'flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg ' +
                          (act.type === 'tool'
                            ? 'bg-amber-50 text-amber-700 border border-amber-100'
                            : act.type === 'agent'
                            ? 'bg-blue-50 text-blue-700 border border-blue-100'
                            : act.type === 'mission'
                            ? 'bg-purple-50 text-purple-700 border border-purple-100'
                            : 'bg-gray-50 text-gray-600 border border-gray-100'
                          )}
                      >
                        {!act.done ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : act.type === 'tool' ? (
                          <Wrench size={12} />
                        ) : act.type === 'agent' ? (
                          <Bot size={12} />
                        ) : (
                          <Sparkles size={12} />
                        )}
                        <span className="font-medium">{act.label}</span>
                        {act.detail && <span className="text-gray-400">- {act.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {streamText ? (
                  <div className="flex gap-3">
                    <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5">A</div>
                    <div className="prose text-sm text-gray-800 min-w-0 flex-1">
                      <ReactMarkdown>{streamText}</ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-3 items-center">
                    <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">A</div>
                    <div className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400 typing-dot" />
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400 typing-dot" />
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400 typing-dot" />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div ref={messagesEnd} />
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 bg-white px-4 py-3 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-100 transition-all">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message AGII..."
              rows={1}
              className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 resize-none outline-none min-h-[24px] max-h-[120px] leading-relaxed"
              style={{ height: 'auto', overflow: 'hidden' }}
              onInput={(e) => {
                const t = e.currentTarget;
                t.style.height = 'auto';
                t.style.height = Math.min(t.scrollHeight, 120) + 'px';
              }}
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || streaming}
              className="p-1.5 rounded-lg bg-blue-600 text-white disabled:bg-gray-300 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors flex-shrink-0"
            >
              {streaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1">
            <span className="text-[10px] text-gray-400">Enter to send, Shift+Enter for newline</span>
            <span className="text-[10px] text-gray-400">{model.split('/').pop()?.split('-').slice(0, 3).join('-')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={'flex gap-3 ' + (isUser ? 'flex-row-reverse' : '')}>
      <div className={'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ' + (isUser ? 'bg-gray-700 text-white' : 'bg-blue-600 text-white')}>
        {isUser ? 'U' : 'A'}
      </div>
      <div className={'min-w-0 flex-1 ' + (isUser ? 'flex flex-col items-end' : '')}>
        <div className={'text-sm leading-relaxed ' + (isUser ? 'bg-gray-100 text-gray-900 px-4 py-2.5 rounded-2xl rounded-tr-sm max-w-[85%] inline-block' : 'prose text-gray-800')}>
          {isUser ? (
            <span className="whitespace-pre-wrap">{message.content}</span>
          ) : (
            <ReactMarkdown>{message.content}</ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}
