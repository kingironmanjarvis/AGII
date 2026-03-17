import { useState, useEffect } from 'react';
import { ChatView } from './pages/ChatView';
import { DashboardView } from './pages/DashboardView';
import { AgentsView } from './pages/AgentsView';
import { MemoryView } from './pages/MemoryView';
import { FilesView } from './pages/FilesView';
import { Sidebar } from './components/Sidebar';
import type { Session, PlatformStats, ModelInfo } from './types/api';
import { apiFetch } from './hooks/useApi';
import {
  MessageSquare,
  LayoutDashboard,
  Bot,
  Brain,
  FolderOpen,
  Menu,
} from 'lucide-react';

type View = 'chat' | 'dashboard' | 'agents' | 'memory' | 'files';

const NAV_ITEMS: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <MessageSquare size={18} /> },
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
  { id: 'agents', label: 'Agents', icon: <Bot size={18} /> },
  { id: 'memory', label: 'Memory', icon: <Brain size={18} /> },
  { id: 'files', label: 'Files', icon: <FolderOpen size={18} /> },
];

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('llama-3.3-70b-versatile');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    loadSessions();
    loadStats();
    loadModels();
    const interval = setInterval(loadStats, 30000);
    return () => clearInterval(interval);
  }, []);

  async function loadSessions() {
    try {
      const data = await apiFetch<Session[]>('/api/sessions');
      setSessions(data);
    } catch { /* ignore */ }
  }

  async function loadStats() {
    try {
      const data = await apiFetch<PlatformStats>('/api/stats');
      setStats(data);
    } catch { /* ignore */ }
  }

  async function loadModels() {
    try {
      const data = await apiFetch<ModelInfo[]>('/api/models');
      setModels(data);
      const rec = data.find((m) => m.recommended);
      if (rec) setSelectedModel(rec.id);
    } catch { /* ignore */ }
  }

  function handleNewChat() {
    setActiveSessionId('');
    setView('chat');
  }

  function handleSelectSession(id: string) {
    setActiveSessionId(id);
    setView('chat');
  }

  async function handleDeleteSession(id: string) {
    try {
      await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) setActiveSessionId('');
    } catch { /* ignore */ }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Mobile menu button */}
      <button
        className="fixed top-3 left-3 z-50 lg:hidden p-2 rounded-lg bg-white border border-gray-200 shadow-sm"
        onClick={() => setSidebarOpen(!sidebarOpen)}
      >
        <Menu size={18} />
      </button>

      {/* Sidebar */}
      <div
        className={`${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } fixed inset-y-0 left-0 z-40 w-64 lg:relative lg:translate-x-0 transition-transform duration-200`}
      >
        <Sidebar
          navItems={NAV_ITEMS}
          activeView={view}
          onViewChange={(v) => { setView(v as View); setSidebarOpen(false); }}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onNewChat={handleNewChat}
          stats={stats}
        />
      </div>

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {view === 'chat' && (
          <ChatView
            sessionId={activeSessionId}
            onSessionCreated={(id) => {
              setActiveSessionId(id);
              loadSessions();
            }}
            model={selectedModel}
            models={models}
            onModelChange={setSelectedModel}
          />
        )}
        {view === 'dashboard' && <DashboardView />}
        {view === 'agents' && <AgentsView />}
        {view === 'memory' && <MemoryView />}
        {view === 'files' && <FilesView />}
      </main>
    </div>
  );
}
