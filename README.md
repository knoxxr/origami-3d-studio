# 종이공방 3D (Origami 3D Studio)

알려진 종이접기 기술을 3D로 구현하고, 직접 만들거나 선택한 작품의 접기 과정 전체를 애니메이션 GIF로 내보내는 3D 종이접기 프로그램입니다.

## 주요 기능

### 1. 알려진 종이접기 기술 3D 구현 (8종)
- **계곡 접기 (Valley Fold)** — 파란 파선 가이드, 앞쪽 접기
- **산 접기 (Mountain Fold)** — 빨간 일점쇄선 가이드, 뒤쪽 접기
- **방석 접기 (Blintz Fold)** — 4모서리 중심 모으기
- **계단 접기 (Pleat Fold)** — 평행 계곡+산 아코디언 주름
- **눌러 접기 (Squash Fold)** — 3D 강체 기구학(등거리 보존) 기반 주머니 벌려 누르기
- **꽃잎 접기 (Petal Fold)** — 학 기본형(Bird Base) 3D 들어 올리기 및 양옆 동시 접기
- **안쪽 뒤집어 접기 (Inside Reverse Fold)** — 능선 벌리기 후 끝부분 내부 반전 3D 기구학
- **토끼귀 접기 (Rabbit Ear Fold)** — 내심 각이등분선 3D 핀치 및 귀 눕히기

### 2. 완성 작품 3D 단계별 시뮬레이션 (5종)
- **종이학 (Traditional Paper Crane, 10단계)**
- **종이비행기 다트형 (Classic Dart Airplane, 7단계)**
- **종이컵 (Origami Drinking Cup, 5단계)**
- **종이 투구 (Samurai Kabuto, 6단계)**
- **종이 하트 (Origami Heart, 8단계)**

### 3. 자유 창작 스튜디오 (Free Fold Studio)
- 3D 캔버스 위 꼭짓점·중점·중심 **자동 스냅 3클릭 접기** (시작점 -> 끝점 -> 접을 영역 선택)
- 계곡/산/예비선/계단 접기, 접기 각도(15°~180°), 전체 겹 / 맨 위 겹만 선택
- 원클릭 기법 매크로, 종이 뒤집기/회전, 실행 취소/다시 실행, 실시간 **2D 전개도(Crease Pattern)** 동기화

### 4. 과정 전체 애니메이션 GIF 내보내기
- 외부 서버나 CDN 없이 브라우저 내 **순수 JavaScript GIF89a 인코더** (Median-Cut 256색 양자화 + LZW 압축 + 무한 루프)로 직접 생성
- 시작(정사각형 종이)부터 모든 접기 단계 + 선택적 **완성작 360° 3D 회전 피날레**까지 한 번에 인코딩
- 해상도(480×360 / 640×480 / 800×600), FPS, 속도, 카메라 연출, 단계 자막 오버레이 설정 및 즉시 미리보기·다운로드

## 프로젝트 구조
- `src/math3d.js` — 3D 벡터 연산, Rodrigues 축 회전, Sutherland-Hodgman 평면 다각형 분할, 투영 카메라
- `src/planarEngine.js` — 평면 종이접기 커널, 레이어 적층 정렬, 계단 접기, 스냅 포인트 추출
- `src/kinematicModels.js` — 8종 종이접기 기술 및 5종 완성 작품 3D 강체 기구학 모델
- `src/renderer3d.js` — 위상 평면 깊이 정렬(Topological Painter's Sort), 양면 한지 셰이딩, 2D 전개도 및 GIF 자막 렌더러
- `src/gifEncoder.js` — 순수 JS GIF89a 인코더
- `src/app.js` — 인터랙티브 스튜디오 UI 및 GIF 내보내기 컨트롤러
- `build.js` — 단일 자체 완결 HTML 번들러 (`dist/origami_3d_studio.html`)
- `test/verify.mjs` — 기하학·등거리성·GIF 인코더 자동 검증 스크립트
