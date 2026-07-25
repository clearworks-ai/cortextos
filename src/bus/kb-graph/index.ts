export {
  hasNodeSqlite,
  assertNodeSqliteAvailable,
  linksDbPath,
  jobsDir,
  kbRootPath,
  openLinksDb,
  upsertEntity,
  upsertEdge,
  getWatermark,
  setWatermark,
  edgeStats,
  countFrontmatterEdges,
  entityExists,
  type EdgeRow,
} from './db.js';

export {
  WORKS_AT_RE,
  INVESTED_RE,
  FOUNDED_RE,
  ADVISES_RE,
  PARTNER_ROLE_RE,
  WIKILINK_RE,
  MDLINK_RE,
  BARE_SLUG_RE,
  extractMentions,
  inferLinkType,
  contextWindow,
  type LinkType,
  type Mention,
  type InferredLink,
} from './link-extraction.js';

export {
  extractEdges,
  defaultExtractRoots,
  type ExtractOptions,
  type ExtractResult,
  type SlugResolverIface,
} from './extract.js';

export {
  buildSlugIndex,
  createSlugResolver,
  slugify,
  trigramSimilarity,
  FUZZY_THRESHOLD,
  type SlugIndexEntry,
  type ResolveResult,
  type SlugResolver,
} from './resolve.js';

export {
  parseRelationalIntent,
  executeIntent,
  runGraphCanary,
  SUPPORTED_PATTERNS,
  type IntentKind,
  type ParsedIntent,
  type GraphHit,
  type QueryOptions,
  type GraphCanaryConfig,
} from './relational.js';

export {
  FRONTMATTER_LINK_MAP,
  parseFrontmatterBlock,
  extractFrontmatterEdges,
  type FrontmatterBlock,
  type FrontmatterEdgeInput,
} from './frontmatter.js';

export {
  dreamScan,
  recordVerdict,
  validateDreamPayload,
  fileDreamPayload,
  dreamStatus,
  type DreamScanOptions,
  type DreamJob,
  type DreamPayload,
  type FileResult,
} from './dream.js';
