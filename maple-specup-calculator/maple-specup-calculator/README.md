# 메이플스토리 스펙업 가성비 계산기

장비별 다음 스타포스 강화 1단계의 비용을 **최종데미지 1%당 메소**로 환산해 가성비 순으로 정렬합니다.

```
maple-specup-calculator/
├── api/
│   └── character.js      # Vercel 서버리스 함수: 닉네임 → ocid → 착용 장비 (API Key는 여기서만 사용)
├── public/
│   ├── index.html
│   ├── css/
│   │   └── style.css     # 다크 테마 + 모바일 카드형 레이아웃
│   └── js/
│       ├── data.js       # ★ 하드코딩 데이터 (최종뎀 상승량, 직작 기댓값) — 여기만 고치면 됨
│       ├── calc.js       # 계산 로직 (렙제 구간 매칭, 메소 파싱/포맷)
│       └── app.js        # UI: 검색, 로딩, 모드 전환, 실시간 정렬
├── .env                  # 로컬용 API Key (Git 제외)
├── .env.example
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

## 로컬 실행

```bash
npm i -g vercel
vercel dev          # .env 의 NEXON_API_KEY 를 자동으로 읽음 → http://localhost:3000
```

## 배포

1. GitHub에 push (`.env`는 `.gitignore`로 제외됨)
2. Vercel에서 Import → **Settings → Environment Variables** 에 `NEXON_API_KEY` 추가
3. Deploy

## 데이터 수정

`public/js/data.js` 의 `EXPECTED_COST` 에서 `null` 자리에 메소 값을 넣으면 모드 B에 바로 반영됩니다.
새 강화 구간(예: 21→22성)은 `STAR_STEPS`에 한 줄 추가 후 두 테이블에 값을 채우세요.

## API 흐름

| 단계 | 엔드포인트 | 파라미터 |
|---|---|---|
| 1 | `GET /maplestory/v1/id` | `character_name` |
| 2 | `GET /maplestory/v1/character/item-equipment` | `ocid` (date 생략 시 최신) |

헤더: `x-nxopen-api-key: <API Key>`
