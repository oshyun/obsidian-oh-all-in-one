# 0h All In One Obsidian Plugin — 개발 가이드

## 기본 정보

| 항목 | 값 |
|---|---|
| 플러그인 ID | `oh-all-in-one` |
| 플러그인 이름 | `0h All In One` (UI 노출용, 정렬 목적으로 `0h`로 시작) |
| 작성자 | oshyun (``) |
| 버전 포맷 | `0.0.x` — 패치마다 최하위 숫자 증가 |
| 진입점 | `main.ts` → 빌드 결과: `main.js` |
| 배포 경로 | `$PLUGIN_DEPLOY_PATH/` |
| 모바일 지원 | `isDesktopOnly: false` |

## 버전 관리 규칙

> **소스 파일을 변경할 때마다 반드시 버전을 올린다.**

- 버전업 대상: `manifest.json`과 `package.json` **동시** 수정
- 빌드·배포 전이 아니라 **코드 수정과 같은 단계**에서 처리
- 버그 수정·기능 추가·설정 추가 등 모든 변경에 적용

## 빌드 및 배포

```bash
# nvm 활성화 후 빌드 (nvm은 매번 명시적으로 source 필요)
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && npm run build

# 배포
cp main.js styles.css manifest.json \
  $PLUGIN_DEPLOY_PATH/
```

### worktree에서 빌드할 때

worktree는 `node_modules`가 없으므로 빌드 전 symlink가 필요하다.
`tsconfig.json`도 같이 링크해야 tsc가 타입을 찾는다.

```bash
# 워크트리 생성 직후 한 번만 실행
ln -s $REPO_PATH/node_modules \
  ../<repo>-wt-<topic>/node_modules
ln -s $REPO_PATH/tsconfig.json \
  ../<repo>-wt-<topic>/tsconfig.json
```

`git worktree remove --force`로 제거해야 symlink가 남아도 경고 없이 삭제된다.

## 의존성

- `monkey-around` ^3.0.0 — Obsidian 내부 메서드 패치
- `ignore` ^7.0.5 — `.gitignore` 스타일 패턴 매칭

## 설정 인터페이스

```typescript
interface OhUtilsSettings {
  homeNoteEnabled: boolean;              // 홈 노트 활성화
  homeNotePath: string;                  // 홈 노트 경로 (vault 루트 기준)
  collapseChildrenEnabled: boolean;      // 하위 폴더 일괄 접기
  folderActionsEnabled: boolean;         // 폴더 액션 버튼
  folderActionsShowNewFile: boolean;
  folderActionsShowExpandAll: boolean;
  folderActionsShowCollapseAll: boolean;
  folderActionsShowPin: boolean;
  folderActionsShowDelete: boolean;
  pinEnabled: boolean;                   // 핀 고정
  pinnedPatterns: string;                // 줄바꿈 구분 .gitignore 패턴
  hideEnabled: boolean;                  // 파일 숨기기
  hidePatterns: string;                  // 줄바꿈 구분 .gitignore 패턴
  globalHotkeysEnabled: boolean;         // 글로벌 핫키 활성화
  globalHotkeys: GlobalHotkey[];         // 등록된 핫키 목록
  settingsSearchEnabled: boolean;        // 설정 검색창
  deleteEmptyNewNoteEnabled: boolean;    // 빈 새 노트 자동 삭제
  debugMode: boolean;                    // 디버그 로그
}

interface GlobalHotkey {
  id: string;           // Date.now().toString(36)
  accelerator: string;  // Electron 가속기 문자열 (예: CommandOrControl+Shift+N)
  commandId: string;    // Obsidian 명령어 ID
  commandName: string;  // 표시용 명령어 이름
}
```

---

## 기능 목록

설정 탭은 `setHeading()`으로 섹션을 구분한다. **1기능 = 1섹션** 규칙.

---

### 0. 빈 새 노트 자동 삭제 (Delete Empty New Note)

새로 만든 노트에 아무것도 입력하지 않고 다른 탭/파일로 이동하면 해당 노트를 자동으로 삭제한다.
삭제 직후 10초간 Notice가 표시되며 "되돌리기" 링크로 즉시 복원할 수 있다.

