export const MIN_SQLITE_NODE = [22, 5, 0];

export function parseNodeVersion(text) {
  const match = String(text || "").match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareNodeVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

export function supportsNodeSqlite(version) {
  const parsed = parseNodeVersion(version);
  return parsed !== null && compareNodeVersions(parsed, MIN_SQLITE_NODE) >= 0;
}
