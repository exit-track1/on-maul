import type { ReactNode } from 'react';
import tokens, { C, FONT } from '../../design/tokens';

export interface WorkspaceLayoutProps {
  sidebar: ReactNode;
  content: ReactNode;
  canvas?: ReactNode;
}

export function WorkspaceLayout({
  sidebar,
  content,
  canvas,
}: WorkspaceLayoutProps) {
  return (
    <div
      style={{
        height: '100%',
        minHeight: 640,
        width: '100%',
        display: 'grid',
        gridTemplateColumns: canvas
          ? `${tokens.layout.sidebar}px minmax(${tokens.layout.logMin}px,0.92fr) minmax(${tokens.layout.canvasMin}px,1.08fr)`
          : `${tokens.layout.sidebar}px minmax(0,1fr)`,
        fontFamily: FONT,
        color: C.ink,
        fontSize: tokens.font.size.body,
        letterSpacing: tokens.font.letterSpacing,
        fontVariantNumeric: 'tabular-nums',
        background: C.white,
        overflow: 'hidden',
      }}
    >
      {sidebar}
      {content}
      {canvas}
    </div>
  );
}
