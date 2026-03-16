import { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import type { Agent } from '../types/api';

export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    setLoading(true);
    try {
      const data = await apiFetch<Agent[]>('/api/agents');
      setAgents(data);
    } catch {
      /* load failed */
    }
    setLoading(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  const selectedAgent = agents.find((a) => a.id === selected);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Agents</h1>
            <p className="text-xs text-gray-500 mt-0.5">{agents.length} specialized agents available</p>
          </div>
          <button
            onClick={loadAgents}
            className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
          >
            <RefreshCw size={14} className="text-gray-500" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setSelected(selected === agent.id ? null : agent.id)}
              className={'bg-white rounded-xl border p-4 text-left transition-all hover:shadow-sm ' +
                (selected === agent.id ? 'border-blue-300 ring-1 ring-blue-100' : 'border-gray-200')
              }
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{agent.emoji}</span>
                  <div>
                    <div className="text-sm font-medium text-gray-900">{agent.name}</div>
                    <div className="text-[11px] text-gray-400 capitalize">{agent.role}</div>
                  </div>
                </div>
                <div className={'w-2.5 h-2.5 rounded-full mt-1 ' +
                  (agent.status === 'idle' ? 'bg-green-400' : agent.status === 'busy' ? 'bg-amber-400 animate-pulse' : 'bg-gray-300')
                } />
              </div>
              <p className="text-xs text-gray-500 mb-3 line-clamp-2">{agent.desc}</p>
              <div className="flex items-center gap-3 text-xs">
                <div className="flex items-center gap-1 text-green-600">
                  <CheckCircle size={12} />
                  <span>{agent.tasksCompleted}</span>
                </div>
                {agent.errors > 0 && (
                  <div className="flex items-center gap-1 text-red-500">
                    <AlertCircle size={12} />
                    <span>{agent.errors}</span>
                  </div>
                )}
                {agent.successRate !== null && (
                  <div className={'flex items-center gap-1 ' +
                    (agent.successRate >= 80 ? 'text-green-600' : agent.successRate >= 50 ? 'text-amber-600' : 'text-red-500')
                  }>
                    <span>{agent.successRate}%</span>
                  </div>
                )}
                {agent.lastActive && (
                  <div className="flex items-center gap-1 text-gray-400 ml-auto">
                    <Clock size={12} />
                    <span>{timeAgo(agent.lastActive)}</span>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>

        {selectedAgent && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-3xl">{selectedAgent.emoji}</span>
              <div>
                <h2 className="text-base font-semibold text-gray-900">{selectedAgent.name}</h2>
                <span className="text-xs text-gray-500 capitalize">{selectedAgent.role} agent</span>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-4">{selectedAgent.desc}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Tasks Completed" value={String(selectedAgent.tasksCompleted)} />
              <StatCard label="Currently Running" value={String(selectedAgent.tasksRunning)} />
              <StatCard label="Errors" value={String(selectedAgent.errors)} />
              <StatCard label="Success Rate" value={selectedAgent.successRate !== null ? selectedAgent.successRate + '%' : 'N/A'} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="text-lg font-semibold text-gray-900">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}
