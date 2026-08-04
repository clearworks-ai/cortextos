import type { MulticaClient } from './types.js';

/**
 * Maps a bus task's `project` field to a Multica project id so issues are
 * grouped under a master-level project (e.g. "auditos", an epic slug, a client)
 * instead of dumped flat.
 *
 * find-or-create with a per-run cache: the project list is fetched at most once,
 * and each distinct project name is created at most once. Best-effort — if
 * Multica's project API fails, resolve() returns null and the issue still syncs
 * ungrouped rather than failing the whole push.
 */
export interface ProjectResolver {
  resolve(projectName: string | null | undefined): Promise<string | null>;
}

// Project names that are not real groupings — leave these ungrouped (null).
const NON_GROUPING_NAMES = new Set(['', 'system']);

export function createProjectResolver(client: MulticaClient): ProjectResolver {
  // title (lowercased, trimmed) -> project id
  const cache = new Map<string, string>();
  let listed = false;

  async function ensureListed(): Promise<void> {
    if (listed) {
      return;
    }
    listed = true;
    try {
      const projects = await client.listProjects();
      for (const project of projects) {
        const key = project.title.trim().toLowerCase();
        if (key && !cache.has(key)) {
          cache.set(key, project.id);
        }
      }
    } catch (error) {
      // Leave the cache empty; resolve() falls back to create-or-null per name.
      console.warn(`[multica] project list failed, grouping degraded this run: ${errMessage(error)}`);
    }
  }

  return {
    async resolve(projectName) {
      const name = (projectName ?? '').trim();
      if (NON_GROUPING_NAMES.has(name.toLowerCase())) {
        return null;
      }

      await ensureListed();
      const key = name.toLowerCase();
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      try {
        const created = await client.createProject(name);
        cache.set(key, created.id);
        return created.id;
      } catch (error) {
        // Best-effort: a create race or API hiccup must not break the push.
        console.warn(`[multica] project create failed for "${name}", leaving ungrouped: ${errMessage(error)}`);
        return null;
      }
    },
  };
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
