import { parseUnifiedDiff } from '../lib/diff.ts';

type DiffViewerProps = {
  diffText: string;
};

export function DiffViewer({ diffText }: DiffViewerProps) {
  const files = parseUnifiedDiff(diffText);

  return (
    <div className="diff-viewer">
      <div className="diff-outline">
        <p className="section-label">Changed files</p>
        {files.map((file) => (
          <a key={file.id} className="diff-outline-item" href={`#${file.id}`}>
            <span>{file.displayPath}</span>
            <span className="diff-counts">
              <span className="diff-add">+{file.additions}</span>
              <span className="diff-del">-{file.deletions}</span>
            </span>
          </a>
        ))}
      </div>

      <div className="diff-files">
        {files.map((file) => (
          <section key={file.id} id={file.id} className="diff-file">
            <header className="diff-file-header">
              <div>
                <h4>{file.displayPath}</h4>
                <p>
                  {file.oldPath} → {file.newPath}
                </p>
              </div>
              <div className="diff-counts">
                <span className="diff-add">+{file.additions}</span>
                <span className="diff-del">-{file.deletions}</span>
              </div>
            </header>
            <pre className="diff-pre">
              {file.lines.map((line, index) => (
                <code key={`${file.id}-${index}`} className={`diff-line diff-line-${line.kind}`}>
                  {line.text || ' '}
                  {'\n'}
                </code>
              ))}
            </pre>
          </section>
        ))}
      </div>
    </div>
  );
}