**구현 위치:** `main.ts` — `vault.on('create')`, `vault.on('modify')`, `vault.on('rename')`, `workspace.on('active-leaf-change')`

**동작 방식:**

- `vault.on('create')`: `.md` 파일 생성 시 `newlyCreatedFilePaths` Set에 경로 추가.
- `vault.on('modify')`: 파일 내용이 수정되면 Set에서 제거 (사용자가 뭔가 입력한 것으로 판단).
- `vault.on('rename')`: 파일명이 변경되면 Set에서 제거 (의도적 상호작용으로 판단).
- `workspace.on('active-leaf-change')`: 이전 활성 파일이 Set에 있으면 내용이 비어 있는지 확인 후 삭제.
  - 삭제 후 `Notice`(10초)를 띄우고, "되돌리기" 링크 클릭 시 동일 경로에 빈 파일 재생성 후 열기.
- `previousActiveFilePath`: active-leaf-change 시점에 이탈한 파일 경로를 추적하는 내부 필드.
  - `onLayoutReady()`에서 초기화.

**삭제 방식:** `app.fileManager.trashFile(file)` — 사용자의 "삭제된 파일" 설정(.trash / 시스템 휴지통)을 따른다.

**설정:**
- `deleteEmptyNewNoteEnabled: boolean` — 토글 (기본값 `true`, "일반" 탭 > 노트 섹션)

---

### 1. 핀 고정 (Pin)

파일/폴더를 각 폴더의 최상단에 고정 노출한다. 핀 아이콘이 파일 이름 앞에 표시된다.

**구현 위치:** `main.ts` — `patchFileExplorerSort()`, `applyPinIcons()`, `setupPinObserver()`, `rebuildPinFilter()`, `hasExactPinPattern()`

#### 핀 정렬

`monkey-around`로 `getSortedFolderItems`를 패치해 정렬 시 pinned 항목을 앞으로 이동시킨다.

```typescript
items = [...items.filter(isPinned), ...items.filter(i => !isPinned(i))];
```

`isPinned`는 `pinFilter.ignores(testPath)`로 판별한다.

#### 핀 아이콘 표시

- `applyPinIcons()`: `fileExplorer.fileItems`를 순회하며 pinned 항목 `item.el`에 `.oh-utils-pinned` 클래스를 추가하고, `titleEl` 앞에 `<span class="oh-utils-pin-icon">` + `setIcon(el, 'pin')` 삽입.
- `MutationObserver`로 파일 탐색기 DOM 변화를 감지해 `applyPinIcons()`를 재실행한다 (debounce 50ms).
- `clearPinDecorations()`: `.oh-utils-pin-icon` 요소 제거 + `.oh-utils-pinned` 클래스 제거.

#### 핀 고정/해제 UX

- `file-menu` 이벤트로 컨텍스트 메뉴에 "핀 고정" / "핀 해제" 항목을 추가한다.
- `hasExactPinPattern(path)`: `pinnedPatterns`의 줄 중 정확히 path와 일치하는 줄 존재 여부로 판별.
- 핀 고정: `pinnedPatterns` 끝에 경로 한 줄 추가.
- 핀 해제: 해당 줄 제거 후 `removePinIcon()` 호출.

#### 파일 삭제/이름 변경 동기화

- `vault.on('delete', ...)`: pinnedPatterns에서 해당 경로 줄 제거.
- `vault.on('rename', ...)`: pinnedPatterns에서 구 경로 → 신 경로로 교체.

**설정:**
- `pinEnabled: boolean` — 토글
- `pinnedPatterns: string` — textarea, `.gitignore` 형식, 줄바꿈 구분

**CSS (`styles.css`):**
- `.oh-utils-pin-icon`: 14px, accent color (`hsl(--accent-h, --accent-s, --accent-l)`), 세로형(rotate 없음)
- `.oh-utils-pinned + .nav-folder:not(.oh-utils-pinned)`: pinned/일반 항목 사이 구분선

---

### 2. 파일 숨기기 (Hide)

`.gitignore` 스타일 글로브 패턴에 매칭되는 파일/폴더를 파일 탐색기에서 숨긴다.

