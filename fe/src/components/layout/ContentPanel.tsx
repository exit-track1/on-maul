import type { ReactNode } from 'react';
import tokens, { C } from '../../design/tokens';

export interface ContentPanelProps {
  label: string;
  title: ReactNode;
  toolbar?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  divider?: boolean;
}

export function ContentPanel({
  label,
  title,
  toolbar,
  children,
  footer,
  divider = false,
}: ContentPanelProps) {
  return (
    <section
      aria-label={label}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        minWidth: 0,
        background: C.white,
        borderRight: divider ? `1px solid ${C.line}` : undefined,
      }}
    >
      <header
        style={{
          height: tokens.layout.header,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 20px',
          borderBottom: `1px solid ${C.line}`,
          fontSize: tokens.font.size.title,
          fontWeight: 600,
        }}
      >
        <span>{title}</span>
        {toolbar && <div style={{ marginLeft: 'auto' }}>{toolbar}</div>}
      </header>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '16px 20px 24px',
        }}
      >
        {children}
      </div>
      {footer && (
        <footer
          style={{ padding: '12px 20px', borderTop: `1px solid ${C.line}` }}
        >
          {footer}
        </footer>
      )}
    </section>
  );
}
