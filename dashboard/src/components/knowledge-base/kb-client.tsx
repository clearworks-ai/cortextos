'use client';

import { useState, useEffect, useRef } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  IconSearch,
  IconDatabase,
  IconFileText,
  IconBook2,
  IconAlertCircle,
  IconLoader2,
  IconChevronDown,
  IconBrain,
  IconCalendar,
  IconMail,
  IconUsers,
} from '@tabler/icons-react';
import { KnowledgeBaseView } from './kb-view';

interface SearchResult {
  content: string;
  score: number;
  source_file: string;
  doc_type: string;
  filename: string;
  collection: string;
}

interface Collection {
  name: string;
  count: number;
}

interface ClearpathResult {
  id: number;
  extractionId: number;
  meetingTitle: string;
  meetingDate: string;
  promptKey: string;
  promptLabel: string;
  result: string;
  similarity?: number;
  dataSource?: string;
}

interface ClearpathStats {
  totalExtractions: number;
  coveragePercent: number;
  emailCoveragePercent: number;
  omiCoveragePercent: number;
  mostActiveType: string | null;
  trend: 'up' | 'down' | 'stable';
}

interface KnowledgeBaseClientProps {
  org: string;
  markdownContent: string;
  filePath: string;
}

function collectionLabel(name: string): string {
  if (name.startsWith('agent-')) return name.replace('agent-', '') + ' (private)';
  if (name.startsWith('shared-')) return name.replace('shared-', '') + ' (shared)';
  return name;
}

function shortPath(sourcePath: string): string {
  if (!sourcePath) return '';
  const parts = sourcePath.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return sourcePath;
  return parts.slice(-2).join('/');
}

