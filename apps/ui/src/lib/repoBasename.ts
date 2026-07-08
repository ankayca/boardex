// Last path segment of a repo path, tolerant of trailing slashes — §7.2 (composer
// context chips) and §7.3 (board context rail) both render the repo by basename.
export function repoBasename(repoPath: string): string {
  return /([^/]+)\/*$/.exec(repoPath)?.[1] ?? repoPath;
}
