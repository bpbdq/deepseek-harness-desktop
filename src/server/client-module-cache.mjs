/**
 * Reuse immutable client artifacts while the official Loader activates plugins.
 * No files in node_modules are modified. The adapter is pinned to the exact
 * implementation we tested; an upstream change automatically uses its own code.
 */
import { createHash } from 'node:crypto'
import * as nodeModule from 'node:module'

// @deepseek-ai/dsh-client-modules 0.1.5-rc.1 (LF-normalized lib/index.js).
const SUPPORTED_SOURCE = '4a44f8cf7b61a26a1e6d9c829f60b405d5a0e0886e5e148175164b1129006d18'

const CACHE = `
const desktopPreparedRecords = new WeakMap();
const desktopSingleArtifacts = new WeakMap();
function desktopPrepareRecord(record) {
  const cached = desktopPreparedRecords.get(record);
  if (cached && cached.bundle === record.bundle && cached.sourceMap === record.sourceMap && cached.id === record.entry.id) return cached;
  const prepared = comboSource(record);
  const section = record.sourceMap === void 0 ? identitySectionMap(prepared.source, prepared.fallbackSource) : comboSectionMap(record);
  const value = { bundle: record.bundle, sourceMap: record.sourceMap, id: record.entry.id, prepared, section, lines: newlineCount(prepared.source) + 1 };
  desktopPreparedRecords.set(record, value);
  return value;
}
function buildCombo(records, revision) {
  if (records.length !== 1) return desktopBuildCombo(records, revision);
  const record = records[0];
  const prepared = desktopPrepareRecord(record);
  const cached = desktopSingleArtifacts.get(record);
  if (cached && cached.prepared === prepared && cached.revision === revision) return cached.artifact;
  const artifact = desktopBuildCombo(records, revision);
  desktopSingleArtifacts.set(record, { prepared, revision, artifact });
  return artifact;
}
`

/** Return undefined for unknown upstream code: compatibility wins over speed. */
export function cachedClientModuleSource(source) {
  const normalized = source.replace(/\r\n/gu, '\n')
  if (createHash('sha256').update(normalized).digest('hex') !== SUPPORTED_SOURCE) return undefined
  return normalized
    .replace('function buildCombo(records, revision) {', `${CACHE}\nfunction desktopBuildCombo(records, revision) {`)
    .replace('const prepared = comboSource(record);\n\t\tconst section = record.sourceMap === void 0 ? identitySectionMap(prepared.source, prepared.fallbackSource) : comboSectionMap(record);',
      'const { prepared, section, lines } = desktopPrepareRecord(record);')
    .replace('line += newlineCount(bundle);', 'line += lines;')
}

export function installClientModuleCache() {
  if (process.env.DSH_DESKTOP_DISABLE_STARTUP_CACHE === '1' || typeof nodeModule.registerHooks !== 'function') return
  const hook = nodeModule.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (!url.endsWith('/@deepseek-ai/dsh-client-modules/lib/index.js')) return result
      hook.deregister()
      if (result.source == null) return result
      const source = cachedClientModuleSource(typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8'))
      if (process.env.DSH_DESKTOP_TIMING === '1') {
        console.error(`[startup-cache] ${source === undefined ? 'upstream version not matched; using original implementation' : 'enabled'}`)
      }
      return source === undefined ? result : { ...result, source }
    },
  })
}
