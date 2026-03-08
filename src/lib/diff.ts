export type ParsedDiffLine = {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'context';
  text: string;
};

export type ParsedDiffFile = {
  id: string;
  oldPath: string;
  newPath: string;
  displayPath: string;
  additions: number;
  deletions: number;
  lines: ParsedDiffLine[];
};

function createFile(oldPath: string, newPath: string): ParsedDiffFile {
  const displayPath = newPath === '/dev/null' ? oldPath : newPath;
  return {
    id: displayPath.replaceAll(/[^\w/.-]+/g, '-'),
    oldPath,
    newPath,
    displayPath,
    additions: 0,
    deletions: 0,
    lines: [],
  };
}

export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  const lines = diffText.split(/\r?\n/);
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = createFile(match?.[1] ?? 'unknown', match?.[2] ?? 'unknown');
      current.lines.push({ kind: 'meta', text: line });
      continue;
    }

    if (!current) {
      current = createFile('worktree.patch', 'worktree.patch');
    }

    let kind: ParsedDiffLine['kind'] = 'context';
    if (line.startsWith('@@')) {
      kind = 'hunk';
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      kind = 'add';
      current.additions += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      kind = 'del';
      current.deletions += 1;
    } else if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ')
    ) {
      kind = 'meta';
    }

    current.lines.push({ kind, text: line });
  }

  if (current) files.push(current);
  return files;
}
