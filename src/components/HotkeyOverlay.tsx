type HotkeyOverlayProps = {
  open: boolean;
  onClose: () => void;
};

const groups = [
  {
    title: 'Review Cockpit',
    shortcuts: [
      { keys: ['j'], description: 'Next unit' },
      { keys: ['k'], description: 'Previous unit' },
      { keys: ['['], description: 'Previous session' },
      { keys: [']'], description: 'Next session' },
      { keys: ['Shift', 'H'], description: 'Shrink replay pane' },
      { keys: ['Shift', 'L'], description: 'Grow replay pane' },
      { keys: ['m'], description: 'Focus main review surface' },
      { keys: ['r'], description: 'Open session wall' },
    ],
  },
  {
    title: 'Session Wall',
    shortcuts: [
      { keys: ['h'], description: 'Previous column' },
      { keys: ['l'], description: 'Next column' },
      { keys: ['j'], description: 'Scroll active column down' },
      { keys: ['k'], description: 'Scroll active column up' },
      { keys: ['g'], description: 'Jump active column to top' },
      { keys: ['Shift', 'G'], description: 'Jump active column to bottom' },
      { keys: ['r'], description: 'Exit session wall' },
      { keys: ['Esc'], description: 'Exit wall or close help' },
    ],
  },
  {
    title: 'Global',
    shortcuts: [{ keys: ['?'], description: 'Open or close this help' }],
  },
];

export function HotkeyOverlay({ open, onClose }: HotkeyOverlayProps) {
  if (!open) return null;

  return (
    <div className="hotkey-overlay" role="dialog" aria-modal="true" aria-labelledby="hotkey-title">
      <div className="hotkey-dialog">
        <div className="hotkey-header">
          <div>
            <p className="eyebrow">Hotkeys</p>
            <h2 id="hotkey-title">Keyboard shortcuts</h2>
          </div>

          <button className="ghost-button hotkey-close" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div className="hotkey-group-list">
          {groups.map((group) => (
            <section key={group.title} className="hotkey-group">
              <p className="section-label">{group.title}</p>
              <div className="hotkey-list">
                {group.shortcuts.map((shortcut) => (
                  <div key={`${group.title}-${shortcut.description}`} className="hotkey-row">
                    <div className="hotkey-keys" aria-label={shortcut.keys.join(' then ')}>
                      {shortcut.keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </div>
                    <span>{shortcut.description}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className="hotkey-note">
          Review mode keeps the three-pane cockpit. Wall mode shows all sessions at once with one active
          column.
        </p>
      </div>
    </div>
  );
}
