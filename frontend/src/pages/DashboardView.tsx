import { useState, useEffect } from 'react';
import { Activity, Cpu, Brain, MessageSquare, Bot, Zap, TrendingUp, Clock, BarChart3, RefreshCw } from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import type { PlatformStats, Agent, BenchmarkResult } from '../types/api';

export function DashboardView() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningBenchmark, setRunningBenchmark] = useState<string | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [s, a, b] = await Promise.all([
        apiFetch<PlatformStats>('/api/stats'),
        apiFetch<Agent[]>('/api/agents'),
        apiFetch<BenchmarkResult[]>('/api/evaluations').catch(() => []),
      ]);
      setStats(s);
      setAgents(a);
      setBenchmarks(b);
    } catch {
      /* load failed */
    }
    setLoading(false);
  }

  async function runBenchmark(capability: string) {
    setRunningBenchmark(capability);
    try {
      const result = await apiFetch<BenchmarkResult>('/api/evaluate', {
        method: 'POST',
        body: JSON.stringify({ capability }),
      });
      setBenchmarks((prev) => [result, ...prev]);
    } catch {
      /* benchmark failed */
    }
    setRunningBenchmark(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  const statCards = stats
    ? [
        { label: 'Sessions', value: stats.sessions, icon: <MessageSquare size={18} />, color: 'text-blue-600 bg-blue-50' },
        { label: 'Messages', value: stats.totalMessages, icon: <Activity size={18} />, color: 'text-green-600 bg-green-50' },
        { label: 'Agents', value: stats.agents, icon: <Bot size={18} />, color: 'text-purple-600 bg-purple-50' },
        { label: 'Memory Items', value: stats.memoryItems, icon: <Brain size={18} />, color: 'text-amber-600 bg-amber-50' },
        { label: 'Tasks Done', value: stats.tasksSuccess, icon: <Zap size={18} />, color: 'text-emerald-600 bg-emerald-50' },
        { label: 'Skills', value: stats.skills, icon: <Cpu size={18} />, color: 'text-indigo-600 bg-indigo-50' },
        { label: 'Files', value: stats.files, icon: <BarChart3 size={18} />, color: 'text-rose-600 bg-rose-50' },
        { label: 'Uptime', value: formatUptime(stats.uptime), icon: <Clock size={18} />, color: 'text-cyan-600 bg-cyan-50' },
      ]
    : [];

  const capabilities = ['reasoning', 'coding', 'memory', 'research', 'planning'];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Dashboard</h1>
            <p className="text-xs text-gray-500 mt-0.5">Platform overview and performance metrics</p>
          </div>
          <div className="flex items-center gap-2">
            {stats && (
              <span className="text-xs text-gray-400">v{stats.version}</span>
            )}
            <button
              onClick={loadAll}
              className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <RefreshCw size={14} className="text-gray-500" />
            </button>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {statCards.map((card) => (
            <div key={card.label} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={'p-1.5 rounded-lg ' + card.color}>{card.icon}</div>
              </div>
              <div className="text-xl font-semibold text-gray-900">{card.value}</div>
              <div className="text-xs text-gray-500 mt-0.5">{card.label}</div>
            </div>
          ))}
        </div>

        {/* Agents Status */}
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-medium text-gray-900">Agent Status</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {agents.map((agent) => (
              <div key={agent.id} className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-lg">{agent.emoji}</span>
                  <div>
                    <div className="text-sm font-medium text-gray-900">{agent.name}</div>
                    <div className="text-xs text-gray-500">{agent.role}</div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-xs text-gray-500">{agent.tasksCompleted} tasks</div>
                    {agent.successRate !== null && (
                      <div className={'text-xs font-medium ' + (agent.successRate >= 80 ? 'text-green-600' : agent.successRate >= 50 ? 'text-amber-600' : 'text-red-600')}>
                        {agent.successRate}% success
                      </div>
                    )}
                  </div>
                  <div className={'w-2 h-2 rounded-full ' + (agent.status === 'idle' ? 'bg-green-400' : agent.status === 'busy' ? 'bg-amber-400 animate-pulse' : 'bg-gray-300')} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Benchmarks */}
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-900">Performance Benchmarks</h2>
            <div className="flex gap-1.5">
              {capabilities.map((cap) => (
                <button
                  key={cap}
                  onClick={() => runBenchmark(cap)}
                  disabled={runningBenchmark !== null}
                  className="px-2.5 py-1 text-[11px] rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors disabled:opacity-50 capitalize"
                >
                  {runningBenchmark === cap ? (
                    <RefreshCw size={10} className="animate-spin inline mr-1" />
                  ) : (
                    <TrendingUp size={10} className="inline mr-1" />
                  )}
                  {cap}
                </button>
              ))}
            </div>
          </div>
          {benchmarks.length > 0 ? (
            <div className="divide-y divide-gray-50">
              {benchmarks.slice(0, 10).map((b) => (
                <div key={b.id} className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={'w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold ' +
                      (b.score >= 80 ? 'bg-green-50 text-green-700' : b.score >= 60 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700')}>
                      {b.score}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900 capitalize">{b.capability}</div>
                      <div className="text-xs text-gray-500">{b.feedback || 'No feedback'}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400">{b.latencyMs ? b.latencyMs + 'ms' : ''}</div>
                    <div className="text-[10px] text-gray-400">{new Date(b.ts).toLocaleDateString()}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              No benchmarks yet. Run a benchmark to evaluate agent performance.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
  return Math.floor(seconds / 86400) + 'd';
}
