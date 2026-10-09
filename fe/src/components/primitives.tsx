import type { CSSProperties, ReactNode, MouseEventHandler } from 'react';
import { C, MONO } from '../design/tokens';

export interface BasicProps {
  children?: ReactNode;
  style?: CSSProperties;
}
export interface PillProps extends BasicProps {
  tone?: 'outline' | 'soft' | 'solid' | 'red' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  onClick?: MouseEventHandler<HTMLElement>;
  title?: string;
}
export interface ButtonProps extends BasicProps {
  kind?: 'primary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
}

export function Pill({
  children,
  tone = 'outline',
  size = 'md',
  onClick,
  style,
  title,
}: PillProps) {
  const h = size === 'sm' ? 22 : size === 'lg' ? 34 : 28;
  const tones = {
    outline: {
      border: `1px solid ${C.line2}`,
      background: C.white,
      color: C.ink,
    },
    soft: { border: `1px solid ${C.sub2}`, background: C.sub2, color: C.ink2 },
    solid: { border: `1px solid ${C.ink}`, background: C.ink, color: C.white },
    red: { border: `1px solid ${C.red}`, background: C.white, color: C.red },
    ghost: {
      border: '1px solid transparent',
      background: 'transparent',
      color: C.ink2,
    },
  };
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: h,
        padding: `0 ${size === 'sm' ? 8 : 12}px`,
        borderRadius: 999,
        fontSize: size === 'sm' ? 11.5 : 12.5,
        whiteSpace: 'nowrap',
        cursor: onClick ? 'pointer' : 'default',
        fontFamily: 'inherit',
        lineHeight: 1,
        boxSizing: 'border-box',
        ...tones[tone],
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
export function Btn({
  children,
  kind = 'primary',
  onClick,
  disabled,
  style,
  size = 'md',
}: ButtonProps) {
  const h = size === 'sm' ? 30 : 36;
  const k = {
    primary: {
      background: C.ink,
      color: C.white,
      border: `1px solid ${C.ink}`,
      fontWeight: 600,
    },
    outline: {
      background: C.white,
      color: C.ink,
      border: `1px solid ${C.line2}`,
      fontWeight: 500,
    },
    ghost: {
      background: 'transparent',
      color: C.ink,
      border: '1px solid transparent',
      fontWeight: 500,
    },
    danger: {
      background: C.white,
      color: C.red,
      border: `1px solid ${C.red}`,
      fontWeight: 600,
    },
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        height: h,
        padding: `0 ${size === 'sm' ? 12 : 16}px`,
        borderRadius: 999,
        fontSize: size === 'sm' ? 12.5 : 13.5,
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.4 : 1,
        ...k,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
export const MonoTag = ({ children, style }: BasicProps) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      height: 20,
      padding: '0 6px',
      border: `1px solid ${C.line2}`,
      borderRadius: 4,
      fontFamily: MONO,
      fontSize: 11,
      color: C.ink,
      background: C.white,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {children}
  </span>
);
export const Card = ({ children, style }: BasicProps) => (
  <div
    style={{
      border: `1px solid ${C.line}`,
      borderRadius: 12,
      background: C.white,
      padding: '14px 16px',
      ...style,
    }}
  >
    {children}
  </div>
);
export const Ring = ({ size = 26 }: { size?: number }) => (
  <span
    aria-hidden="true"
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      border: `${Math.round(size * 0.27)}px solid ${C.ink}`,
      boxSizing: 'border-box',
      background: C.white,
      flexShrink: 0,
      display: 'inline-block',
    }}
  ></span>
);
export const Dot = ({
  color = C.ink,
  size = 7,
  ring,
}: {
  color?: string;
  size?: number;
  ring?: boolean;
}) => (
  <span
    aria-hidden="true"
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: ring ? C.white : color,
      border: ring ? `1.5px solid ${color}` : 'none',
      boxSizing: 'border-box',
      flexShrink: 0,
      display: 'inline-block',
    }}
  ></span>
);
export const SectionTitle = ({
  children,
  right,
}: BasicProps & { right?: ReactNode }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      margin: '4px 0 8px',
    }}
  >
    <span style={{ fontSize: 14, fontWeight: 600 }}>{children}</span>
    {right}
  </div>
);
export const Empty = ({ children }: BasicProps) => (
  <div
    style={{
      border: `1px solid ${C.line}`,
      borderRadius: 10,
      padding: '14px 12px',
      textAlign: 'center',
      color: C.ink3,
      fontSize: 12.5,
    }}
  >
    {children}
  </div>
);
export const tableHeaderStyle: CSSProperties = {
  textAlign: 'left',
  fontWeight: 500,
  color: C.ink2,
  fontSize: 12,
  padding: '9px 10px',
  background: C.sub,
  borderBottom: `1px solid ${C.line}`,
  position: 'sticky',
  top: 0,
  whiteSpace: 'nowrap',
  zIndex: 1,
};
export const tableCellStyle: CSSProperties = {
  padding: '9px 10px',
  borderBottom: `1px solid ${C.line}`,
  fontSize: 12.5,
  verticalAlign: 'top',
  lineHeight: 1.4,
};
export const Icon = {
  pen: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 13l1-3.5L11 2.5l2.5 2.5-7 7L3 13z" />
    </svg>
  ),
  gear: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="8" cy="8" r="2.2" />
      <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 1.6" />
    </svg>
  ),
  caret: (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <path d="M2 3.5h6L5 7z" />
    </svg>
  ),
};