export function KnowledgeBaseClient({ org, markdownContent, filePath }: KnowledgeBaseClientProps) {
  const [query, setQuery] = useState('');
  const [selectedCollection, setSelectedCollection] = useState('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [totalDocs, setTotalDocs] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clearpath Intelligence state
  const [cpQuery, setCpQuery] = useState('');
  const [cpResults, setCpResults] = useState<ClearpathResult[]>([]);
  const [cpSearching, setCpSearching] = useState(false);
  const [cpSearched, setCpSearched] = useState(false);
  const [cpError, setCpError] = useState('');
  const [cpStats, setCpStats] = useState<ClearpathStats | null>(null);
  const [cpStatsLoading, setCpStatsLoading] = useState(true);
  const cpInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!org) { setCollectionsLoading(false); return; }
    fetch(`/api/kb/collections?org=${encodeURIComponent(org)}`)
      .then((r) => r.ok ? r.json() : { collections: [] })
      .then((data) => {
        const cols: Collection[] = data.collections || [];
        setCollections(cols);
        setTotalDocs(cols.reduce((sum, c) => sum + c.count, 0));
      })
      .catch(() => {})
      .finally(() => setCollectionsLoading(false));
  }, [org]);

  useEffect(() => {
    if (!org) { setCpStatsLoading(false); return; }
    fetch(`/api/kb/clearpath/stats?org=${encodeURIComponent(org)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setCpStats(data as ClearpathStats); })
      .catch(() => {})
      .finally(() => setCpStatsLoading(false));
  }, [org]);

  const handleClearpathSearch = async () => {
    if (!cpQuery.trim()) return;
    setCpSearching(true);
    setCpSearched(true);
    setCpError('');
    try {
      const params = new URLSearchParams({ q: cpQuery, org, limit: '20' });
      const res = await fetch(`/api/kb/clearpath/search?${params}`);
      if (res.ok) {
        const data = await res.json();
        setCpResults(data.results || data || []);
      } else {
        const data = await res.json().catch(() => ({}));
        setCpError(data.error || `Search failed (${res.status})`);
        setCpResults([]);
      }
    } catch {
      setCpError('Network error — could not reach Clearpath API');
      setCpResults([]);
    } finally {
      setCpSearching(false);
    }
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(true);
    setSearchError('');
    try {
      const params = new URLSearchParams({ q: query, limit: '10', org });
      // If a specific collection is selected, pass it as collection param (bypasses scope logic)
      if (selectedCollection === 'all') {
        params.set('scope', 'all');
      } else {
        params.set('collection', selectedCollection);
        params.set('scope', 'all');
      }
      const res = await fetch(`/api/kb/search?${params}`);
      if (res.ok) {
        const data = await res.json();
        let r: SearchResult[] = data.results || [];
        // If filtered to a specific collection, client-side filter too (belt+suspenders)
        if (selectedCollection !== 'all') {
          r = r.filter((x) => x.collection === selectedCollection);
        }
        setResults(r);
      } else {
        const data = await res.json().catch(() => ({}));
        setSearchError(data.error || `Search failed (${res.status})`);
        setResults([]);
      }
    } catch {
      setSearchError('Network error — could not reach search API');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const KBStatus = () => {
    if (collectionsLoading) {
      return (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <IconLoader2 size={11} className="animate-spin" />
          Loading...
        </span>
      );
    }
    if (collections.length === 0) {
      return (
        <span className="flex items-center gap-1 text-[11px] text-amber-500">
          <IconAlertCircle size={11} />
          No collections
        </span>
      );
    }
    return (
      <span className="text-[11px] text-muted-foreground">
        {totalDocs} docs across {collections.length} collection{collections.length !== 1 ? 's' : ''}
      </span>
    );
  };

  return (
    <Tabs defaultValue="intelligence">
      <TabsList variant="line">
        <TabsTrigger value="intelligence">
          <IconBrain size={14} className="mr-1.5" />
          Intelligence
          {!cpStatsLoading && cpStats && (
            <span className="ml-1.5 rounded-full bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-medium">
              {cpStats.totalExtractions.toLocaleString()}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="search">
          <IconSearch size={14} className="mr-1.5" />
          Agent KB
        </TabsTrigger>
        <TabsTrigger value="browse">
          <IconBook2 size={14} className="mr-1.5" />
          Knowledge File
        </TabsTrigger>
        <TabsTrigger value="collections">
          <IconDatabase size={14} className="mr-1.5" />
          Collections
          {!collectionsLoading && collections.length > 0 && (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
              {collections.length}
            </span>
          )}
        </TabsTrigger>
      </TabsList>

      {/* Clearpath Intelligence Tab */}
      <TabsContent value="intelligence" className="space-y-3 mt-3">
        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {cpStatsLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-muted/30 animate-pulse" />
            ))
          ) : cpStats ? (
            <>
              <Card>
                <CardContent className="py-2.5 px-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total Records</p>
                  <p className="text-lg font-semibold tabular-nums">{cpStats.totalExtractions.toLocaleString()}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-2.5 px-3 flex items-start gap-2">
                  <IconCalendar size={14} className="mt-1 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Meeting Coverage</p>
                    <p className="text-lg font-semibold tabular-nums">{cpStats.coveragePercent ?? 0}%</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-2.5 px-3 flex items-start gap-2">
                  <IconMail size={14} className="mt-1 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Email Coverage</p>
                    <p className="text-lg font-semibold tabular-nums">{cpStats.emailCoveragePercent ?? 0}%</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-2.5 px-3 flex items-start gap-2">
                  <IconUsers size={14} className="mt-1 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Top Category</p>
                    <p className="text-sm font-medium truncate">{cpStats.mostActiveType ?? '—'}</p>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <div className="col-span-4">
              <Card className="border-amber-200/50">
                <CardContent className="py-3 flex items-center gap-2 text-sm text-amber-600">
                  <IconAlertCircle size={15} />
                  Clearpath Intelligence not configured for this org
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* Search row */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <IconSearch size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              ref={cpInputRef}
              type="text"
              value={cpQuery}
              onChange={(e) => setCpQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleClearpathSearch()}
              placeholder="Search meetings, emails, decisions, follow-ups..."
              className="w-full rounded-md border bg-background pl-9 pr-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30"
              autoFocus
            />
          </div>
          <button
            onClick={handleClearpathSearch}
            disabled={cpSearching || !cpQuery.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-opacity whitespace-nowrap"
          >
            {cpSearching ? (
              <span className="flex items-center gap-1.5">
                <IconLoader2 size={13} className="animate-spin" />
                Searching
              </span>
            ) : 'Search'}
          </button>
        </div>

        {cpError && (
          <Card className="border-destructive/30">
            <CardContent className="py-3 flex items-center gap-2 text-sm text-destructive">
              <IconAlertCircle size={15} />
              {cpError}
            </CardContent>
          </Card>
        )}

        {cpSearched && !cpError && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {cpResults.length === 0 ? 'No results' : `${cpResults.length} result${cpResults.length !== 1 ? 's' : ''}`}
            </p>
            {cpResults.map((r, i) => (
              <Card key={i} className="hover:bg-muted/20 transition-colors">
                <CardContent className="py-3 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="text-[10px]">{r.promptLabel || r.promptKey}</Badge>
                    {r.dataSource && (
                      <Badge variant="outline" className="text-[10px]">{r.dataSource}</Badge>
                    )}
                    {r.similarity != null && (
                      <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                        {(r.similarity * 100).toFixed(0)}% match
                      </span>
                    )}
                  </div>
                  <p className="text-sm leading-relaxed line-clamp-4">{r.result}</p>
                  {(r.meetingTitle || r.meetingDate) && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <IconCalendar size={11} />
                      {r.meetingTitle}
                      {r.meetingDate && ` · ${new Date(r.meetingDate).toLocaleDateString()}`}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {!cpSearched && !cpError && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <div className="rounded-full bg-muted p-3 mb-3">
                <IconBrain size={22} className="text-muted-foreground/50" />
              </div>
              <h3 className="text-sm font-medium mb-1">Search Clearpath Intelligence</h3>
              <p className="text-xs text-muted-foreground max-w-sm">
                Semantic search across {cpStats ? cpStats.totalExtractions.toLocaleString() : '—'} extracted insights from meetings, emails, and conversations.
              </p>
            </CardContent>
          </Card>
        )}
      </TabsContent>

      {/* Agent KB Search Tab */}
      <TabsContent value="search" className="space-y-3 mt-3">
        <div className="flex items-center justify-between">
          <KBStatus />
        </div>

        {/* Search row: input + collection filter + button */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <IconSearch size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Ask anything about your org..."
              className="w-full rounded-md border bg-background pl-9 pr-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30"
              autoFocus
            />
          </div>

          {/* Collection filter dropdown — only shown once collections are loaded */}
          {!collectionsLoading && collections.length > 0 && (
            <div className="relative">
              <select
                value={selectedCollection}
                onChange={(e) => {
                  setSelectedCollection(e.target.value);
                  // Re-search if already searched
                  if (searched && query.trim()) {
                    setTimeout(handleSearch, 0);
                  }
                }}
                className="h-full appearance-none rounded-md border bg-background pl-3 pr-8 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring/30 cursor-pointer min-w-[140px]"
              >
                <option value="all">All collections</option>
                {collections.map((col) => (
                  <option key={col.name} value={col.name}>
                    {collectionLabel(col.name)} ({col.count})
                  </option>
                ))}
              </select>
              <IconChevronDown
                size={13}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
            </div>
          )}

          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-opacity whitespace-nowrap"
          >
            {searching ? (
              <span className="flex items-center gap-1.5">
                <IconLoader2 size={13} className="animate-spin" />
                Searching
              </span>
            ) : 'Search'}
          </button>
        </div>

        {/* Active filter badge */}
        {selectedCollection !== 'all' && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Filtering by:</span>
            <Badge variant="secondary" className="text-[10px] gap-1">
              {collectionLabel(selectedCollection)}
              <button
                onClick={() => { setSelectedCollection('all'); if (searched && query.trim()) setTimeout(handleSearch, 0); }}
                className="ml-0.5 hover:text-foreground"
              >
                ×
              </button>
            </Badge>
          </div>
        )}

        {/* Error state */}
        {searchError && (
          <Card className="border-destructive/30">
            <CardContent className="py-3 flex items-center gap-2 text-sm text-destructive">
              <IconAlertCircle size={15} />
              {searchError}
            </CardContent>
          </Card>
        )}

        {/* Results */}
        {searched && !searchError && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {results.length === 0
                ? 'No results — try different keywords or a different collection'
                : `${results.length} result${results.length !== 1 ? 's' : ''}${selectedCollection !== 'all' ? ` in ${collectionLabel(selectedCollection)}` : ''}`}
            </p>
            {results.length === 0 && (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No matching content found.
                </CardContent>
              </Card>
            )}
            {results.map((result, i) => (
              <Card key={i} className="hover:bg-muted/20 transition-colors">
                <CardContent className="py-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="text-[10px]">
                      {collectionLabel(result.collection)}
                    </Badge>
                    {result.doc_type && result.doc_type !== 'text' && (
                      <Badge variant="outline" className="text-[10px]">
                        {result.doc_type}
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                      {(result.score * 100).toFixed(0)}% match
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed line-clamp-4">{result.content}</p>
                  {(result.filename || result.source_file) && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <IconFileText size={11} />
                      {shortPath(result.filename || result.source_file)}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Empty pre-search state */}
        {!searched && !searchError && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <div className="rounded-full bg-muted p-3 mb-3">
                <IconSearch size={22} className="text-muted-foreground/50" />
              </div>
              <h3 className="text-sm font-medium mb-1">Search your knowledge base</h3>
              <p className="text-xs text-muted-foreground max-w-sm">
                Ask questions in natural language. Searches across all agent memories, shared org docs, and ingested content.
              </p>
            </CardContent>
          </Card>
        )}
      </TabsContent>

      {/* Browse Tab */}
      <TabsContent value="browse" className="mt-3">
        <KnowledgeBaseView
          content={markdownContent}
          org={org}
          filePath={filePath}
        />
      </TabsContent>

      {/* Collections Tab */}
      <TabsContent value="collections" className="mt-3">
        {collectionsLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 rounded-lg bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : collections.length > 0 ? (
          <div className="space-y-2">
            {collections.map((col) => (
              <Card
                key={col.name}
                className="hover:bg-muted/20 transition-colors cursor-pointer"
                onClick={() => {
                  setSelectedCollection(col.name);
                  // Switch to search tab by dispatching a click on the tab trigger
                  document.querySelector<HTMLElement>('[data-slot="tabs-trigger"][value="search"]')?.click();
                  inputRef.current?.focus();
                }}
              >
                <CardContent className="py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <IconDatabase size={15} className="text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{collectionLabel(col.name)}</p>
                      <p className="text-[11px] text-muted-foreground font-mono">{col.name}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{col.count} docs</Badge>
                    <span className="text-[10px] text-muted-foreground">Search →</span>
                  </div>
                </CardContent>
              </Card>
            ))}
            <p className="text-xs text-muted-foreground text-right pt-1">
              {totalDocs} total documents
            </p>
          </div>
        ) : (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <div className="rounded-full bg-muted p-3 mb-3">
                <IconDatabase size={22} className="text-muted-foreground/50" />
              </div>
              <h3 className="text-sm font-medium mb-1">No collections yet</h3>
              <p className="text-xs text-muted-foreground max-w-sm mb-3">
                Ingest content to create collections. Agents automatically ingest their memory files on each heartbeat.
              </p>
              <code className="text-[10px] font-mono bg-muted px-2 py-1 rounded">
                cortextos bus kb-ingest ./file.md --org {org}
              </code>
            </CardContent>
          </Card>
        )}
      </TabsContent>
    </Tabs>
  );
}
