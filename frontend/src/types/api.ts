export interface Agent {
  id: string;
  role: string;
  name: string;
  emoji: string;
  desc: string;
  status: string;
  tasksCompleted: number;
  tasksRunning: number;
  errors: number;
  lastActive: string | null;
  successRate: number | null;
}

export interface Session {
  id: string;
  title: string;
  created: string;
  messageCount: number;
  pinned: boolean;
  lastMessage: string;
}

export interface SessionDetail {
  id: string;
  title: string;
  created: string;
  messages: Message[];
  model: string;
  personaId: string;
  pinned: boolean;
  messageCount: number;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: string;
}

export interface MemoryStore {
  facts: MemoryItem[];
  preferences: MemoryItem[];
  projects: MemoryItem[];
  notes: MemoryItem[];
  people: MemoryItem[];
  knowledge: MemoryItem[];
  decisions: MemoryItem[];
  patterns: MemoryItem[];
  [key: string]: MemoryItem[];
}

export interface MemoryItem {
  id: string;
  content: string;
  ts: string;
}

export interface FileEntry {
  name: string;
  size: number;
  modified: string;
  url: string;
}

export interface PlatformStats {
  sessions: number;
  totalMessages: number;
  memoryItems: number;
  skills: number;
  automations: number;
  agents: number;
  tasks: number;
  tasksSuccess: number;
  tasksFailed: number;
  knowledgeNodes: number;
  projects: number;
  files: number;
  uptime: number;
  version: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  speed: string;
  recommended?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

export interface StreamEvent {
  type: string;
  text?: string;
  sessionId?: string;
  title?: string;
  message?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  success?: boolean;
  agent?: string;
  emoji?: string;
  role?: string;
  task?: string;
  plan?: string;
  taskCount?: number;
  ms?: number;
  messageCount?: number;
  missionId?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  code: string;
  created: string;
  runCount: number;
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  task: string;
  cron: string;
  active: boolean;
  created: string;
  runCount: number;
  lastRun: string | null;
  lastResult: string | null;
}

export interface BenchmarkResult {
  id: string;
  capability: string;
  score: number;
  completeness?: number;
  correctness?: number;
  quality?: number;
  feedback?: string;
  latencyMs?: number;
  ts: string;
  version: string;
}
