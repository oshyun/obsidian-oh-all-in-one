import {
	AbstractInputSuggest,
	App,
	debounce,
	MarkdownView,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	setIcon,
	SettingDefinitionItem,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
} from 'obsidian';
import { around } from 'monkey-around';
import ignore, { Ignore } from 'ignore';

interface GlobalHotkey {
	accelerator: string;
	commandId: string;
	commandName: string;
}

interface OhUtilsSettings {
	homeNoteEnabled: boolean;
	homeNotePath: string;
	collapseChildrenEnabled: boolean;
	folderActionsEnabled: boolean;
	folderActionsShowNewFile: boolean;
	folderActionsShowExpandAll: boolean;
	folderActionsShowCollapseAll: boolean;
	folderActionsShowPin: boolean;
	folderActionsShowDelete: boolean;
	folderActionsShowCopyPath: boolean;
	pinEnabled: boolean;
	pinnedPatterns: string;
	hideEnabled: boolean;
	hidePatterns: string;
	globalHotkeysEnabled: boolean;
	globalHotkeys: GlobalHotkey[];
	deleteEmptyNewNoteEnabled: boolean;
	noDuplicateTabsEnabled: boolean;
	mobileOpenInNewTabEnabled: boolean;
	desktopOpenInNewTabEnabled: boolean;
	tabListEnabled: boolean;
	minimizeOnEscapeEnabled: boolean;
	minimizeOnEscapePressCount: number;
	debugMode: boolean;
}

const DEFAULT_SETTINGS: OhUtilsSettings = {
	homeNoteEnabled: false,
	homeNotePath: '',
	collapseChildrenEnabled: true,
	folderActionsEnabled: false,
	folderActionsShowNewFile: true,
	folderActionsShowExpandAll: true,
	folderActionsShowCollapseAll: true,
	folderActionsShowPin: true,
	folderActionsShowDelete: false,
	folderActionsShowCopyPath: true,
	pinEnabled: true,
	pinnedPatterns: '',
	hideEnabled: false,
	hidePatterns: '',
	globalHotkeysEnabled: false,
	globalHotkeys: [],
	deleteEmptyNewNoteEnabled: true,
	noDuplicateTabsEnabled: true,
	mobileOpenInNewTabEnabled: true,
	desktopOpenInNewTabEnabled: false,
	tabListEnabled: true,
	minimizeOnEscapeEnabled: true,
	minimizeOnEscapePressCount: 3,
	debugMode: false,
};

// Esc 연속 입력 판정 윈도우 (ms) — keydown 타임아웃과 설정 설명 문구가 함께 참조한다
const ESCAPE_PRESS_WINDOW_MS = 400;

export default class OhUtilsPlugin extends Plugin {
	settings: OhUtilsSettings;
	private openingHomeNote = false;
	private sortPatcher: (() => void) | null = null;
	private leafOpenFilePatcher: (() => void) | null = null;
	private tabListPanelEl: HTMLElement | null = null;
	private tabListBackdropEl: HTMLElement | null = null;
	private tabListHeaderButtonEl: HTMLElement | null = null;
	private tabListIsOpen = false;
	private tabListAttachedToContainerEl: HTMLElement | null = null;
	private tabListLeafOrder: string[] = [];
	private pinObserver: MutationObserver | null = null;
	private debouncedApplyExplorer = debounce(() => { this.applyPinIcons(); this.applyFolderActionButtons(); }, 50, true);
	private pinFilter: Ignore | null = null;
	private hideFilter: Ignore | null = null;
	private newlyCreatedFilePaths = new Set<string>();
	private previousActiveFilePath: string | null = null;
	private escapePressCount = 0;
	private escapePressTimer: number | null = null;
	private escapeIndicatorEl: HTMLElement | null = null;

	log(...args: unknown[]) {
		if (this.settings.debugMode) console.log('[oh-utils]', ...args);
	}

	private showEscapeIndicator(count: number) {
		if (!this.escapeIndicatorEl) {
			this.escapeIndicatorEl = document.body.createDiv({ cls: 'oh-aio-escape-indicator' });
		}
		const requiredPressCount = this.settings.minimizeOnEscapePressCount;
		const filled = '●'.repeat(count);
		const empty = '○'.repeat(requiredPressCount - count);
		this.escapeIndicatorEl.setText(`Esc ${filled}${empty}`);
		this.escapeIndicatorEl.addClass('is-visible');
	}

	private hideEscapeIndicator() {
		this.escapeIndicatorEl?.removeClass('is-visible');
	}

	private resetEscapePresses() {
		this.escapePressCount = 0;
		if (this.escapePressTimer !== null) {
			window.clearTimeout(this.escapePressTimer);
			this.escapePressTimer = null;
		}
		this.hideEscapeIndicator();
	}

