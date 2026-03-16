import { useState, useEffect } from 'react';
import { Brain, Search, Trash2, RefreshCw, Plus, Database } from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import type { MemoryStore, MemoryItem } from '../types/api';

const CATEGORIES = ['facts', 'preferences', 'projects', 'notes', 'people', 'knowledge', 'decisions', 'patterns'];

export function MemoryView() {
  const [memory, setMemory] = useState<MemoryStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState('facts');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemoryItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [addingMemory, setAddingMemory] = useState(false);
  const [newMemory, setNewMemory] = useState('');

  useEffect(() => {
    loadMemory();
  }, []);

  async function loadMemory() {
    setLoading(true);
    try {
      const data = await apiFetch<MemoryStore>('/api/memory');
      setMemory(data);
    } catch {
      /* load failed */
    }
    setLoading(false);
  }

  async function searchMemory() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await apiFetch<{ results: MemoryItem[] }>('/api/memory/search', {
        method: 'POST',
        body: JSON.stringify({ query: searchQuery }),
      });
      setSearchResults(data.results);
    } catch {
      setSearchResults([]);
    }
    setSearching(false);
  }

  async function addMemoryItem() {
    if (!newMemory.trim()) return;
    try {
      await apiFetch('/api/memory', {
        method: 'POST',
        body: JSON.stringify({ category: activeCategory, content: newMemory }),
      });
      setNewMemory('');
      setAddingMemory(false);
      loadMemory();
    } catch {
      /* add failed */
    }
  }

  async function deleteMemory(category: string, id: string) {
    try {
      await apiFetch('/api/memory/' + category + '/' + id, { method: 'DELETE' });
      loadMemory();
    } catch {
      /* delete failed */
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  const items = searchResults || (memory ? memory[activeCategory] || [] : []);
  const totalItems = memory ? Object.values(memory).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Memory</h1>
            <p className="text-xs text-gray-500 mt-0.5">{totalItems} items across {CATEGORIES.length} categories</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAddingMemory(!addingMemory)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus size={12} />
              Add Memory
            </button>
            <button
              onClick={loadMemory}
              className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <RefreshCw size={14} className="text-gray-500" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (!e.target.value) setSearchResults(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && searchMemory()}
              placeholder="Search memory..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400"
            />
          </div>
          <button
            onClick={searchMemory}
            disabled={searching || !searchQuery.trim()}
            className="px-4 py-2 text-xs bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {searching ? <RefreshCw size={12} className="animate-spin" /> : 'Search'}
          </button>
        </div>

        {/* Add memory form */}
        {addingMemory && (
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
            <div className="flex gap-2">
              <select
                value={activeCategory}
                onChange={(e) => setActiveCategory(e.target.value)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-gray-50"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <input
                type="text"
                value={newMemory}
                onChange={(e) => setNewMemory(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addMemoryItem()}
                placeholder="Enter memory content..."
                className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={addMemoryItem}
                disabled={!newMemory.trim()}
                className="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-4">
          {/* Category sidebar */}
          <div className="w-44 flex-shrink-0">
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {CATEGORIES.map((cat) => {
                const count = memory ? (memory[cat] || []).length : 0;
                return (
                  <button
                    key={cat}
                    onClick={() => {
                      setActiveCategory(cat);
                      setSearchResults(null);
                    }}
                    className={'w-full flex items-center justify-between px-3 py-2 text-xs capitalize transition-colors ' +
                      (activeCategory === cat && !searchResults ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50')
                    }
                  >
                    <span className="flex items-center gap-2">
                      <Database size={12} />
                      {cat}
                    </span>
                    <span className="text-gray-400">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Memory items */}
          <div className="flex-1">
            <div className="bg-white rounded-xl border border-gray-200">
              {searchResults && (
                <div className="px-4 py-2 border-b border-gray-100 bg-blue-50">
                  <span className="text-xs text-blue-600">
                    {searchResults.length} search result{searchResults.length !== 1 ? 's' : ''} for "{searchQuery}"
                  </span>
                </div>
              )}
              {items.length > 0 ? (
                <div className="divide-y divide-gray-50">
                  {items.map((item) => (
                    <div key={item.id} className="px-4 py-3 flex items-start justify-between group">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800">{item.content}</p>
                        <span className="text-[10px] text-gray-400 mt-1 block">
                          {new Date(item.ts).toLocaleString()}
                        </span>
                      </div>
                      <button
                        onClick={() => deleteMemory(activeCategory, item.id)}
                        className="p-1 rounded text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0 ml-2"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-8 text-center">
                  <Brain className="mx-auto text-gray-300 mb-2" size={32} />
                  <p className="text-sm text-gray-400">
                    {searchResults ? 'No results found' : 'No memories in this category yet'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
