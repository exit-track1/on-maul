import type { ReactNode } from 'react';
import tokens, { C } from '../../design/tokens';

export interface SidebarProps {
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}

export function Sidebar({ title, children, footer }: SidebarProps) {
  return (
    <aside
      aria-label="사이드바"
      style={{
        background: C.sub,
        borderRight: `1px solid ${C.line}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <header
        style={{
          height: tokens.layout.header,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 16px',
          flexShrink: 0,
          fontSize: tokens.font.size.title,
          fontWeight: 600,
        }}
      >
        {title}
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
        {children}
      </div>
      {footer && (
        <footer
          style={{
            borderTop: `1px solid ${C.line}`,
            padding: '12px 16px',
            color: C.ink3,
            fontSize: tokens.font.size.aux,
          }}
        >
          {footer}
        </footer>
      )}
    </aside>
  );
}
