type HotkeyOverlayProps = {
  open: boolean;
  onClose: () => void;
};

const shortcuts = [
  { keys: ['j'], description: 'Next unit' },
  { keys: ['k'], description: 'Previous unit' },
  { keys: ['['], description: 'Previous session' },
  { keys: [']'], description: 'Next session' },
  { keys: ['Shift', 'H'], description: 'Shrink replay pane' },
  { keys: ['Shift', 'L'], description: 'Grow replay pane' },
  { keys: ['m'], description: 'Focus main review surface' },
  { keys: ['r'], description: 'Toggle replay focus mode' },
  { keys: ['?'], description: 'Open or close this help' },
  { keys: ['Esc'], description: 'Close help' },
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

        <div className="hotkey-list">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.description} className="hotkey-row">
              <div className="hotkey-keys" aria-label={shortcut.keys.join(' then ')}>
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </div>
              <span>{shortcut.description}</span>
            </div>
          ))}
        </div>

        <p className="hotkey-note">
          Unit selection and session navigation stay in fixed order. Replay width persists across reloads.
        </p>
      </div>
    </div>
  );
}
