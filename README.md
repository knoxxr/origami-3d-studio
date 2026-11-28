# 종이공방 3D (Origami 3D Studio)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMinaryHub%2Forigami-3d-studio)

알려진 종이접기 기술 **전 분야 20종**을 3D 강체 기구학으로 구현하고, 직접 만들거나 선택한 작품의 접기 과정 전체를 애니메이션 GIF로 내보내는 3D 종이접기 프로그램입니다.

## Vercel 배포
- 상단 **Deploy with Vercel** 버튼을 클릭하거나 [Vercel Import 페이지](https://vercel.com/new/import?s=https://github.com/MinaryHub/origami-3d-studio)에서 `MinaryHub/origami-3d-studio` 저장소를 선택하면 `vercel.json` 설정(`node build.js` -> `public/`)으로 자동 빌드·배포됩니다.

## 스크린샷

### 데스크톱
| 3D 종이학 & 2D 전개도 | 미우라 접기 (테셀레이션) |
| :---: | :---: |
| ![데스크톱 종이학](./screenshots/desktop-library-crane.png) | ![미우라 접기](./screenshots/desktop-miura-ori.png) |

| 직관적 드래그 종이접기 | 과정 전체 GIF 내보내기 |
| :---: | :---: |
| ![직접 접기 드래그](./screenshots/desktop-free-drag.png) | ![GIF 내보내기 모달](./screenshots/desktop-gif-modal.png) |

### 모바일 (터치 UI & 직관적 끌어접기 · 펼치기)
| 모바일 3D 뷰어 | 슬라이드업 바텀 시트 | 모서리 끌어접기 | 접힌 겹 끌어 펼치기 |
| :---: | :---: | :---: | :---: |
| ![모바일 종이학](./screenshots/mobile-library-crane.png) | ![모바일 바텀 시트](./screenshots/mobile-bottom-sheet.png) | ![모바일 끌어접기](./screenshots/mobile-free-drag.png) | ![모바일 끌어 펼치기](./screenshots/mobile-free-unfold.png) |

## 주요 기능

### 1. 알려진 종이접기 기술 3D 구현 (총 20종)
- **기본 (5종)**: 계곡 접기, 산 접기, 접었다 펴기(기준선 격자), 방석 접기, 계단 접기
- **입체 · 기본형 · 반전 (8종)**: 사각 주머니 접기, 삼각 주머니 접기, 눌러 접기, 꽃잎 접기, 안쪽 뒤집어 접기, 바깥쪽 뒤집어 접기, 토끼귀 접기, 크림프 접기
- **고급 · 싱크 · 입체 성형 · 테셀레이션 (7종)**: 회전 접기(Swivel), 열린 싱크 접기, 닫힌 싱크 접기, 끼워 잠그기(Pocket Tuck), 입체 부풀리기(3D Inflate), 미우라 접기(Miura-ori), 스퀘어 트위스트(Square Twist)

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

### 4. 실제 종이 같은 그래픽 & 손으로 접는 조작감
- **손끝을 따라오는 모서리**: 잡은 모서리가 3D 공간에서 정확히 손가락(커서) 아래에 위치하도록, 들어 올린 모서리 위치로부터 접는 선(수직이등분 평면 ∩ 종이 평면)과 접힘 각도를 실시간으로 역산
- **손 속도에 따른 들림**: 빠르게 옮기면 종이를 높이 들고, 멈추면 낮게 내려앉으며, 스냅 지점 근처에서는 목표점 위로 자석처럼 끌려가 살짝 떠 있음
- **놓으면 꾹 눌러 접기**: 손을 떼면 모서리가 손끝 바로 아래로 내려앉고(중력형 가속), 접힘선을 따라 빛이 훑고 지나가는 크리스 프레스 효과 + 진동(모바일) + 종이 효과음
- **젖혀서 펼치기**: 접힌 모서리를 잡으면 접힐 때 지나온 원호를 그대로 따라 젖혀지며, 절반 이상 젖히고 놓으면 펼쳐지고 덜 젖히면 접힌 자국 때문에 다시 접혀 돌아감
- **부드러운 종이 휨**: 접히는 도중의 날개가 경첩처럼 꺾이지 않고 접힘선 근처에서 원통형으로 둥글게 말림(호 길이 보존), 다 눌리면 날카로운 접힘선으로 수렴
- **화지(和紙) 섬유 질감**: 절차적으로 생성한 타일형 섬유·결 텍스처를 UV에 고정해 접기·뒤집기·회전 시에도 종이에 붙어 움직임
- **높이 기반 그림자**: 들린 날개는 아래 종이에 투영 그림자를 드리우며, 높이 들수록 그림자가 넓고 부드럽게 퍼짐
- **종이 효과음**: 외부 파일 없이 Web Audio로 합성한 집어 들기·스치는 소리(손 속도 연동)·접는 소리 (상단 `Sound` 토글로 끄기)
- **촉감 있는 버튼**: 모든 컨트롤이 눌릴 때 두꺼운 종이처럼 살짝 눌려 들어갔다가 튀어나옴

### 5. 과정 전체 애니메이션 GIF 내보내기
- 외부 서버나 CDN 없이 브라우저 내 **순수 JavaScript GIF89a 인코더** (Median-Cut 256색 양자화 + LZW 압축 + 무한 루프)로 직접 생성
- 시작(정사각형 종이)부터 모든 접기 단계 + 선택적 **완성작 360° 3D 회전 피날레**까지 한 번에 인코딩
- 해상도(480×360 / 640×480 / 800×600), FPS, 속도, 카메라 연출, 단계 자막 오버레이 설정 및 즉시 미리보기·다운로드

## 프로젝트 구조
- `src/math3d.js` — 3D 벡터 연산, Rodrigues 축 회전, Sutherland-Hodgman 평면 다각형 분할, 투영 카메라
- `src/planarEngine.js` — 평면 종이접기 커널, 레이어 적층 정렬, 계단 접기, 스냅 포인트 추출, 원통형 종이 휨 및 직접 조작용 진행도 지정
- `src/kinematicModels.js` — 8종 종이접기 기술 및 5종 완성 작품 3D 강체 기구학 모델
- `src/renderer3d.js` — 위상 평면 깊이 정렬(Topological Painter's Sort), 양면 한지 셰이딩, UV 고정 섬유 질감, 높이 기반 날개 그림자, 접힘선 프레스 효과, 2D 전개도 및 GIF 자막 렌더러
- `src/gifEncoder.js` — 순수 JS GIF89a 인코더
- `src/paperAudio.js` — Web Audio 절차적 종이 효과음 (바스락 · 접는 소리 · 스냅)
- `src/app.js` — 인터랙티브 스튜디오 UI 및 GIF 내보내기 컨트롤러
- `build.js` — 단일 자체 완결 HTML 번들러 (`dist/origami_3d_studio.html`)
- `test/verify.mjs` — 기하학·등거리성·GIF 인코더 자동 검증 스크립트
