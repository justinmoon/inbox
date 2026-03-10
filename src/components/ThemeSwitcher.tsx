type ThemeOption = {
  id: string;
  label: string;
  description: string;
};

type ThemeSwitcherProps = {
  open: boolean;
  activeThemeId: string;
  themes: ThemeOption[];
  onToggle: () => void;
  onSelect: (themeId: string) => void;
};

export function ThemeSwitcher({
  open,
  activeThemeId,
  themes,
  onToggle,
  onSelect,
}: ThemeSwitcherProps) {
  const activeTheme = themes.find((theme) => theme.id === activeThemeId) ?? themes[0];

  return (
    <div className="floating-theme-widget">
      {open ? (
        <div className="theme-popover" role="dialog" aria-label="Theme picker">
          <div className="theme-popover-header">
            <div>
              <p className="section-label">Theme</p>
              <h2>{activeTheme?.label ?? 'Theme'}</h2>
            </div>
          </div>

          <div className="theme-option-list" role="radiogroup" aria-label="Color themes">
            {themes.map((theme) => (
              <button
                key={theme.id}
                className={`theme-option${theme.id === activeThemeId ? ' is-active' : ''}`}
                data-theme-option={theme.id}
                onClick={() => onSelect(theme.id)}
                role="radio"
                aria-checked={theme.id === activeThemeId}
                type="button"
              >
                <span className="theme-swatch-row" aria-hidden="true">
                  <span className={`theme-swatch theme-swatch-${theme.id}`} />
                </span>
                <span className="theme-option-copy">
                  <strong>{theme.label}</strong>
                  <span>{theme.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <button
        className="floating-theme-button"
        data-theme-toggle="true"
        aria-expanded={open}
        aria-label="Toggle theme picker"
        onClick={onToggle}
        type="button"
      >
        <span className="floating-theme-preview" aria-hidden="true">
          <span className={`theme-swatch theme-swatch-${activeThemeId}`} />
        </span>
        <span className="floating-theme-copy">
          <strong>{activeTheme?.label ?? 'Theme'}</strong>
          <span>Theme</span>
        </span>
      </button>
    </div>
  );
}