	async onload() {
		await this.loadSettings();

		// 마지막 탭 닫을 때 홈 노트로 이동
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (!this.settings.homeNoteEnabled || !this.settings.homeNotePath) return;
				if (this.openingHomeNote) return;

				// iterateRootLeaves: 메인 영역 리프만 순회 (사이드바 패널 제외).
				// getLeavesOfType('markdown')은 PDF·캔버스·그래프뷰 등 비마크다운을 무시해
				// 그 파일만 열려 있을 때도 홈 노트를 강제로 열어 버리므로 사용하지 않는다.
				const homeNoteName = normalizePath(this.settings.homeNotePath);
				let hasNonHomeNoteFile = false;
				let existingHomeNoteLeaf: any = null;
				this.app.workspace.iterateRootLeaves((leaf) => {
					const leafFile = (leaf.view as any)?.file;
					if (leafFile) {
						if (leafFile.path === homeNoteName) {
							existingHomeNoteLeaf = leaf;
						} else {
							hasNonHomeNoteFile = true;
						}
						return;
					}
					// .file 없는 뷰(그래프뷰 등)도 비어있지 않으면 콘텐츠로 간주한다.
					if (!hasNonHomeNoteFile && leaf.view?.getViewType?.() !== 'empty') {
						hasNonHomeNoteFile = true;
					}
				});
				this.log('[home-note] layout-change, has non-home-note file:', hasNonHomeNoteFile, 'home note leaf:', !!existingHomeNoteLeaf);
				if (hasNonHomeNoteFile) return;

				if (existingHomeNoteLeaf) {
					this.log('[home-note] home note already open → activating existing tab');
					this.app.workspace.setActiveLeaf(existingHomeNoteLeaf, { focus: true });
					return;
				}

				this.log('[home-note] all tabs closed → opening:', this.settings.homeNotePath);
				this.openingHomeNote = true;
				this.app.workspace
					.openLinkText(homeNoteName, '')
					.finally(() => { this.openingHomeNote = false; });
			})
		);

		// 데스크탑: Opt/Alt+클릭으로 하위 폴더 일괄 접기
		this.registerDomEvent(document, 'click', (event: MouseEvent) => {
			if (!this.settings.collapseChildrenEnabled) return;
			if (!event.altKey) return;

			const target = event.target as HTMLElement;
			if (!target.closest('.nav-folder-title')) return;

			const navFolderEl = target.closest('.nav-folder') as HTMLElement | null;
			if (!navFolderEl) return;

			event.preventDefault();
			event.stopPropagation();

			this.log('[collapse] Alt+click on folder');
			this.collapseFolderByEl(navFolderEl);
		}, true);

		// 컨텍스트 메뉴: 하위 폴더 전부 닫기 + 핀 고정/해제
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, abstractFile) => {
				if (this.settings.collapseChildrenEnabled && abstractFile instanceof TFolder) {
					menu.addItem(item => {
						item
							.setTitle('하위 폴더 전부 닫기')
							.setIcon('chevrons-down-up')
							.onClick(() => {
								this.log('[collapse] context menu → collapse:', abstractFile.path);
								this.collapseFolderByPath(abstractFile.path);
							});
					});
				}

				if (!this.settings.pinEnabled) return;

				const isExplorerPinned = this.hasExactPinPattern(abstractFile.path);
				menu.addItem(item => {
					item
						.setTitle(isExplorerPinned ? '파일 탐색기 핀 해제' : '파일 탐색기 핀 고정')
						.setIcon(isExplorerPinned ? 'pin-off' : 'pin')
						.onClick(async () => {
							this.log('[pin]', isExplorerPinned ? 'unpin explorer:' : 'pin explorer:', abstractFile.path);
							await this.setPinned(abstractFile.path, !isExplorerPinned);
						});
				});

			})
		);

		// 파일 삭제/이름 변경 시 pinnedPatterns 동기화
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				this.newlyCreatedFilePaths.delete(file.path);
				if (this.hasExactPinPattern(file.path)) {
					this.log('[pin] vault delete → remove from pinnedPatterns:', file.path);
					this.settings.pinnedPatterns = this.removePatternLine(this.settings.pinnedPatterns, file.path);
					this.rebuildPinFilter();
					this.requestSort();
					this.saveSettings();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (this.hasExactPinPattern(oldPath)) {
					this.log('[pin] vault rename → update pinnedPatterns:', oldPath, '→', file.path);
					this.settings.pinnedPatterns = this.renamePatternLine(this.settings.pinnedPatterns, oldPath, file.path);
					this.rebuildPinFilter();
					this.saveSettings();
				}
			})
		);

		// 빈 새 노트 자동 삭제
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				if (this.openingHomeNote) return;
				// 생성 시점에 이미 내용이 있는 파일(동기화·복사 등)은 빈 노트 후보가 아니므로
				// 추적하지 않는다. 추적하면 한 번도 열리지 않은 채 Set에 영구 잔존한다.
				// stat.size는 메타데이터 캐시에서 읽으므로 디스크 I/O가 없다.
				if (file.stat.size !== 0) return;
				this.newlyCreatedFilePaths.add(file.path);
				this.log('[new-note-cleanup] tracking:', file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (this.newlyCreatedFilePaths.delete(file.path)) {
					this.log('[new-note-cleanup] modified, stopped tracking:', file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (this.newlyCreatedFilePaths.delete(oldPath)) {
					this.log('[new-note-cleanup] renamed, stopped tracking:', oldPath);
				}
			})
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', async () => {
				if (!this.settings.deleteEmptyNewNoteEnabled) return;

				const leavingPath = this.previousActiveFilePath;
				this.previousActiveFilePath = this.app.workspace.getActiveFile()?.path ?? null;

				if (!leavingPath || !this.newlyCreatedFilePaths.has(leavingPath)) return;
				// 동시 실행 방지: 먼저 추적에서 제거
				this.newlyCreatedFilePaths.delete(leavingPath);

				const file = this.app.vault.getFileByPath(leavingPath);
				if (!(file instanceof TFile)) return;

				const content = await this.app.vault.cachedRead(file);
				if (content !== '') return;

				// 비동기 읽기 후 재확인: 모바일 leaf 로딩 지연 및 연속 이벤트 대응
				// (leaf.file이 읽기 전에는 미세팅일 수 있으므로 읽기 완료 후에 판단)
				let isStillOpen = false;
				this.app.workspace.iterateAllLeaves((leaf) => {
					if ((leaf.view as any)?.file?.path === leavingPath) isStillOpen = true;
				});
				if (isStillOpen || this.app.workspace.getActiveFile()?.path === leavingPath) {
					this.newlyCreatedFilePaths.add(leavingPath);
					return;
				}

				this.log('[new-note-cleanup] trashing empty new note:', leavingPath);
				const fileName = file.basename;
				await (this.app as any).fileManager.trashFile(file);

				const fragment = new DocumentFragment();
				const containerEl = fragment.createEl('span');
				containerEl.appendText(`빈 노트 "${fileName}" 삭제됨  `);
				const undoLink = containerEl.createEl('a', { text: '되돌리기' });
				undoLink.style.cssText = 'cursor:pointer; text-decoration:underline;';

				let notice: Notice;
				undoLink.addEventListener('click', async (e) => {
					e.preventDefault();
					await this.app.vault.create(leavingPath, '');
					await this.app.workspace.openLinkText(normalizePath(leavingPath), '');
					notice.hide();
				});
				notice = new Notice(fragment, 10000);
			})
		);

		this.app.workspace.onLayoutReady(() => {
			this.previousActiveFilePath = this.app.workspace.getActiveFile()?.path ?? null;
			this.rebuildPinFilter();
			this.rebuildHideFilter();
			this.patchFileExplorerSort();
			this.patchLeafOpenFile();
			this.applyPinIcons();
			this.applyFolderActionButtons();
			this.setupPinObserver();
			this.registerGlobalHotkeys();
			this.refreshTabList();

			this.registerDomEvent(document, 'keydown', (event: KeyboardEvent) => {
				if (!this.settings.minimizeOnEscapeEnabled) return;
				if (event.key !== 'Escape') return;

				// 오버레이가 열려 있으면 Obsidian 기본 동작(닫기)에 맡기고 아무것도 하지 않는다
				const blockingOverlay = document.querySelector('.modal-container, .menu, .suggestion-container');
				if (blockingOverlay) {
					this.resetEscapePresses();
					this.log('[minimize-on-escape] pass-through: overlay open',
						blockingOverlay.matches('.modal-container') ? 'modal' :
						blockingOverlay.matches('.menu') ? 'menu' :
						blockingOverlay.matches('.suggestion-container') ? 'suggestion' : 'other');
					return;
				}

				// 오버레이가 없을 때: 편집 중이면 편집모드만 해제
				const activeLeaf = this.app.workspace.activeLeaf;
				const markdownView = activeLeaf?.view instanceof MarkdownView ? activeLeaf.view as MarkdownView : null;
				if (markdownView?.editor?.hasFocus()) {
					this.resetEscapePresses();
					const viewState = activeLeaf!.getViewState();
					if (viewState.state?.mode === 'source') {
						this.log('[minimize-on-escape] switch source->preview');
						activeLeaf!.setViewState({
							...viewState,
							state: { ...viewState.state, mode: 'preview' },
						});
					} else {
						this.log('[minimize-on-escape] blur editor');
						(document.activeElement as HTMLElement)?.blur();
					}
					return;
				}

				// 오버레이도 없고 에디터 포커스도 없으면 설정 횟수만큼 연속 Esc 입력 시 최소화
				const requiredPressCount = this.settings.minimizeOnEscapePressCount;
				this.escapePressCount++;
				if (this.escapePressTimer !== null) window.clearTimeout(this.escapePressTimer);
				this.escapePressTimer = window.setTimeout(() => {
					this.resetEscapePresses();
				}, ESCAPE_PRESS_WINDOW_MS);

				this.showEscapeIndicator(this.escapePressCount);
				this.log('[minimize-on-escape] count', this.escapePressCount, '/', requiredPressCount);
				if (this.escapePressCount >= requiredPressCount) {
					this.resetEscapePresses();
					this.log('[minimize-on-escape] triggered');
					getElectronRemote()?.getCurrentWindow().minimize();
				}
			}, { capture: true });
			this.registerEvent(
				this.app.workspace.on('layout-change', () => {
					this.refreshTabList();
				})
			);
			this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshTabList()));
		});

		this.addCommand({
			id: 'toggle-tab-list',
			name: '탭 목록 열기/닫기',
			checkCallback: (checking: boolean) => {
				if (!this.settings.tabListEnabled || !this.tabListHeaderButtonEl) return false;
				if (!checking) this.toggleTabList();
				return true;
			},
		});

		this.addSettingTab(new OhUtilsSettingTab(this.app, this));
	}

	async onunload() {
		this.resetEscapePresses();
		this.escapeIndicatorEl?.remove();
		this.escapeIndicatorEl = null;
		this.sortPatcher?.();
		this.leafOpenFilePatcher?.();
		this.pinObserver?.disconnect();
		this.clearPinDecorations();
		this.clearFolderActionButtons();
		this.teardownTabList();
		this.unregisterGlobalHotkeys();
	}

	private patchLeafOpenFile() {
		const plugin = this;
		this.leafOpenFilePatcher = around(WorkspaceLeaf.prototype, {
			openFile(old) {
				return async function(this: WorkspaceLeaf, file: TFile, ...args: any[]) {
					const currentFilePath = (this.view as any)?.file?.path as string | undefined;
					if (
						currentFilePath &&
						file.path !== currentFilePath &&
						(
							(Platform.isMobile && plugin.settings.mobileOpenInNewTabEnabled) ||
							(!Platform.isMobile && plugin.settings.desktopOpenInNewTabEnabled)
						)
					) {
						const newLeaf = plugin.app.workspace.getLeaf('tab');
						return (newLeaf as any).openFile(file, ...args);
					}

					if (plugin.settings.noDuplicateTabsEnabled) {
						let existingLeaf: WorkspaceLeaf | null = null;
						plugin.app.workspace.iterateAllLeaves(otherLeaf => {
							if (otherLeaf === this) return;
							if ((otherLeaf.view as any)?.file?.path === file.path) {
								existingLeaf = otherLeaf;
							}
						});
						if (existingLeaf) {
							plugin.log('[no-dup] duplicate prevented:', file.path);
							plugin.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
							// 현재 리프에 파일이 없는 경우(빈 새 탭)에만 닫는다.
							// 기존 파일이 있는 리프(모바일 포함)는 닫으면 뷰가 사라지므로 남겨둔다.
							if (!currentFilePath) {
								this.detach();
							}
							return;
						}
					}

					return old.call(this, file, ...args);
				};
			}
		});
	}

	// ── 탭 목록 ───────────────────────────────────────────────

	teardownTabList(): void {
		this.tabListHeaderButtonEl?.remove();
		this.tabListPanelEl?.remove();
		this.tabListBackdropEl?.remove();
		this.tabListHeaderButtonEl = null;
		this.tabListPanelEl = null;
		this.tabListBackdropEl = null;
		this.tabListAttachedToContainerEl = null;
		this.tabListIsOpen = false;
	}

	refreshTabList(): void {
		if (!this.settings.tabListEnabled) return;

		const leaf = this.app.workspace.getMostRecentLeaf();
		const containerEl = (leaf?.view as any)?.containerEl as HTMLElement | undefined;
		if (!containerEl) return;

		if (containerEl !== this.tabListAttachedToContainerEl) {
			this.tabListHeaderButtonEl?.remove();
			this.tabListHeaderButtonEl = null;
			this.tabListIsOpen = false;
			this.tabListAttachedToContainerEl = containerEl;

			const headerEl = containerEl.querySelector('.view-header') as HTMLElement | null;
			if (headerEl) this.attachTabListButton(headerEl);
		}

		if (this.tabListIsOpen) this.rebuildTabListRows();
	}

	private attachTabListButton(headerEl: HTMLElement): void {
		const buttonEl = createEl('div', { cls: 'oh-aio-tab-list-btn clickable-icon' });
		setIcon(buttonEl, 'layers-2');
		buttonEl.setAttribute('aria-label', '탭 목록');
		buttonEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleTabList();
		});
		const actionsEl = headerEl.querySelector('.view-actions');
		if (actionsEl) actionsEl.insertBefore(buttonEl, actionsEl.firstChild);
		else headerEl.appendChild(buttonEl);
		this.tabListHeaderButtonEl = buttonEl;
	}

	private toggleTabList(): void {
		if (this.tabListIsOpen) this.closeTabList();
		else this.openTabList();
	}

	private openTabList(): void {
		if (!this.tabListHeaderButtonEl) return;

		if (!this.tabListBackdropEl) {
			const backdropEl = createEl('div', { cls: 'oh-aio-tab-backdrop' });
			backdropEl.addEventListener('click', () => this.closeTabList());
			document.body.appendChild(backdropEl);
			this.tabListBackdropEl = backdropEl;
		}
		if (!this.tabListPanelEl) {
			const panelEl = createEl('div', { cls: 'oh-aio-tab-panel' });
			document.body.appendChild(panelEl);
			this.tabListPanelEl = panelEl;
		}

		const buttonBottom = this.tabListHeaderButtonEl.getBoundingClientRect().bottom;
		this.tabListPanelEl.style.top = buttonBottom + 'px';

		this.rebuildTabListRows();
		this.tabListIsOpen = true;
		this.tabListPanelEl.addClass('is-open');
		this.tabListBackdropEl.addClass('is-open');
		this.tabListHeaderButtonEl.addClass('is-active');
	}

	private closeTabList(): void {
		this.tabListIsOpen = false;
		this.tabListPanelEl?.removeClass('is-open');
		this.tabListBackdropEl?.removeClass('is-open');
		this.tabListHeaderButtonEl?.removeClass('is-active');
	}

	private rebuildTabListRows(): void {
		if (!this.tabListPanelEl) return;
		if (this.tabListHeaderButtonEl) {
			this.tabListPanelEl.style.top = this.tabListHeaderButtonEl.getBoundingClientRect().bottom + 'px';
		}
		this.tabListPanelEl.empty();

		const activeFile = this.app.workspace.getActiveFile();
		const rootSplit = (this.app.workspace as any).rootSplit;

		const openLeaves: WorkspaceLeaf[] = [];
		const openPaths = new Set<string>();
		this.app.workspace.iterateAllLeaves(leaf => {
			if (rootSplit && (leaf as any).getRoot?.() !== rootSplit) return;
			const file = (leaf.view as any)?.file as TFile | undefined;
			if (!file || openPaths.has(file.path)) return;
			openPaths.add(file.path);
			openLeaves.push(leaf);
		});

		const pinnedPathSet = new Set<string>();
		if (this.settings.pinEnabled) {
			for (const line of this.settings.pinnedPatterns.split('\n')) {
				const trimmed = line.trim();
				if (trimmed) pinnedPathSet.add(trimmed);
			}
		}

		const pinnedClosedFiles: TFile[] = [];
		for (const pinnedPath of pinnedPathSet) {
			if (!openPaths.has(pinnedPath)) {
				const file = this.app.vault.getFileByPath(pinnedPath);
				if (file) pinnedClosedFiles.push(file);
			}
		}

		if (openLeaves.length === 0 && pinnedClosedFiles.length === 0) {
			this.tabListPanelEl.createEl('div', {
				cls: 'oh-aio-tab-empty',
				text: '열린 탭이 없습니다.',
			});
			return;
		}

		const sortedLeaves = this.applyTabLeafOrder(openLeaves);
		for (const openLeaf of sortedLeaves) {
			const file = (openLeaf.view as any).file as TFile;
			const isActive = file.path === activeFile?.path;
			const isFilePinned = pinnedPathSet.has(file.path);
			this.buildTabRow(this.tabListPanelEl, openLeaf, file, isActive, isFilePinned);
		}

		for (const file of pinnedClosedFiles) {
			this.buildTabPinnedClosedRow(this.tabListPanelEl, file);
		}
	}

	private buildTabRow(
		containerEl: HTMLElement,
		leaf: WorkspaceLeaf,
		file: TFile,
		isActive: boolean,
		isPinnedFile: boolean,
	): void {
		const rowEl = createEl('div', { cls: 'oh-aio-tab-row' });
		rowEl.dataset.filePath = file.path;
		if (isActive) rowEl.addClass('is-active');

		const deleteBackgroundEl = rowEl.createEl('div', { cls: 'oh-aio-tab-row-delete-bg' });
		const deleteIconEl = deleteBackgroundEl.createEl('span');
		setIcon(deleteIconEl, 'trash-2');

		const innerEl = rowEl.createEl('div', { cls: 'oh-aio-tab-row-inner' });

		if (isPinnedFile) {
			const pinIconEl = innerEl.createEl('span', { cls: 'oh-aio-tab-row-pin' });
			setIcon(pinIconEl, 'pin');
		}

		this.buildTabFileText(innerEl, file);

		// 핀 토글 버튼
		const pinButtonEl = innerEl.createEl('div', { cls: 'oh-aio-tab-row-pin-btn clickable-icon' });
		setIcon(pinButtonEl, isPinnedFile ? 'pin-off' : 'pin');
		pinButtonEl.setAttribute('aria-label', isPinnedFile ? '핀 해제' : '핀 고정');
		pinButtonEl.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.setPinned(file.path, !isPinnedFile);
		});

		// 탭 닫기 버튼 — 마우스(데스크탑)에서도 닫을 수 있게. 터치는 스와이프도 가능.
		// detach()가 layout-change를 발생시켜 목록이 자동 재구성되므로 별도 재구성 없음.
		const closeButtonEl = innerEl.createEl('div', { cls: 'oh-aio-tab-row-close-btn clickable-icon' });
		setIcon(closeButtonEl, 'x');
		closeButtonEl.setAttribute('aria-label', '탭 닫기');
		closeButtonEl.addEventListener('click', (e) => {
			e.stopPropagation();
			leaf.detach();
		});

		// 드래그 핸들
		const dragHandleEl = innerEl.createEl('div', { cls: 'oh-aio-tab-row-drag-handle' });
		setIcon(dragHandleEl, 'grip-vertical');

		containerEl.appendChild(rowEl);

		// 탭 전환
		innerEl.addEventListener('click', () => {
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
			this.closeTabList();
		});

		this.attachTabSwipeToDelete(rowEl, innerEl, leaf, file.path);
		this.setupTabRowDrag(rowEl, dragHandleEl, file.path);
	}

	private buildTabPinnedClosedRow(containerEl: HTMLElement, file: TFile): void {
		const rowEl = createEl('div', { cls: 'oh-aio-tab-row is-pinned-closed' });
		const innerEl = rowEl.createEl('div', { cls: 'oh-aio-tab-row-inner' });

		const pinIconEl = innerEl.createEl('span', { cls: 'oh-aio-tab-row-pin' });
		setIcon(pinIconEl, 'pin');

		this.buildTabFileText(innerEl, file);

		const unpinButtonEl = innerEl.createEl('div', { cls: 'oh-aio-tab-row-pin-btn clickable-icon' });
		setIcon(unpinButtonEl, 'pin-off');
		unpinButtonEl.setAttribute('aria-label', '핀 해제');
		unpinButtonEl.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.setPinned(file.path, false);
		});

		const dragHandleEl = innerEl.createEl('div', { cls: 'oh-aio-tab-row-drag-handle' });
		setIcon(dragHandleEl, 'grip-vertical');

		containerEl.appendChild(rowEl);

		innerEl.addEventListener('click', () => {
			this.app.workspace.getLeaf(false).openFile(file);
			this.closeTabList();
		});

		this.setupTabPinnedClosedRowDrag(rowEl, dragHandleEl, file.path);
	}

	private setupTabPinnedClosedRowDrag(rowEl: HTMLElement, dragHandleEl: HTMLElement, filePath: string): void {
		this.setupTabRowDragBase(
			rowEl,
			dragHandleEl,
			'.oh-aio-tab-row.is-pinned-closed:not(.is-dragging)',
			(targetIndex) => {
				const lines = this.settings.pinnedPatterns.split('\n').filter(l => l.trim());
				const currentIndex = lines.indexOf(filePath);
				if (currentIndex !== -1) {
					lines.splice(currentIndex, 1);
					lines.splice(targetIndex, 0, filePath);
					this.settings.pinnedPatterns = lines.join('\n');
					this.saveSettings();
					this.rebuildTabListRows();
				}
			},
		);
	}

	private buildTabFileText(innerEl: HTMLElement, file: TFile): void {
		const textEl = innerEl.createEl('div', { cls: 'oh-aio-tab-row-text' });
		const displayName = file.extension === 'md' ? file.basename : file.name;
		textEl.createEl('span', { cls: 'oh-aio-tab-row-name', text: displayName });
		if (file.parent && file.parent.path !== '/') {
			textEl.createEl('span', { cls: 'oh-aio-tab-row-path', text: file.parent.path });
		}
	}

	private attachTabSwipeToDelete(
		rowEl: HTMLElement,
		innerEl: HTMLElement,
		leaf: WorkspaceLeaf,
		filePath: string,
	): void {
		let touchStartX = 0;
		let touchCurrentX = 0;

		innerEl.addEventListener('touchstart', (e) => {
			touchStartX = e.touches[0].clientX;
			touchCurrentX = touchStartX;
			innerEl.style.transition = 'none';
		}, { passive: true });

		innerEl.addEventListener('touchmove', (e) => {
			touchCurrentX = e.touches[0].clientX;
			const deltaX = touchCurrentX - touchStartX;
			if (deltaX < 0) innerEl.style.transform = `translateX(${deltaX}px)`;
		}, { passive: true });

		innerEl.addEventListener('touchend', () => {
			const deltaX = touchCurrentX - touchStartX;
			innerEl.style.transition = '';

			if (deltaX < -80) {
				innerEl.style.transform = 'translateX(-100%)';
				const rowHeight = rowEl.offsetHeight;
				rowEl.style.overflow = 'hidden';
				rowEl.style.transition = 'height 0.2s ease, opacity 0.15s ease';
				requestAnimationFrame(() => {
					rowEl.style.height = rowHeight + 'px';
					requestAnimationFrame(() => {
						rowEl.style.height = '0';
						rowEl.style.opacity = '0';
					});
				});
				setTimeout(() => {
					leaf.detach();
					rowEl.remove();
				}, 200);
			} else {
				innerEl.style.transform = '';
			}
		});
	}

	private applyTabLeafOrder(leaves: WorkspaceLeaf[]): WorkspaceLeaf[] {
		if (this.tabListLeafOrder.length === 0) {
			this.tabListLeafOrder = leaves.map(l => (l.view as any)?.file?.path as string).filter(Boolean);
			return leaves;
		}
		const orderMap = new Map(this.tabListLeafOrder.map((p, i) => [p, i]));
		const sorted = [...leaves].sort((a, b) => {
			const ap = (a.view as any)?.file?.path ?? '';
			const bp = (b.view as any)?.file?.path ?? '';
			return (orderMap.has(ap) ? orderMap.get(ap)! : Infinity) - (orderMap.has(bp) ? orderMap.get(bp)! : Infinity);
		});
		this.tabListLeafOrder = sorted.map(l => (l.view as any)?.file?.path as string).filter(Boolean);
		return sorted;
	}

	private setupTabRowDragBase(
		rowEl: HTMLElement,
		dragHandleEl: HTMLElement,
		draggableRowSelector: string,
		onDrop: (targetIndex: number) => void,
	): void {
		const panelEl = this.tabListPanelEl;
		if (!panelEl) return;

		// Pointer Events로 마우스(데스크탑)·터치(모바일) 드래그를 한 경로로 처리한다.
		// 핸들은 CSS touch-action: none이 걸려 있어 터치 드래그 중 패널이 스크롤되지 않는다.
		dragHandleEl.addEventListener('pointerdown', (e) => {
			e.stopPropagation();

			const startY = e.clientY;
			const rect = rowEl.getBoundingClientRect();

			const cloneEl = rowEl.cloneNode(true) as HTMLElement;
			cloneEl.classList.add('oh-aio-tab-row-drag-clone');
			cloneEl.style.top = rect.top + 'px';
			cloneEl.style.left = rect.left + 'px';
			cloneEl.style.width = rect.width + 'px';
			document.body.appendChild(cloneEl);

			rowEl.classList.add('is-dragging');

			const indicatorEl = createEl('div', { cls: 'oh-aio-tab-drop-indicator' });
			panelEl.appendChild(indicatorEl);

			// pointermove마다 DOM 쿼리·레이아웃 flush를 막기 위해 pointerdown 시점에 스냅샷
			const draggableRows = Array.from(
				panelEl.querySelectorAll(draggableRowSelector)
			) as HTMLElement[];
			const panelRect = panelEl.getBoundingClientRect();
			const rowSnapshots = draggableRows.map(r => {
				const rRect = r.getBoundingClientRect();
				return {
					midY: rRect.top + rRect.height / 2,
					topOffset: rRect.top - panelRect.top + panelEl.scrollTop,
					bottomOffset: rRect.bottom - panelRect.top + panelEl.scrollTop,
				};
			});

			let targetIndex = -1;

			const onMove = (ev: PointerEvent) => {
				const pointerY = ev.clientY;
				cloneEl.style.transform = `translateY(${pointerY - startY}px)`;

				targetIndex = rowSnapshots.length;
				let indicatorTop = -1;

				for (let i = 0; i < rowSnapshots.length; i++) {
					if (pointerY < rowSnapshots[i].midY) {
						targetIndex = i;
						indicatorTop = rowSnapshots[i].topOffset;
						break;
					}
					if (i === rowSnapshots.length - 1) {
						indicatorTop = rowSnapshots[i].bottomOffset;
					}
				}

				if (indicatorTop >= 0) {
					indicatorEl.style.top = indicatorTop + 'px';
					indicatorEl.style.display = 'block';
				}
			};

			const onEnd = () => {
				cloneEl.remove();
				indicatorEl.remove();
				rowEl.classList.remove('is-dragging');

				document.removeEventListener('pointermove', onMove);
				document.removeEventListener('pointerup', onEnd);

				if (targetIndex >= 0) onDrop(targetIndex);
			};

			document.addEventListener('pointermove', onMove, { passive: true });
			document.addEventListener('pointerup', onEnd);
		});
	}

	private setupTabRowDrag(rowEl: HTMLElement, dragHandleEl: HTMLElement, filePath: string): void {
		this.setupTabRowDragBase(
			rowEl,
			dragHandleEl,
			'.oh-aio-tab-row[data-file-path]:not(.is-dragging)',
			(targetIndex) => {
				const newOrder = this.tabListLeafOrder.filter(p => p !== filePath);
				newOrder.splice(targetIndex, 0, filePath);
				this.tabListLeafOrder = newOrder;
				this.rebuildTabListRows();
			},
		);
	}

	// ── 핀 정렬 패치 ─────────────────────────────────────────

	private patchFileExplorerSort() {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer) return;

		const proto = Object.getPrototypeOf(fileExplorer);
		if (!proto.getSortedFolderItems) return;

		this.log('[sort-patch] patching getSortedFolderItems');
		const plugin = this;
		this.sortPatcher = around(proto, {
			getSortedFolderItems(old: (...args: any[]) => any[]) {
				return function (this: any, ...args: any[]): any[] {
					let items: any[] = old.call(this, ...args);

					// 숨기기 필터 적용
					if (plugin.settings.hideEnabled && plugin.hideFilter) {
						const before = items.length;
						items = items.filter(item => {
							const file = item.file;
							if (!file) return true;
							// 폴더는 경로 끝에 / 붙여서 디렉토리 패턴 매칭
							const testPath = file instanceof TFolder
								? file.path + '/'
								: file.path;
							try {
								const hidden = plugin.hideFilter!.ignores(testPath);
								if (hidden) plugin.log('[hide] hiding:', testPath);
								return !hidden;
							} catch {
								return true;
							}
						});
						if (items.length !== before) plugin.log('[hide] filtered', before - items.length, 'item(s)');
					}

					// 핀 정렬 적용
					if (plugin.settings.pinEnabled && plugin.pinFilter) {
						const isPinned = (item: any) => {
							const file = item.file;
							if (!file) return false;
							return plugin.isItemPinned(file.path, file instanceof TFolder);
						};
						const pinned = items.filter(isPinned);
						if (pinned.length > 0) plugin.log('[pin] pinned items:', pinned.map((i: any) => i.file?.path));
						items = [...pinned, ...items.filter(i => !isPinned(i))];
					}

					return items;
				};
			},
		});
	}

	requestSort() {
		(this.getFileExplorer() as any)?.requestSort?.();
	}

	rebuildPinFilter() {
		this.pinFilter = this.buildIgnoreFilter(this.settings.pinnedPatterns);
		this.log('[pin] filter', this.pinFilter ? 'rebuilt' : 'cleared');
	}

	rebuildHideFilter() {
		this.hideFilter = this.buildIgnoreFilter(this.settings.hidePatterns);
		this.log('[hide] filter', this.hideFilter ? 'rebuilt' : 'cleared');
	}

	private hasExactMatch(patterns: string, path: string): boolean {
		return patterns.split('\n').some(line => line.trim() === path);
	}

	private buildIgnoreFilter(patterns: string): Ignore | null {
		const trimmed = patterns.trim();
		return trimmed ? ignore().add(trimmed) : null;
	}

	private addPatternLine(patterns: string, line: string): string {
		const trimmed = patterns.trimEnd();
		return trimmed ? trimmed + '\n' + line : line;
	}

	private removePatternLine(patterns: string, line: string): string {
		return patterns.split('\n').filter(l => l.trim() !== line).join('\n');
	}

	// UI에서의 핀 고정/해제 단일 출처: 컨텍스트 메뉴·액션 버튼·탭 목록 모두 이 메서드를 호출한다.
	// (vault delete/rename 동기화, 탭 목록 드래그 순서 변경은 pinnedPatterns를 직접 다룬다)
	private async setPinned(filePath: string, pinned: boolean): Promise<void> {
		if (pinned) {
			this.settings.pinnedPatterns = this.addPatternLine(this.settings.pinnedPatterns, filePath);
		} else {
			this.settings.pinnedPatterns = this.removePatternLine(this.settings.pinnedPatterns, filePath);
			this.removePinIcon(filePath);
		}
		// 저장(디스크 쓰기)은 먼저 시작하고 메모리상 설정으로 즉시 갱신한다
		const saving = this.saveSettings();
		this.rebuildPinFilter();
		this.requestSort();
		// 패널이 열려 있을 때만 재구성 — 닫힌 상태에서는 openTabList()가 열 때마다 재구성한다
		if (this.tabListIsOpen) this.rebuildTabListRows();
		await saving;
	}

	private renamePatternLine(patterns: string, oldLine: string, newLine: string): string {
		return patterns.split('\n').map(l => l.trim() === oldLine ? newLine : l).join('\n');
	}

	private hasExactPinPattern(filePath: string): boolean {
		return this.hasExactMatch(this.settings.pinnedPatterns, filePath);
	}

	// 아이템 자신이 직접 핀 패턴에 매칭되는지 확인한다.
	// ignore 패키지는 gitignore 시맨틱 상 부모 폴더가 매칭되면 자식도 true를 반환하므로,
	// 부모 경로 중 핀 필터에 매칭되는 것이 있으면 "자식으로서 매칭된 것"으로 간주해 제외한다.
	private isItemPinned(filePath: string, isFolder: boolean): boolean {
		if (!this.pinFilter) return false;
		const testPath = isFolder ? filePath + '/' : filePath;
		try {
			if (!this.pinFilter.ignores(testPath)) return false;
			// 조상 폴더 중 핀된 것이 있으면 자식으로서 매칭된 것 — 직접 핀이 아님
			const parts = filePath.split('/');
			for (let depth = 1; depth < parts.length; depth++) {
				const ancestorPath = parts.slice(0, depth).join('/') + '/';
				if (this.pinFilter.ignores(ancestorPath)) return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	// ── 핀 아이콘 표시 ────────────────────────────────────────

	private setupPinObserver() {
		const explorerEl = this.getFileExplorer()?.containerEl as HTMLElement | null;
		if (!explorerEl) return;

		this.pinObserver?.disconnect();
		this.pinObserver = new MutationObserver(() => this.debouncedApplyExplorer());
		this.pinObserver.observe(explorerEl, { childList: true, subtree: true });
	}

	applyPinIcons() {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer?.fileItems) return;

		const fileItems = fileExplorer.fileItems as Record<string, any>;
		let iconCount = 0;

		for (const [path, item] of Object.entries(fileItems)) {
			if (!item?.el || !item.file) continue;

			if (!this.isItemPinned(path, item.file instanceof TFolder)) continue;

			(item.el as HTMLElement).classList.add('oh-aio-pinned');

			// item.el의 firstChild = 타이틀 엘리먼트
			const titleEl = (item.el as HTMLElement).firstChild as HTMLElement | null;
			if (!titleEl || titleEl.querySelector('.oh-aio-pin-icon')) continue;

			const pinIconEl = createEl('span', { cls: 'oh-aio-pin-icon' });
			setIcon(pinIconEl, 'pin');
			// collapse indicator보다 앞에 삽입
			titleEl.insertBefore(pinIconEl, titleEl.firstChild);
			iconCount++;
		}

		if (iconCount > 0) this.log('[pin] applied icons to', iconCount, 'item(s)');
	}

	private removePinIcon(path: string) {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer?.fileItems) return;

		const item = (fileExplorer.fileItems as Record<string, any>)[path];
		if (!item?.el) return;

		(item.el as HTMLElement).classList.remove('oh-aio-pinned');
		(item.el as HTMLElement).querySelector('.oh-aio-pin-icon')?.remove();
	}

	clearPinDecorations() {
		document.querySelectorAll('.oh-aio-pin-icon').forEach(el => el.remove());
		document.querySelectorAll('.oh-aio-pinned').forEach(el => el.classList.remove('oh-aio-pinned'));
	}

	// ── 하위 폴더 일괄 접기 ───────────────────────────────────

	private collapseFolderByEl(navFolderEl: HTMLElement) {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer?.fileItems) return;

		const clickedItem = Object.values(fileExplorer.fileItems).find(
			(item: any) => item.el === navFolderEl
		) as any;
		if (!clickedItem) return;

		this.collapseDescendants(clickedItem.file?.path ?? '', fileExplorer.fileItems as Record<string, any>);
	}

	private collapseFolderByPath(folderPath: string) {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer?.fileItems) return;

		this.collapseDescendants(folderPath, fileExplorer.fileItems as Record<string, any>);
	}

	private collapseDescendants(parentPath: string, fileItems: Record<string, any>) {
		for (const [path, item] of Object.entries(fileItems)) {
			if (typeof item.setCollapsed !== 'function') continue;

			const isSelf = path === parentPath;
			const isDescendant = parentPath === ''
				? true
				: path.startsWith(parentPath + '/');

			if (isSelf || isDescendant) {
				item.setCollapsed(true, false);
			}
		}
	}

	private expandDescendants(parentPath: string, fileItems: Record<string, any>) {
		for (const [path, item] of Object.entries(fileItems)) {
			if (typeof item.setCollapsed !== 'function') continue;
			if (!(item.file instanceof TFolder)) continue;

			const isSelf = path === parentPath;
			const isDescendant = parentPath === ''
				? true
				: path.startsWith(parentPath + '/');

			if (isSelf || isDescendant) {
				item.setCollapsed(false, false);
			}
		}
	}

	// ── 폴더 액션 버튼 ─────────────────────────────────────

	applyFolderActionButtons() {
		if (!this.settings.folderActionsEnabled) return;

		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer?.fileItems) return;

		const fileItems = fileExplorer.fileItems as Record<string, any>;
		const {
			folderActionsShowNewFile,
			folderActionsShowExpandAll,
			folderActionsShowCollapseAll,
			folderActionsShowPin,
			folderActionsShowDelete,
			folderActionsShowCopyPath,
			pinEnabled,
		} = this.settings;
		const showPin = folderActionsShowPin && pinEnabled;
		const showDelete = folderActionsShowDelete;

		for (const [, item] of Object.entries(fileItems)) {
			if (!item?.el || !item.file) continue;

			const isFolder = item.file instanceof TFolder;
			const isFile = item.file instanceof TFile;
			if (!isFolder && !isFile) continue;

			// 버튼 표시 여부 판단
			const hasFolderSpecificButtons = isFolder && (folderActionsShowNewFile || folderActionsShowExpandAll || folderActionsShowCollapseAll);
			const hasSharedButtons = showPin || showDelete || folderActionsShowCopyPath;
			if (!hasFolderSpecificButtons && !hasSharedButtons) continue;

			const titleEl = item.el.firstChild as HTMLElement | null;
			if (!titleEl) continue;
			if (titleEl.querySelector('.oh-aio-item-actions')) continue;

			const actionsEl = createEl('div', { cls: 'oh-aio-item-actions' });

			if (isFolder && folderActionsShowNewFile) {
				const btn = actionsEl.createEl('button', {
					cls: 'oh-aio-item-action-btn',
					attr: { 'aria-label': '새 파일' },
				});
				setIcon(btn, 'file-plus');
				btn.addEventListener('click', async (e) => {
					e.stopPropagation();
					e.preventDefault();
					await this.createNewFileInFolder(item.file as TFolder);
				});
			}

			if (isFolder && folderActionsShowExpandAll) {
				const btn = actionsEl.createEl('button', {
					cls: 'oh-aio-item-action-btn',
					attr: { 'aria-label': '모두 펼치기' },
				});
				setIcon(btn, 'chevrons-down');
				btn.addEventListener('click', (e) => {
					e.stopPropagation();
					e.preventDefault();
					this.expandDescendants((item.file as TFolder).path, fileItems);
				});
			}

			if (isFolder && folderActionsShowCollapseAll) {
				const btn = actionsEl.createEl('button', {
					cls: 'oh-aio-item-action-btn',
					attr: { 'aria-label': '모두 닫기' },
				});
				setIcon(btn, 'chevrons-up');
				btn.addEventListener('click', (e) => {
					e.stopPropagation();
					e.preventDefault();
					this.collapseFolderByPath((item.file as TFolder).path);
				});
			}

			if (showPin) {
				const pinBtn = actionsEl.createEl('button', { cls: 'oh-aio-item-action-btn' });
				this.refreshPinButton(pinBtn, item.file.path);
				pinBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					e.preventDefault();
					await this.setPinned(item.file.path, !this.hasExactPinPattern(item.file.path));
					// 클릭 즉시 아이콘 업데이트 (DOM 재렌더 대기 안 함)
					this.refreshPinButton(pinBtn, item.file.path);
				});
			}

			if (showDelete) {
				const btn = actionsEl.createEl('button', {
					cls: 'oh-aio-item-action-btn oh-aio-item-action-btn--danger',
					attr: { 'aria-label': '삭제' },
				});
				setIcon(btn, 'trash-2');
				btn.addEventListener('click', async (e) => {
					e.stopPropagation();
					e.preventDefault();
					const name = item.file.name;
					const confirmed = confirm(`"${name}"을(를) 삭제할까요?`);
					if (!confirmed) return;
					await (this.app as any).fileManager.trashFile(item.file);
				});
			}

			if (folderActionsShowCopyPath) {
				const btn = actionsEl.createEl('button', {
					cls: 'oh-aio-item-action-btn',
					attr: { 'aria-label': '경로 복사' },
				});
				setIcon(btn, 'copy');
				btn.addEventListener('click', async (e) => {
					e.stopPropagation();
					e.preventDefault();
					await navigator.clipboard.writeText(item.file.path);
					new Notice('경로 복사됨');
				});
			}

			if (actionsEl.childElementCount === 0) continue;
			titleEl.appendChild(actionsEl);
		}
	}

	private refreshPinButton(btn: HTMLElement, filePath: string) {
		const isPinned = this.hasExactPinPattern(filePath);
		btn.setAttribute('aria-label', isPinned ? '핀 해제' : '핀 고정');
		btn.empty();
		setIcon(btn, isPinned ? 'pin-off' : 'pin');
	}

	clearFolderActionButtons() {
		document.querySelectorAll('.oh-aio-item-actions').forEach(el => el.remove());
	}

	refreshFolderActionButtons() {
		this.clearFolderActionButtons();
		this.applyFolderActionButtons();
	}

	private async createNewFileInFolder(folder: TFolder) {
		const basePath = folder.path === '' ? '' : folder.path + '/';
		const newFilePath = (this.app.vault as any).getAvailablePath(basePath + 'Untitled', 'md');
		const newFile = await this.app.vault.create(newFilePath, '');
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(newFile as TFile);
		const fileExplorer = this.getFileExplorer();
		if (fileExplorer?.startRenaming) {
			setTimeout(() => fileExplorer.startRenaming((newFile as TFile).path), 100);
		}
	}

	private getFileExplorer(): any {
		return this.app.workspace.getLeavesOfType('file-explorer')[0]?.view;
	}


	// ── 글로벌 핫키 ──────────────────────────────────────────

	registerGlobalHotkeys() {
		if (!Platform.isDesktop || !this.settings.globalHotkeysEnabled) return;
		const remote = getElectronRemote();
		if (!remote) return;

		for (const hotkey of this.settings.globalHotkeys) {
			if (!hotkey.accelerator || !hotkey.commandId) continue;
			const runCommand = () => {
				const win = remote.getCurrentWindow();
				this.log('[global-hotkey] triggered:', hotkey.accelerator, '→', hotkey.commandId,
					'| window visible:', win.isVisible(), '| minimized:', win.isMinimized());
				if (win.isMinimized()) win.restore();
				win.show();
				win.focus();
				const cmd = (this.app as any).commands.commands[hotkey.commandId];
				if (!cmd) {
					this.log('[global-hotkey] command not found:', hotkey.commandId);
					return;
				}
				// 글로벌 핫키는 모달 열림 상태와 무관하게 발생해서, 모달을 여는 명령(Omnisearch 등)을
				// 반복 실행하면 모달이 계층으로 쌓인다. 실행 전 열려 있는 모달을 모두 닫아 항상 하나만 유지한다.
				for (const modalCloseButton of Array.from(document.querySelectorAll('.modal-container .modal-close-button'))) {
					(modalCloseButton as HTMLElement).click();
				}
				if (cmd.checkCallback) cmd.checkCallback(false);
				else if (cmd.callback) cmd.callback();
			};
			try {
				let didRegister = remote.globalShortcut.register(hotkey.accelerator, runCommand);
				if (!didRegister) {
					// 이전 세션에서 남은 등록 상태(예: 다른 PC로 설정 동기화 직후, 비정상 종료 후 재시작)를
					// 정리한 뒤 한 번 더 시도한다
					remote.globalShortcut.unregister(hotkey.accelerator);
					didRegister = remote.globalShortcut.register(hotkey.accelerator, runCommand);
				}
				if (!didRegister) throw new Error('register failed');
				this.log('[global-hotkey] registered:', hotkey.accelerator, '→', hotkey.commandId);
			} catch {
				this.log('[global-hotkey] registration failed:', hotkey.accelerator);
				new Notice(`[oh-utils] 단축키 등록 실패: ${hotkey.accelerator}`);
			}
		}
	}

	unregisterGlobalHotkeys() {
		if (!Platform.isDesktop) return;
		const remote = getElectronRemote();
		if (!remote) return;

		for (const hotkey of this.settings.globalHotkeys) {
			if (hotkey.accelerator) {
				try { remote.globalShortcut.unregister(hotkey.accelerator); } catch {}
			}
		}
	}

	// 핫키 목록 변경의 단일 출처: 등록 해제 → 목록 변경 → 저장 → 재등록 순서를 보장한다.
	async changeGlobalHotkeys(applyChange: (hotkeys: GlobalHotkey[]) => void): Promise<void> {
		this.unregisterGlobalHotkeys();
		applyChange(this.settings.globalHotkeys);
		await this.saveSettings();
		this.registerGlobalHotkeys();
	}


	async loadSettings() {
		const data = await this.loadData();
		// COMPAT(pinnedPaths-to-pinnedPatterns): string[] -> string 변환 (schema migration, v0.x)
		//   우클릭으로 핀 고정했던 정확한 경로 배열을 줄바꿈 구분 패턴 문자열로 이전한다
		// COMPAT-REMOVE-WHEN: pinnedPaths 배열이 포함된 저장 파일 비율이 0%로 확인된 후 30일 경과 시
		if (data?.pinnedPaths && Array.isArray(data.pinnedPaths) && !data.pinnedPatterns) {
			data.pinnedPatterns = (data.pinnedPaths as string[]).join('\n');
			delete data.pinnedPaths;
		}
		// COMPAT(mobileTabListEnabled-rename): 모바일 탭 목록 -> 전 플랫폼 탭 목록 개명 (v0.0.70)
		//   구 설정 키 mobileTabListEnabled의 저장값을 tabListEnabled로 이전한다
		// COMPAT-REMOVE-WHEN: v0.0.70 이전 버전 사용률이 0%로 확인된 후 30일 경과 시
		if (data?.mobileTabListEnabled !== undefined && data.tabListEnabled === undefined) {
			data.tabListEnabled = data.mobileTabListEnabled;
			delete data.mobileTabListEnabled;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ── 설정 탭 (Obsidian 1.13+ 선언적 설정 API) ──────────────────
// display() 기반 커스텀 UI는 1.13 코어 설정 검색과 중복되어 완전 이관했다 (v0.0.73).
// minAppVersion를 1.13.0으로 올렸으므로 구버전 폴백 display()는 유지하지 않는다.

class OhUtilsSettingTab extends PluginSettingTab {
	plugin: OhUtilsPlugin;

	constructor(app: App, plugin: OhUtilsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const { settings } = this.plugin;
		return [
			{
				type: 'page',
				name: '일반',
				items: [
					{
						type: 'group',
						heading: '창 최소화',
						visible: () => Platform.isDesktop,
						items: [
							{
								name: '아무것도 활성화되지 않았을 때 Esc로 최소화',
								desc: '모달·메뉴·제안 목록이 열려 있지 않고 에디터에 포커스가 없는 상태에서 Esc 키를 누르면 창을 최소화합니다.',
								control: { type: 'toggle', key: 'minimizeOnEscapeEnabled' },
							},
							{
								name: '최소화에 필요한 Esc 입력 횟수',
								desc: `${ESCAPE_PRESS_WINDOW_MS}ms 안에 Esc 키를 몇 번 연속으로 눌러야 창을 최소화할지 지정합니다.`,
								control: { type: 'number', key: 'minimizeOnEscapePressCount', min: 1, max: 10 },
							},
						],
					},
					{
						type: 'group',
						heading: '디버그',
						items: [
							{
								name: '디버그 모드',
								desc: '각 기능의 동작을 브라우저 콘솔(Ctrl+Shift+I)에 verbose하게 출력합니다.',
								control: { type: 'toggle', key: 'debugMode' },
							},
						],
					},
				],
			},
			{
				type: 'page',
				name: '노트',
				items: [
					{
						type: 'group',
						heading: '빈 새 노트 자동 삭제',
						items: [
							{
								name: '활성화',
								desc: '새로 만든 노트에 아무것도 입력하지 않고 다른 곳으로 이동하면 노트를 자동으로 삭제합니다. 삭제 직후 알림에서 되돌리기 할 수 있습니다.',
								control: { type: 'toggle', key: 'deleteEmptyNewNoteEnabled' },
							},
						],
					},
					{
						type: 'group',
						heading: '홈 노트',
						items: [
							{
								name: '활성화',
								desc: '모든 탭을 닫으면 지정한 노트를 자동으로 엽니다.',
								control: { type: 'toggle', key: 'homeNoteEnabled' },
							},
							{
								name: '노트 경로',
								desc: 'Vault 루트 기준 경로. 예: Home.md, Daily/Home.md',
								control: { type: 'text', key: 'homeNotePath', placeholder: 'Home.md' },
							},
						],
					},
				],
			},
			{
				type: 'page',
				name: '탭',
				items: [
					{
						type: 'group',
						heading: '탭 동작',
						items: [
							{
								name: '중복 탭 방지',
								desc: '이미 열려 있는 파일을 다시 열면 새 탭을 만들지 않고 기존 탭으로 이동합니다.',
								control: { type: 'toggle', key: 'noDuplicateTabsEnabled' },
							},
							{
								name: '모바일: 새 탭으로 열기',
								desc: '모바일에서 파일을 열 때 현재 탭을 대체하지 않고 새 탭으로 엽니다.',
								control: { type: 'toggle', key: 'mobileOpenInNewTabEnabled' },
							},
							{
								name: 'PC: 새 탭으로 열기',
								desc: 'PC에서 파일을 열 때 현재 탭을 대체하지 않고 새 탭으로 엽니다.',
								control: { type: 'toggle', key: 'desktopOpenInNewTabEnabled' },
							},
						],
					},
					{
						type: 'group',
						heading: '탭 목록',
						items: [
							{
								name: '활성화',
								desc: '뷰 헤더에 탭 목록 버튼을 추가합니다. 탭 전환, 핀 고정, 닫기, 드래그 순서 변경을 지원합니다.',
								control: { type: 'toggle', key: 'tabListEnabled' },
							},
						],
					},
				],
			},
			{
				type: 'page',
				name: '파일 탐색기',
				items: [
					{
						type: 'group',
						heading: '핀 고정',
						items: [
							{
								name: '활성화',
								desc: '파일/폴더를 우클릭(모바일: 길게 누르기)하여 핀 고정하면 해당 폴더 최상단에 노출됩니다.',
								control: { type: 'toggle', key: 'pinEnabled' },
							},
							{
								name: '핀 고정 패턴',
								desc: '.gitignore 형식. 한 줄에 하나씩. 예: Daily/, *.canvas, Projects/Important.md',
								control: { type: 'textarea', key: 'pinnedPatterns', placeholder: 'Daily/\nProjects/\n*.canvas', rows: 6 },
							},
						],
					},
					{
						type: 'group',
						heading: '파일 숨기기',
						items: [
							{
								name: '활성화',
								desc: '패턴에 매칭되는 파일/폴더를 파일 탐색기에서 숨깁니다.',
								control: { type: 'toggle', key: 'hideEnabled' },
							},
							{
								name: '숨길 패턴',
								desc: '.gitignore 형식. 한 줄에 하나씩. 예: *.excalidraw.md, _templates/',
								control: { type: 'textarea', key: 'hidePatterns', placeholder: '*.excalidraw.md\n_templates/\n.trash/', rows: 6 },
							},
						],
					},
					{
						type: 'group',
						heading: '하위 폴더 일괄 접기',
						items: [
							{
								name: '활성화',
								desc: Platform.isMobile
									? '폴더를 길게 눌러 나오는 메뉴에서 "하위 폴더 전부 닫기"를 선택합니다.'
									: 'Opt(⌥, Mac) / Alt(Windows)를 누른 채 폴더를 클릭합니다.',
								control: { type: 'toggle', key: 'collapseChildrenEnabled' },
							},
						],
					},
					{
						type: 'group',
						heading: '폴더 액션 버튼',
						items: [
							{
								name: '활성화',
								desc: '파일/폴더에 마우스를 올리면 빠른 액션 버튼이 나타납니다.',
								control: { type: 'toggle', key: 'folderActionsEnabled' },
							},
							{
								name: '새 파일',
								desc: '폴더 안에 새 파일을 만듭니다. (폴더 전용)',
								visible: () => settings.folderActionsEnabled,
								control: { type: 'toggle', key: 'folderActionsShowNewFile' },
							},
							{
								name: '모두 펼치기',
								desc: '하위 폴더를 전부 펼칩니다. (폴더 전용)',
								visible: () => settings.folderActionsEnabled,
								control: { type: 'toggle', key: 'folderActionsShowExpandAll' },
							},
							{
								name: '모두 닫기',
								desc: '하위 폴더를 전부 접습니다. (폴더 전용)',
								visible: () => settings.folderActionsEnabled,
								control: { type: 'toggle', key: 'folderActionsShowCollapseAll' },
							},
							{
								name: '핀 고정/해제',
								desc: '파일과 폴더 모두에 표시됩니다. 핀 고정 기능이 꺼져 있으면 동작하지 않습니다.',
								visible: () => settings.folderActionsEnabled,
								control: { type: 'toggle', key: 'folderActionsShowPin' },
							},
							{
								name: '삭제',
								desc: '파일과 폴더 모두에 표시됩니다. 클릭 시 확인 후 휴지통으로 이동합니다.',
								visible: () => settings.folderActionsEnabled,
								control: { type: 'toggle', key: 'folderActionsShowDelete' },
							},
							{
								name: '경로 복사',
								desc: '파일과 폴더 모두에 표시됩니다. vault 기준 상대 경로를 클립보드에 복사합니다.',
								visible: () => settings.folderActionsEnabled,
								control: { type: 'toggle', key: 'folderActionsShowCopyPath' },
							},
						],
					},
				],
			},
			{
				type: 'page',
				name: '글로벌 핫키',
				visible: () => Platform.isDesktop,
				items: [
					{
						name: '활성화',
						desc: 'Obsidian이 백그라운드에 있어도 단축키로 명령어를 실행합니다.',
						control: { type: 'toggle', key: 'globalHotkeysEnabled' },
					},
					{
						type: 'list',
						name: '등록된 단축키',
						emptyState: '등록된 단축키가 없습니다.',
						items: this.plugin.settings.globalHotkeys.map(hotkey => ({
							name: displayAccelerator(hotkey.accelerator),
							desc: hotkey.commandName,
						})),
						onDelete: async (index: number) => {
							await this.plugin.changeGlobalHotkeys(hotkeys => hotkeys.splice(index, 1));
							this.update();
						},
						addItem: {
							name: '단축키 추가',
							action: () => {
								new GlobalHotkeyModal(this.app, async (accelerator, commandId, commandName) => {
									await this.plugin.changeGlobalHotkeys(hotkeys => hotkeys.push({
										accelerator,
										commandId,
										commandName,
									}));
									this.update();
								}).open();
							},
						},
					},
				],
			},
		];
	}

	// 값 저장은 super.setControlValue(plugin.settings 반영 + 저장)가 담당한다.
	// 여기선 기능별 화면/필터 갱신 같은 부수 효과만 실행한다.
	setControlValue(key: string, value: unknown): void | Promise<void> {
		super.setControlValue(key, value);
		this.applySettingSideEffects(key);
	}

	private applySettingSideEffects(settingKey: string): void {
		switch (settingKey) {
			case 'tabListEnabled':
				if (this.plugin.settings.tabListEnabled) this.plugin.refreshTabList();
				else this.plugin.teardownTabList();
				break;
			case 'globalHotkeysEnabled':
				this.plugin.unregisterGlobalHotkeys();
				if (this.plugin.settings.globalHotkeysEnabled) this.plugin.registerGlobalHotkeys();
				break;
			case 'pinEnabled':
				this.plugin.requestSort();
				if (this.plugin.settings.pinEnabled) this.plugin.applyPinIcons();
				else this.plugin.clearPinDecorations();
				break;
			case 'pinnedPatterns':
				this.plugin.rebuildPinFilter();
				this.plugin.clearPinDecorations();
				this.plugin.applyPinIcons();
				this.plugin.requestSort();
				break;
			case 'hideEnabled':
			case 'hidePatterns':
				this.plugin.rebuildHideFilter();
				this.plugin.requestSort();
				break;
			case 'folderActionsEnabled':
				if (this.plugin.settings.folderActionsEnabled) this.plugin.applyFolderActionButtons();
				else this.plugin.clearFolderActionButtons();
				this.refreshDomState(); // 서브 토글 visible 재평가 (구조 변화 없음 — 재렌더링 불필요)
				break;
			case 'folderActionsShowNewFile':
			case 'folderActionsShowExpandAll':
			case 'folderActionsShowCollapseAll':
			case 'folderActionsShowPin':
			case 'folderActionsShowDelete':
			case 'folderActionsShowCopyPath':
				this.plugin.refreshFolderActionButtons();
				break;
		}
	}
}

// ── 글로벌 핫키 헬퍼 ─────────────────────────────────────────────

function getElectronRemote(): any {
	try {
		return (require('electron') as any).remote ?? null;
	} catch {
		return null;
	}
}

function keyEventToAccelerator(e: KeyboardEvent): string {
	const modifiers: string[] = [];
	if (e.ctrlKey || e.metaKey) modifiers.push('CommandOrControl');
	if (e.altKey) modifiers.push('Alt');
	if (e.shiftKey) modifiers.push('Shift');

	const key = e.key;
	if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return '';

	const normalized = normalizeKeyName(key);
	return [...modifiers, normalized].join('+');
}

function normalizeKeyName(key: string): string {
	const map: Record<string, string> = {
		' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
		'ArrowLeft': 'Left', 'ArrowRight': 'Right',
		'Enter': 'Return', 'Escape': 'Escape',
		'Delete': 'Delete', 'Backspace': 'Backspace', 'Tab': 'Tab',
		'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
	};
	if (map[key]) return map[key];
	if (/^F\d+$/.test(key)) return key;
	if (key.length === 1) return key.toUpperCase();
	return key;
}

function displayAccelerator(acc: string): string {
	if (!acc) return '—';
	const isMac = Platform.isMacOS;
	const parts = acc.split('+');
	return parts.map(p => {
		if (p === 'CommandOrControl') return isMac ? '⌘' : 'Ctrl';
		if (p === 'Shift') return isMac ? '⇧' : 'Shift';
		if (p === 'Alt') return isMac ? '⌥' : 'Alt';
		return p;
	}).join(isMac ? '' : '+');
}

// ── 명령어 자동완성 ───────────────────────────────────────────────

class CommandSuggest extends AbstractInputSuggest<{ id: string; name: string }> {
	private onPick: (cmd: { id: string; name: string }) => void;

	constructor(app: App, inputEl: HTMLInputElement, onPick: (cmd: { id: string; name: string }) => void) {
		super(app, inputEl);
		this.onPick = onPick;
	}

	getSuggestions(query: string): { id: string; name: string }[] {
		const commands = Object.values((this.app as any).commands.commands) as any[];
		const q = query.toLowerCase();
		return commands
			.filter(c => c.name.toLowerCase().includes(q))
			.map(c => ({ id: c.id as string, name: c.name as string }))
			.slice(0, 20);
	}

	renderSuggestion(cmd: { id: string; name: string }, el: HTMLElement) {
		el.setText(cmd.name);
	}

	selectSuggestion(cmd: { id: string; name: string }, _evt: MouseEvent | KeyboardEvent) {
		this.setValue(cmd.name);
		this.onPick(cmd);
		this.close();
	}
}

// ── 글로벌 핫키 추가 모달 ─────────────────────────────────────────

class GlobalHotkeyModal extends Modal {
	private accelerator = '';
	private commandId = '';
	private commandName = '';
	private onSave: (accelerator: string, commandId: string, commandName: string) => void;

	constructor(app: App, onSave: (accelerator: string, commandId: string, commandName: string) => void) {
		super(app);
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oh-aio-hotkey-modal');
		contentEl.createEl('h2', { text: '글로벌 핫키 추가' });

		// ── 단축키 녹화 ────────────────────────────────
		contentEl.createEl('p', { text: '단축키', cls: 'oh-aio-modal-label' });

		const recorderEl = contentEl.createEl('button', {
			cls: 'oh-aio-key-recorder',
			text: '클릭하여 단축키 입력',
		});

		let keyHandler: ((e: KeyboardEvent) => void) | null = null;

		recorderEl.addEventListener('click', () => {
			if (recorderEl.hasClass('is-recording')) return;
			recorderEl.addClass('is-recording');
			recorderEl.setText('단축키를 눌러주세요… (Esc: 취소)');

			keyHandler = (e: KeyboardEvent) => {
				e.preventDefault();
				e.stopPropagation();

				if (e.key === 'Escape') {
					recorderEl.removeClass('is-recording');
					recorderEl.setText(this.accelerator ? displayAccelerator(this.accelerator) : '클릭하여 단축키 입력');
					document.removeEventListener('keydown', keyHandler!, true);
					return;
				}

				const acc = keyEventToAccelerator(e);
				if (!acc) return;

				this.accelerator = acc;
				recorderEl.removeClass('is-recording');
				recorderEl.setText(displayAccelerator(acc));
				document.removeEventListener('keydown', keyHandler!, true);
			};

			document.addEventListener('keydown', keyHandler, true);
		});

		// ── 명령어 선택 ────────────────────────────────
		contentEl.createEl('p', { text: '명령어', cls: 'oh-aio-modal-label' });

		const commandInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: '명령어 검색…',
			cls: 'oh-aio-command-input',
		}) as HTMLInputElement;

		new CommandSuggest(this.app, commandInput, (cmd) => {
			this.commandId = cmd.id;
			this.commandName = cmd.name;
		});

		// ── 저장 / 취소 ────────────────────────────────
		const btnRow = contentEl.createDiv({ cls: 'oh-aio-modal-buttons' });

		const saveBtn = btnRow.createEl('button', { text: '저장', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => {
			if (!this.accelerator) { new Notice('단축키를 입력해주세요.'); return; }
			if (!this.commandId) { new Notice('명령어를 선택해주세요.'); return; }
			this.onSave(this.accelerator, this.commandId, this.commandName);
			this.close();
		});

		const cancelBtn = btnRow.createEl('button', { text: '취소' });
		cancelBtn.addEventListener('click', () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