**구현 위치:** `main.ts` — `patchFileExplorerSort()`, `rebuildHideFilter()`, `hideFilter: Ignore | null`

**동작 방식:**
- `ignore` 패키지를 사용해 `hideFilter` 객체를 생성한다.
- `monkey-around`로 파일 탐색기 prototype의 `getSortedFolderItems` 메서드를 패치한다.
- 패치 안에서 결과 배열을 filter해 `hideFilter.ignores(testPath)` === true인 항목을 제거한다.
- 폴더는 `path + '/'`로 테스트해 디렉토리 패턴 (`_templates/`) 매칭을 지원한다.
- 숨기기가 핀보다 먼저 적용된다 (filter → sort 순서).

**패턴 형식:**
- `.gitignore` 규칙을 그대로 따른다.
- 예: `*.excalidraw.md`, `_templates/`, `.trash/`

**설정:**
- `hideEnabled: boolean` — 토글 (변경 시 `requestSort()` 호출)
- `hidePatterns: string` — textarea, 줄바꿈 구분, 모노스페이스 폰트

---

### 3. 홈 노트 (Home Note)

모든 탭을 닫으면 지정한 노트를 자동으로 연다.

**구현 위치:** `main.ts` — `onload()`의 `layout-change` 이벤트 핸들러

**동작 방식:**
- `app.workspace.on('layout-change', ...)` 이벤트를 등록한다.
- `iterateAllLeaves`로 `.file`을 가진 리프가 하나도 없을 때 `homeNotePath`로 이동한다.
- `getLeavesOfType('markdown')` 대신 `iterateAllLeaves`를 쓴다 — PDF·캔버스 등 비마크다운 파일만 열려 있을 때도 홈 노트를 열지 않기 위함.
- `openingHomeNote` 플래그로 재진입(홈 노트가 열리는 동안 또 layout-change가 발생하는 루프)을 방지한다.

**설정:**
- `homeNoteEnabled: boolean` — 토글
- `homeNotePath: string` — Vault 루트 기준 경로 (예: `Home.md`, `Daily/Home.md`)

---

### 5. 하위 폴더 일괄 접기 (Collapse Children)

폴더의 하위에 펼쳐진 모든 폴더 트리를 한 번에 닫는다.

**구현 위치:** `main.ts` — `onload()`의 `click` DOM 이벤트 핸들러, `file-menu` 이벤트 핸들러, `collapseDescendants()` 메서드

**동작 방식:**

*데스크탑:* `Alt`(Mac: `⌥ Opt`) 키를 누른 채 폴더를 클릭하면 실행된다.
- `document` 레벨 `click` 이벤트에서 `event.altKey` 확인 → `.nav-folder-title` 클릭 여부 확인
- `.nav-folder` 요소를 찾아 `collapseFolderByEl()` 호출

*모바일/컨텍스트 메뉴:* 파일/폴더 우클릭(모바일: 길게 누르기) 시 메뉴에 "하위 폴더 전부 닫기" 항목 추가.
- `app.workspace.on('file-menu', ...)` 이벤트에서 `TFolder` 인스턴스일 때만 메뉴 항목 추가
- `collapseFolderByPath()` 호출

*핵심 메서드 `collapseDescendants(parentPath, fileItems)`:*
- `fileExplorer.fileItems` Record를 순회한다.
- 경로가 `parentPath` 자신이거나 `parentPath + '/'`로 시작하는 항목에 `item.setCollapsed(true, false)` 호출.
- `parentPath`가 빈 문자열이면 전체 트리를 접는다.

**설정:**
- `collapseChildrenEnabled: boolean` — 토글
- 설명 문구는 플랫폼에 따라 다름 (`Platform.isMobile` 분기)

---

### 6. 글로벌 핫키 (Global Hotkeys)

Obsidian이 백그라운드 상태일 때도 시스템 단축키로 Obsidian 명령어를 실행한다.
**데스크탑 전용** (`Platform.isDesktop` 체크).

**구현 위치:** `main.ts` — `registerGlobalHotkeys()`, `unregisterGlobalHotkeys()`, `GlobalHotkeyModal`, `CommandSuggest`, `keyEventToAccelerator()`, `displayAccelerator()`

