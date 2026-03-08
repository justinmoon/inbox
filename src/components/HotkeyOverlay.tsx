type HotkeyOverlayProps = {
  open: boolean;
  onClose: () => void;
};

const shortcuts = [
  { keys: ['j'], description: 'Next unit' },
  { keys: ['k'], description: 'Previous unit' },
  { keys: ['m'], description: 'Focus main review surface' },
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

        <p className="hotkey-note">Selection moves in a fixed list order. Landed work stays out of the main queue.</p>
      </div>
    </div>
  );
}
