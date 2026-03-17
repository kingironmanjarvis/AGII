import { Plus, Trash2, MessageSquare } from 'lucide-react';
import type { Session, PlatformStats } from '../types/api';

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

interface SidebarProps {
  navItems: NavItem[];
  activeView: string;
  onViewChange: (view: string) => void;
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNewChat: () => void;
  stats: PlatformStats | null;
}

export function Sidebar({
  navItems,
  activeView,
  onViewChange,
  sessions,
  activeSessionId,
  onSelectSession,
  onDeleteSession,
  onNewChat,
  stats,
}: SidebarProps) {
  return (
    <div className="h-full flex flex-col bg-white border-r border-gray-200">
      {/* Logo */}
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
            A
          </div>
          <div>
            <div className="font-semibold text-sm text-gray-900">AGII</div>
            <div className="text-[10px] text-gray-400">AI Agent Platform</div>
          </div>
        </div>
        <button
          onClick={onNewChat}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          <Plus size={14} />
          New Chat
        </button>
      </div>

      {/* Navigation */}
      <nav className="px-2 py-2 border-b border-gray-100">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors mb-0.5 ${
              activeView === item.id
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wider px-3 mb-1">
          Recent Chats
        </div>
        {sessions.length === 0 ? (
          <div className="text-xs text-gray-400 text-center py-4">
            No conversations yet
          </div>
        ) : (
          sessions.slice(0, 30).map((s) => (
            <div
              key={s.id}
              onClick={() => onSelectSession(s.id)}
              className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors mb-0.5 ${
                activeSessionId === s.id
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <MessageSquare size={13} className="text-gray-400 flex-shrink-0" />
              <span className="truncate flex-1 text-xs">{s.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSession(s.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-50 hover:text-red-500 transition-all"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Stats footer */}
      {stats && (
        <div className="p-3 border-t border-gray-100 grid grid-cols-3 gap-2">
          <div className="text-center">
            <div className="text-sm font-semibold text-gray-900">{stats.sessions}</div>
            <div className="text-[9px] text-gray-400">Chats</div>
          </div>
          <div className="text-center">
            <div className="text-sm font-semibold text-gray-900">{stats.agents}</div>
            <div className="text-[9px] text-gray-400">Agents</div>
          </div>
          <div className="text-center">
            <div className="text-sm font-semibold text-gray-900">{stats.memoryItems}</div>
            <div className="text-[9px] text-gray-400">Memory</div>
          </div>
        </div>
      )}
    </div>
  );
}