#### 등록/해제

- `require('electron').remote.globalShortcut` API 사용.
- `registerGlobalHotkeys()`: 각 hotkey에 대해 `remote.globalShortcut.register(accelerator, callback)` 호출.
  - 콜백: 창이 숨겨져 있으면 `win.show()` + `win.focus()`, 이후 명령어 실행.
  - 명령어 실행: `cmd.checkCallback` 있으면 `cmd.checkCallback(false)`, 없으면 `cmd.callback()`.
- `unregisterGlobalHotkeys()`: 등록된 모든 핫키를 해제.

#### 단축키 녹화 모달 (`GlobalHotkeyModal`)

1. **단축키 녹화**: 버튼 클릭 시 `is-recording` 상태로 전환 → `document.addEventListener('keydown', ...)` capture 단계에서 키 입력 감지 → `keyEventToAccelerator(e)` 호출.
2. **명령어 선택**: `CommandSuggest` (AbstractInputSuggest 확장) — 입력 쿼리로 `app.commands.commands` 필터링, 최대 20개 표시.
3. **저장**: accelerator + commandId 모두 입력된 경우에만 저장 허용.

#### 가속기 변환

`keyEventToAccelerator(e: KeyboardEvent) → string`
- `ctrlKey || metaKey` → `CommandOrControl`
- `altKey` → `Alt`
- `shiftKey` → `Shift`
- 특수키 맵 (`ArrowUp` → `Up`, `Enter` → `Return` 등)

`displayAccelerator(acc: string) → string`
- Mac: `CommandOrControl` → `⌘`, `Shift` → `⇧`, `Alt` → `⌥`, 구분자 없음
- Windows/기타: `CommandOrControl` → `Ctrl`, 구분자 `+`

**CSS (`styles.css`):**
- `.oh-utils-key-recorder`: dashed border, `is-recording` 상태에서 pulse 애니메이션
- `.oh-utils-hotkey-row`: 등록된 핫키 한 줄 (키 배지 + 명령어 이름 + 삭제 버튼)
- `.oh-utils-key-badge`: `<kbd>` 스타일

---

## 핵심 내부 구현 패턴

### 파일 탐색기 접근

```typescript
private getFileExplorer(): any {
  return this.app.workspace.getLeavesOfType('file-explorer')[0]?.view;
}
```

`internalPlugins`이나 `app.fileExplorer` 방식은 작동하지 않는다.

### getSortedFolderItems 패치

파일 탐색기 prototype을 `monkey-around`로 패치해 hide와 pin 두 기능을 한 곳에서 처리한다.
패치 순서: **숨기기(filter) → 핀 정렬(sort)**. `onunload()`에서 `sortPatcher()`를 호출해 반드시 복구한다.

### 핀 아이콘 삽입 위치

```typescript
// item.el.firstChild = 타이틀 엘리먼트 (.nav-folder-title 또는 .nav-file-title)
const titleEl = item.el.firstChild as HTMLElement;
titleEl.insertBefore(pinIconEl, titleEl.firstChild);
// titleEl.firstChild = collapse indicator(▶) → 핀 아이콘을 그 앞에 삽입
```

### 데이터 마이그레이션

이전 버전에서 `pinnedPaths: string[]`로 저장하던 것을 `pinnedPatterns: string`으로 변환한다.
`loadSettings()`에서 COMPAT 처리 (코드 내 `COMPAT` 태그 참조).

---

## 파일 구조

```
obsidian-oh-all-in-one/
├── main.ts          # 전체 플러그인 코드 (단일 파일)
├── styles.css       # 핀 아이콘, 글로벌 핫키 모달 스타일
├── manifest.json    # 플러그인 메타데이터
├── package.json     # 의존성
├── tsconfig.json    # TypeScript 설정
├── esbuild.config.mjs
└── CLAUDE.md        # 이 문서
```

## 관련 경로

- **Obsidian Vault**: `$VAULT_PATH`
- **Bot 레포**: `$BOT_REPO_PATH` (vault와 연동 예정)
- **플러그인 배포 경로**: `$PLUGIN_DEPLOY_PATH/`
