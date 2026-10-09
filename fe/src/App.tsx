import {
  ContentPanel,
  Empty,
  Ring,
  Sidebar,
  WorkspaceLayout,
} from './components';

export default function App() {
  return (
    <WorkspaceLayout
      sidebar={
        <Sidebar
          title={
            <>
              <Ring size={24} />
              디자인 스타터
            </>
          }
        >
          <Empty>메뉴 영역</Empty>
        </Sidebar>
      }
      content={
        <ContentPanel label="작업 영역" title="작업 영역" divider>
          <Empty>아직 콘텐츠가 없습니다</Empty>
        </ContentPanel>
      }
      canvas={
        <ContentPanel label="캔버스" title="캔버스">
          <Empty>아직 선택한 항목이 없습니다</Empty>
        </ContentPanel>
      }
    />
  );
}
