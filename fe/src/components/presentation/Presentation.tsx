import { useEffect, useState } from 'react';
import presentation from '../../../public/presentation/manifest.json';
import './presentation.css';

export function Presentation({ onFinish }: { onFinish: () => void }) {
  const [index, setIndex] = useState(0);
  const [loadedPage, setLoadedPage] = useState<number | null>(null);
  const [failedPage, setFailedPage] = useState<number | null>(null);
  const slide = presentation.slides[index];
  const ready = loadedPage === slide.page;
  const failed = failedPage === slide.page;
  const last = index === presentation.slides.length - 1;
  const previous = () => setIndex((value) => Math.max(0, value - 1));
  const next = () => {
    if (!ready) return;
    if (last) onFinish();
    else setIndex((value) => value + 1);
  };

  useEffect(() => {
    const upcoming = presentation.slides[index + 1];
    if (upcoming) {
      const image = new Image();
      image.src = upcoming.image;
    }
  }, [index]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat)
        return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        previous();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [index, ready, onFinish]);

  return (
    <main className="presentation-shell" data-testid="presentation">
      <header className="presentation-header">
        <div className="presentation-brand">
          <span aria-hidden="true">온</span>
          <h1>
            온 마을 <small>서비스 소개</small>
          </h1>
        </div>
        <span
          className="presentation-page-count"
          aria-live="polite"
          data-testid="presentation-progress"
        >
          {index + 1} / {presentation.slides.length}
        </span>
      </header>
      <section
        className="presentation-stage"
        aria-label="발표자료"
        aria-busy={!ready && !failed}
      >
        <figure>
          <img
            key={slide.page}
            data-testid="presentation-slide"
            data-pdf-page={slide.page}
            src={slide.image}
            width={slide.width}
            height={slide.height}
            alt={`발표자료 ${index + 1}장: ${slide.title}`}
            decoding="async"
            fetchPriority="high"
            onLoad={() => setLoadedPage(slide.page)}
            onError={() => setFailedPage(slide.page)}
          />
          <figcaption className="presentation-sr-only">{slide.text}</figcaption>
        </figure>
        {!ready && !failed && (
          <p className="presentation-loading" role="status">
            발표자료를 불러오는 중입니다.
          </p>
        )}
        {failed && (
          <p className="presentation-loading" role="alert">
            발표자료를 불러오지 못했습니다. 페이지를 새로고침해 주세요.
          </p>
        )}
      </section>
      <footer className="presentation-footer">
        <span className="presentation-hint">
          한 장씩 살펴본 뒤 시뮬레이션을 확인하세요.
        </span>
        <nav aria-label="발표자료 페이지 이동">
          <button disabled={index === 0} onClick={previous}>
            ← 이전
          </button>
          <button
            className="presentation-next"
            disabled={!ready}
            onClick={next}
          >
            {last ? '시뮬레이션 보기 →' : '다음 →'}
          </button>
        </nav>
      </footer>
    </main>
  );
}
