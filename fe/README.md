# React 디자인 스타터

React 19 + TypeScript strict + Vite + Node.js 24로 디자인 개발을 시작하는 기본 프로젝트입니다. 색상·서체·크기 토큰, 범용 UI 컴포넌트, 빈 3열 작업 레이아웃을 제공합니다.

## 실행

```bash
nvm use # nvm을 사용하는 경우, 최초 설치는 nvm install
npm ci
npm run dev
```

`http://localhost:5173`에서 빈 화면으로 시작합니다. 기본 레이아웃은 원본 디자인처럼 데스크톱 최소 너비 1280px를 사용합니다. Pretendard와 JetBrains Mono는 외부 폰트 URL에서 가져오며 시스템 폰트로 대체할 수 있습니다.

## 구조

```text
src/
├── main.tsx                         # React createRoot + StrictMode
├── App.tsx                          # 빈 시작 화면
├── components/
│   ├── index.ts                     # 공통 컴포넌트 공개 진입점
│   ├── primitives.tsx               # 버튼, 카드, 태그 등 범용 UI
│   └── layout/
│       ├── WorkspaceLayout.tsx      # 사이드바 / 작업 영역 / 캔버스
│       ├── Sidebar.tsx              # 제목, 본문, 푸터 슬롯
│       └── ContentPanel.tsx         # 제목, 도구, 본문, 푸터 슬롯
├── design/
│   ├── tokens.json                  # 색상, 폰트, 크기, 배치 토큰
│   └── tokens.ts                    # 토큰 export
└── styles/global.css                # 전역 스타일
```

## 디자인 사용

`App.tsx`의 각 영역에 직접 콘텐츠를 배치합니다. `WorkspaceLayout`의 `canvas` 슬롯을 생략하면 2열 레이아웃을 사용할 수 있습니다. 레이아웃 컴포넌트는 ReactNode 슬롯만 받으며 데이터 모델과 무관합니다.

```tsx
import { Btn, Card, Pill } from './components';
import tokens, { C, FONT, MONO } from './design/tokens';
```

공통 UI: `Pill`, `Btn`, `MonoTag`, `Card`, `Ring`, `Dot`, `SectionTitle`, `Empty`, `Icon`. 표 스타일은 `tableHeaderStyle`, `tableCellStyle`로 제공합니다. 디자인 토큰은 `src/design/tokens.json`에서 수정합니다. `map` 항목도 색상 토큰만 포함합니다.

## 개발 명령

| 명령                   | 용도                         |
| ---------------------- | ---------------------------- |
| `npm run dev`          | 개발 서버                    |
| `npm run typecheck`    | TypeScript 검사              |
| `npm run build`        | 타입 검사 후 프로덕션 빌드   |
| `npm run preview`      | 빌드 미리보기                |
| `npm run format`       | 코드 포맷 정리               |
| `npm run format:check` | 포맷 검사                    |
| `npm run test:e2e`     | 빈 시작 화면의 브라우저 검사 |

```bash
npx playwright install chromium
npm run build
npm run test:e2e
```

GitHub Actions에서 Node 24로 포맷, 빌드, 시작 화면을 확인합니다. 업무 데이터, 시뮬레이션, 데이터 생성기, 업무별 타입, 원본 시연 자료는 프로젝트에 포함하지 않습니다.
