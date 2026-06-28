import {
	AbstractInputSuggest,
	App,
	debounce,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
} from 'obsidian';
import { around } from 'monkey-around';
import ignore, { Ignore } from 'ignore';

interface GlobalHotkey {
	id: string;
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
	settingsSearchEnabled: boolean;
	deleteEmptyNewNoteEnabled: boolean;
	noDuplicateTabsEnabled: boolean;
	mobileOpenInNewTabEnabled: boolean;
	desktopOpenInNewTabEnabled: boolean;
	mobileTabListEnabled: boolean;
	mobileBackNavigationEnabled: boolean;
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
	settingsSearchEnabled: true,
	deleteEmptyNewNoteEnabled: true,
	noDuplicateTabsEnabled: true,
	mobileOpenInNewTabEnabled: true,
	desktopOpenInNewTabEnabled: false,
	mobileTabListEnabled: true,
	mobileBackNavigationEnabled: true,
	debugMode: false,
};

export default class OhUtilsPlugin extends Plugin {
	settings: OhUtilsSettings;
	private openingHomeNote = false;
	private sortPatcher: (() => void) | null = null;
	private leafOpenFilePatcher: (() => void) | null = null;
	private mobileTabListPanelEl: HTMLElement | null = null;
	private mobileTabListBackdropEl: HTMLElement | null = null;
	private mobileTabListHeaderButtonEl: HTMLElement | null = null;
	private mobileTabListIsOpen = false;
	private mobileTabListAttachedToContainerEl: HTMLElement | null = null;
	private isHandlingBackNavigation = false;
	private mobileTabListLeafOrder: string[] = [];
	private pinObserver: MutationObserver | null = null;
	private debouncedApplyExplorer = debounce(() => { this.applyPinIcons(); this.applyFolderActionButtons(); }, 50, true);
	private pinFilter: Ignore | null = null;
	private hideFilter: Ignore | null = null;
	private newlyCreatedFilePaths = new Set<string>();
	private previousActiveFilePath: string | null = null;

	log(...args: unknown[]) {
		if (this.settings.debugMode) console.log('[oh-utils]', ...args);
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
							if (isExplorerPinned) {
								this.log('[pin] unpin explorer:', abstractFile.path);
								this.settings.pinnedPatterns = this.removePatternLine(this.settings.pinnedPatterns, abstractFile.path);
								this.removePinIcon(abstractFile.path);
							} else {
								this.log('[pin] pin explorer:', abstractFile.path);
								this.settings.pinnedPatterns = this.addPatternLine(this.settings.pinnedPatterns, abstractFile.path);
							}
							await this.saveSettings();
							this.rebuildPinFilter();
							this.requestSort();
						});
				});

			})
		);

		// 파일 삭제/이름 변경 시 pinnedPatterns 동기화
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
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
			this.setupMobileTabList();
			this.setupAndroidBackNavigation();
			this.registerEvent(
				this.app.workspace.on('layout-change', () => {
					this.refreshMobileTabList();
				})
			);
			this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshMobileTabList()));
		});

		this.addCommand({
			id: 'toggle-mobile-tab-list',
			name: '모바일 탭 목록 열기/닫기',
			checkCallback: (checking: boolean) => {
				if (!Platform.isMobile || !this.settings.mobileTabListEnabled || !this.mobileTabListHeaderButtonEl) return false;
				if (!checking) this.toggleMobileTabList();
				return true;
			},
		});

		this.addSettingTab(new OhUtilsSettingTab(this.app, this));
	}

	async onunload() {
		this.sortPatcher?.();
		this.leafOpenFilePatcher?.();
		this.pinObserver?.disconnect();
		this.clearPinDecorations();
		this.clearFolderActionButtons();
		this.teardownMobileTabList();
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

	// ── 모바일 탭 목록 ───────────────────────────────────────

	setupMobileTabList(): void {
		if (!this.settings.mobileTabListEnabled) return;
		this.refreshMobileTabList();
	}

	// ── 안드로이드 뒤로가기 ─────────────────────────────────────

	setupAndroidBackNavigation(): void {
		if (!Platform.isAndroidApp) return;
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (this.isHandlingBackNavigation || !this.settings.mobileBackNavigationEnabled || !file) return;
			this.log('[android-back] file-open → push history state:', file.path);
			window.history.pushState(null, '');
		}));
		this.registerDomEvent(window, 'popstate', () => {
			if (this.mobileTabListIsOpen) {
				this.closeMobileTabList();
				window.history.pushState(null, '');
				return;
			}
			if (!this.settings.mobileBackNavigationEnabled) return;
			this.log('[android-back] popstate → navigate back');
			this.isHandlingBackNavigation = true;
			this.navigateBackInWorkspace();
			// file-open 이벤트가 비동기로 발생하므로 한 틱 뒤 플래그를 해제한다
			setTimeout(() => { this.isHandlingBackNavigation = false; }, 0);
			// 재push 없음 — state 소모가 곧 뒤로가기 한 단계, 모두 소모 시 앱 종료
		});
	}

	private navigateBackInWorkspace(): void {
		const workspace = this.app.workspace as any;
		if (typeof workspace.navigateBack === 'function') {
			workspace.navigateBack();
		} else {
			(this.app as any).commands?.executeCommandById?.('app:go-back');
		}
	}

	teardownMobileTabList(): void {
		this.mobileTabListHeaderButtonEl?.remove();
		this.mobileTabListPanelEl?.remove();
		this.mobileTabListBackdropEl?.remove();
		this.mobileTabListHeaderButtonEl = null;
		this.mobileTabListPanelEl = null;
		this.mobileTabListBackdropEl = null;
		this.mobileTabListAttachedToContainerEl = null;
		this.mobileTabListIsOpen = false;
	}

	refreshMobileTabList(): void {
		if (!this.settings.mobileTabListEnabled) return;

		const leaf = this.app.workspace.getMostRecentLeaf();
		const containerEl = (leaf?.view as any)?.containerEl as HTMLElement | undefined;
		if (!containerEl) return;

		if (containerEl !== this.mobileTabListAttachedToContainerEl) {
			this.mobileTabListHeaderButtonEl?.remove();
			this.mobileTabListHeaderButtonEl = null;
			this.mobileTabListIsOpen = false;
			this.mobileTabListAttachedToContainerEl = containerEl;

			const headerEl = containerEl.querySelector('.view-header') as HTMLElement | null;
			if (headerEl) this.attachMobileTabListButton(headerEl);
		}

		if (this.mobileTabListIsOpen) this.rebuildMobileTabListRows();
	}

	private attachMobileTabListButton(headerEl: HTMLElement): void {
		const buttonEl = createEl('div', { cls: 'oh-aio-mobile-tab-list-btn clickable-icon' });
		setIcon(buttonEl, 'layers-2');
		buttonEl.setAttribute('aria-label', '탭 목록');
		buttonEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleMobileTabList();
		});
		const actionsEl = headerEl.querySelector('.view-actions');
		if (actionsEl) actionsEl.insertBefore(buttonEl, actionsEl.firstChild);
		else headerEl.appendChild(buttonEl);
		this.mobileTabListHeaderButtonEl = buttonEl;
	}

	private toggleMobileTabList(): void {
		if (this.mobileTabListIsOpen) this.closeMobileTabList();
		else this.openMobileTabList();
	}

	private openMobileTabList(): void {
		if (!this.mobileTabListHeaderButtonEl) return;

		if (!this.mobileTabListBackdropEl) {
			const backdropEl = createEl('div', { cls: 'oh-aio-mobile-tab-backdrop' });
			backdropEl.addEventListener('click', () => this.closeMobileTabList());
			document.body.appendChild(backdropEl);
			this.mobileTabListBackdropEl = backdropEl;
		}
		if (!this.mobileTabListPanelEl) {
			const panelEl = createEl('div', { cls: 'oh-aio-mobile-tab-panel' });
			document.body.appendChild(panelEl);
			this.mobileTabListPanelEl = panelEl;
		}

		const buttonBottom = this.mobileTabListHeaderButtonEl.getBoundingClientRect().bottom;
		this.mobileTabListPanelEl.style.top = buttonBottom + 'px';

		this.rebuildMobileTabListRows();
		this.mobileTabListIsOpen = true;
		this.mobileTabListPanelEl.addClass('is-open');
		this.mobileTabListBackdropEl.addClass('is-open');
		this.mobileTabListHeaderButtonEl.addClass('is-active');
	}

	private closeMobileTabList(): void {
		this.mobileTabListIsOpen = false;
		this.mobileTabListPanelEl?.removeClass('is-open');
		this.mobileTabListBackdropEl?.removeClass('is-open');
		this.mobileTabListHeaderButtonEl?.removeClass('is-active');
	}

	private rebuildMobileTabListRows(): void {
		if (!this.mobileTabListPanelEl) return;
		if (this.mobileTabListHeaderButtonEl) {
			this.mobileTabListPanelEl.style.top = this.mobileTabListHeaderButtonEl.getBoundingClientRect().bottom + 'px';
		}
		this.mobileTabListPanelEl.empty();

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
			this.mobileTabListPanelEl.createEl('div', {
				cls: 'oh-aio-mobile-tab-empty',
				text: '열린 탭이 없습니다.',
			});
			return;
		}

		const sortedLeaves = this.applyMobileTabLeafOrder(openLeaves);
		for (const openLeaf of sortedLeaves) {
			const file = (openLeaf.view as any).file as TFile;
			const isActive = file.path === activeFile?.path;
			const isFilePinned = pinnedPathSet.has(file.path);
			this.buildMobileTabRow(this.mobileTabListPanelEl, openLeaf, file, isActive, isFilePinned);
		}

		for (const file of pinnedClosedFiles) {
			this.buildMobileTabPinnedClosedRow(this.mobileTabListPanelEl, file);
		}
	}

	private buildMobileTabRow(
		containerEl: HTMLElement,
		leaf: WorkspaceLeaf,
		file: TFile,
		isActive: boolean,
		isPinnedFile: boolean,
	): void {
		const rowEl = createEl('div', { cls: 'oh-aio-mobile-tab-row' });
		rowEl.dataset.filePath = file.path;
		if (isActive) rowEl.addClass('is-active');

		const deleteBackgroundEl = rowEl.createEl('div', { cls: 'oh-aio-mobile-tab-row-delete-bg' });
		const deleteIconEl = deleteBackgroundEl.createEl('span');
		setIcon(deleteIconEl, 'trash-2');

		const innerEl = rowEl.createEl('div', { cls: 'oh-aio-mobile-tab-row-inner' });

		if (isPinnedFile) {
			const pinIconEl = innerEl.createEl('span', { cls: 'oh-aio-mobile-tab-row-pin' });
			setIcon(pinIconEl, 'pin');
		}

		this.buildMobileTabFileText(innerEl, file);

		// 핀 토글 버튼
		const pinButtonEl = innerEl.createEl('div', { cls: 'oh-aio-mobile-tab-row-pin-btn clickable-icon' });
		setIcon(pinButtonEl, isPinnedFile ? 'pin-off' : 'pin');
		pinButtonEl.setAttribute('aria-label', isPinnedFile ? '핀 해제' : '핀 고정');
		pinButtonEl.addEventListener('click', (e) => {
			e.stopPropagation();
			if (isPinnedFile) {
				this.unpinFile(file.path);
			} else {
				this.settings.pinnedPatterns = this.addPatternLine(this.settings.pinnedPatterns, file.path);
				this.rebuildPinFilter();
				this.requestSort();
				this.saveSettings();
				this.rebuildMobileTabListRows();
			}
		});

		// 드래그 핸들
		const dragHandleEl = innerEl.createEl('div', { cls: 'oh-aio-mobile-tab-row-drag-handle' });
		setIcon(dragHandleEl, 'grip-vertical');

		containerEl.appendChild(rowEl);

		// 탭 전환
		innerEl.addEventListener('click', () => {
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
			this.closeMobileTabList();
		});

		this.attachMobileTabSwipeToDelete(rowEl, innerEl, leaf, file.path);
		this.setupMobileTabRowDrag(rowEl, dragHandleEl, file.path);
	}

	private buildMobileTabPinnedClosedRow(containerEl: HTMLElement, file: TFile): void {
		const rowEl = createEl('div', { cls: 'oh-aio-mobile-tab-row is-pinned-closed' });
		const innerEl = rowEl.createEl('div', { cls: 'oh-aio-mobile-tab-row-inner' });

		const pinIconEl = innerEl.createEl('span', { cls: 'oh-aio-mobile-tab-row-pin' });
		setIcon(pinIconEl, 'pin');

		this.buildMobileTabFileText(innerEl, file);

		const unpinButtonEl = innerEl.createEl('div', { cls: 'oh-aio-mobile-tab-row-pin-btn clickable-icon' });
		setIcon(unpinButtonEl, 'pin-off');
		unpinButtonEl.setAttribute('aria-label', '핀 해제');
		unpinButtonEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.unpinFile(file.path);
		});

		const dragHandleEl = innerEl.createEl('div', { cls: 'oh-aio-mobile-tab-row-drag-handle' });
		setIcon(dragHandleEl, 'grip-vertical');

		containerEl.appendChild(rowEl);

		innerEl.addEventListener('click', () => {
			this.app.workspace.getLeaf(false).openFile(file);
			this.closeMobileTabList();
		});

		this.setupMobileTabPinnedClosedRowDrag(rowEl, dragHandleEl, file.path);
	}

	private setupMobileTabPinnedClosedRowDrag(rowEl: HTMLElement, dragHandleEl: HTMLElement, filePath: string): void {
		this.setupMobileTabRowDragBase(
			rowEl,
			dragHandleEl,
			'.oh-aio-mobile-tab-row.is-pinned-closed:not(.is-dragging)',
			(targetIndex) => {
				const lines = this.settings.pinnedPatterns.split('\n').filter(l => l.trim());
				const currentIndex = lines.indexOf(filePath);
				if (currentIndex !== -1) {
					lines.splice(currentIndex, 1);
					lines.splice(targetIndex, 0, filePath);
					this.settings.pinnedPatterns = lines.join('\n');
					this.saveSettings();
					this.rebuildMobileTabListRows();
				}
			},
		);
	}

	private buildMobileTabFileText(innerEl: HTMLElement, file: TFile): void {
		const textEl = innerEl.createEl('div', { cls: 'oh-aio-mobile-tab-row-text' });
		const displayName = file.extension === 'md' ? file.basename : file.name;
		textEl.createEl('span', { cls: 'oh-aio-mobile-tab-row-name', text: displayName });
		if (file.parent && file.parent.path !== '/') {
			textEl.createEl('span', { cls: 'oh-aio-mobile-tab-row-path', text: file.parent.path });
		}
	}

	private attachMobileTabSwipeToDelete(
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

	private applyMobileTabLeafOrder(leaves: WorkspaceLeaf[]): WorkspaceLeaf[] {
		if (this.mobileTabListLeafOrder.length === 0) {
			this.mobileTabListLeafOrder = leaves.map(l => (l.view as any)?.file?.path as string).filter(Boolean);
			return leaves;
		}
		const orderMap = new Map(this.mobileTabListLeafOrder.map((p, i) => [p, i]));
		const sorted = [...leaves].sort((a, b) => {
			const ap = (a.view as any)?.file?.path ?? '';
			const bp = (b.view as any)?.file?.path ?? '';
			return (orderMap.has(ap) ? orderMap.get(ap)! : Infinity) - (orderMap.has(bp) ? orderMap.get(bp)! : Infinity);
		});
		this.mobileTabListLeafOrder = sorted.map(l => (l.view as any)?.file?.path as string).filter(Boolean);
		return sorted;
	}

	private setupMobileTabRowDragBase(
		rowEl: HTMLElement,
		dragHandleEl: HTMLElement,
		draggableRowSelector: string,
		onDrop: (targetIndex: number) => void,
	): void {
		const panelEl = this.mobileTabListPanelEl;
		if (!panelEl) return;

		dragHandleEl.addEventListener('touchstart', (e) => {
			e.stopPropagation();

			const startY = e.touches[0].clientY;
			const rect = rowEl.getBoundingClientRect();

			const cloneEl = rowEl.cloneNode(true) as HTMLElement;
			cloneEl.classList.add('oh-aio-mobile-tab-row-drag-clone');
			cloneEl.style.top = rect.top + 'px';
			cloneEl.style.left = rect.left + 'px';
			cloneEl.style.width = rect.width + 'px';
			document.body.appendChild(cloneEl);

			rowEl.classList.add('is-dragging');

			const indicatorEl = createEl('div', { cls: 'oh-aio-mobile-tab-drop-indicator' });
			panelEl.appendChild(indicatorEl);

			// touchmove마다 DOM 쿼리·레이아웃 flush를 막기 위해 touchstart 시점에 스냅샷
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

			const onMove = (ev: TouchEvent) => {
				const touchY = ev.touches[0].clientY;
				cloneEl.style.transform = `translateY(${touchY - startY}px)`;

				targetIndex = rowSnapshots.length;
				let indicatorTop = -1;

				for (let i = 0; i < rowSnapshots.length; i++) {
					if (touchY < rowSnapshots[i].midY) {
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

				document.removeEventListener('touchmove', onMove);
				document.removeEventListener('touchend', onEnd);

				if (targetIndex >= 0) onDrop(targetIndex);
			};

			document.addEventListener('touchmove', onMove, { passive: true });
			document.addEventListener('touchend', onEnd);
		}, { passive: true });
	}

	private setupMobileTabRowDrag(rowEl: HTMLElement, dragHandleEl: HTMLElement, filePath: string): void {
		this.setupMobileTabRowDragBase(
			rowEl,
			dragHandleEl,
			'.oh-aio-mobile-tab-row[data-file-path]:not(.is-dragging)',
			(targetIndex) => {
				const newOrder = this.mobileTabListLeafOrder.filter(p => p !== filePath);
				newOrder.splice(targetIndex, 0, filePath);
				this.mobileTabListLeafOrder = newOrder;
				this.rebuildMobileTabListRows();
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

	private unpinFile(filePath: string): void {
		this.settings.pinnedPatterns = this.removePatternLine(this.settings.pinnedPatterns, filePath);
		this.rebuildPinFilter();
		this.requestSort();
		this.saveSettings();
		this.rebuildMobileTabListRows();
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
					const wasPinned = this.hasExactPinPattern(item.file.path);
					if (wasPinned) {
						this.settings.pinnedPatterns = this.settings.pinnedPatterns
							.split('\n')
							.filter(line => line.trim() !== item.file.path)
							.join('\n');
						this.removePinIcon(item.file.path);
					} else {
						const current = this.settings.pinnedPatterns.trimEnd();
						this.settings.pinnedPatterns = current
							? current + '\n' + item.file.path
							: item.file.path;
					}
					// 클릭 즉시 아이콘 업데이트 (DOM 재렌더 대기 안 함)
					this.refreshPinButton(pinBtn, item.file.path);
					await this.saveSettings();
					this.rebuildPinFilter();
					this.requestSort();
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
			try {
				remote.globalShortcut.register(hotkey.accelerator, () => {
					const win = remote.getCurrentWindow();
					this.log('[global-hotkey] triggered:', hotkey.accelerator, '→', hotkey.commandId,
						'| window visible:', win.isVisible());
					if (!win.isVisible()) win.show();
					win.focus();
					const cmd = (this.app as any).commands.commands[hotkey.commandId];
					if (!cmd) {
						this.log('[global-hotkey] command not found:', hotkey.commandId);
						return;
					}
					if (cmd.checkCallback) cmd.checkCallback(false);
					else if (cmd.callback) cmd.callback();
				});
				this.log('[global-hotkey] registered:', hotkey.accelerator, '→', hotkey.commandId);
			} catch {
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

	async loadSettings() {
		const data = await this.loadData();
		// COMPAT(pinnedPaths-to-pinnedPatterns): string[] -> string 변환 (schema migration, v0.x)
		//   우클릭으로 핀 고정했던 정확한 경로 배열을 줄바꿈 구분 패턴 문자열로 이전한다
		// COMPAT-REMOVE-WHEN: pinnedPaths 배열이 포함된 저장 파일 비율이 0%로 확인된 후 30일 경과 시
		if (data?.pinnedPaths && Array.isArray(data.pinnedPaths) && !data.pinnedPatterns) {
			data.pinnedPatterns = (data.pinnedPaths as string[]).join('\n');
			delete data.pinnedPaths;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

type SettingsTab = 'general' | 'note' | 'tab' | 'fileExplorer' | 'globalHotkeys';

class OhUtilsSettingTab extends PluginSettingTab {
	plugin: OhUtilsPlugin;
	private activeTab: SettingsTab = 'general';
	private searchQuery = '';

	constructor(app: App, plugin: OhUtilsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── 검색창 ────────────────────────────────────────────
		if (this.plugin.settings.settingsSearchEnabled) {
			const searchInput = containerEl.createEl('input', {
				type: 'search',
				placeholder: '설정 검색…',
				cls: 'oh-aio-search-input',
				attr: { 'aria-label': '설정 검색' },
			}) as HTMLInputElement;
			searchInput.value = this.searchQuery;

			const contentEl = containerEl.createDiv();
			const updateContent = () => {
				contentEl.empty();
				if (this.searchQuery) {
					this.renderSearchResults(contentEl, this.searchQuery.toLowerCase());
				} else {
					this.renderTabsContent(contentEl);
				}
			};

			// IME 조합 중에는 갱신을 건너뜀 — 한글 자모 깨짐 방지
			let isComposing = false;
			searchInput.addEventListener('compositionstart', () => { isComposing = true; });
			searchInput.addEventListener('compositionend', () => {
				isComposing = false;
				this.searchQuery = searchInput.value.trim();
				updateContent();
			});
			searchInput.addEventListener('input', () => {
				if (isComposing) return;
				this.searchQuery = searchInput.value.trim();
				updateContent();
			});

			updateContent();
			return;
		}

		this.renderTabsContent(containerEl);
	}

	private get tabDefinitions(): { id: SettingsTab; label: string; render: (el: HTMLElement) => void }[] {
		return [
			{ id: 'general',       label: '일반',       render: el => this.renderGeneral(el) },
			{ id: 'note',          label: '노트',        render: el => this.renderNote(el) },
			{ id: 'tab',           label: '탭',          render: el => this.renderTab(el) },
			{ id: 'fileExplorer',  label: '파일 탐색기', render: el => this.renderFileExplorer(el) },
			{ id: 'globalHotkeys', label: '글로벌 핫키', render: el => this.renderGlobalHotkeys(el) },
		];
	}

	private renderTabsContent(containerEl: HTMLElement): void {
		const tabBar = containerEl.createDiv({ cls: 'oh-aio-tab-bar' });
		for (const tab of this.tabDefinitions) {
			const btn = tabBar.createEl('button', {
				text: tab.label,
				cls: 'oh-aio-tab-btn' + (this.activeTab === tab.id ? ' is-active' : ''),
			});
			btn.addEventListener('click', () => {
				this.activeTab = tab.id;
				this.display();
			});
		}
		this.tabDefinitions.find(t => t.id === this.activeTab)?.render(containerEl);
	}

	private renderSearchResults(containerEl: HTMLElement, query: string): void {
		const tempEl = createDiv();
		for (const tab of this.tabDefinitions) {
			tab.render(tempEl);
		}

		let currentHeadingEl: HTMLElement | null = null;
		let lastAppendedHeadingEl: HTMLElement | null = null;
		let matchCount = 0;

		for (const item of Array.from(tempEl.querySelectorAll<HTMLElement>('.setting-item'))) {
			if (item.classList.contains('setting-item-heading')) {
				currentHeadingEl = item;
				continue;
			}
			const nameText = item.querySelector('.setting-item-name')?.textContent?.toLowerCase() ?? '';
			const descText = item.querySelector('.setting-item-description')?.textContent?.toLowerCase() ?? '';
			if (!nameText.includes(query) && !descText.includes(query)) continue;

			// 이 섹션의 헤딩이 아직 출력되지 않았으면 먼저 표시
			if (currentHeadingEl && currentHeadingEl !== lastAppendedHeadingEl) {
				containerEl.appendChild(currentHeadingEl.cloneNode(true));
				lastAppendedHeadingEl = currentHeadingEl;
			}
			containerEl.appendChild(item);
			matchCount++;
		}

		if (matchCount === 0) {
			containerEl.createEl('p', {
				text: `"${this.searchQuery}"에 해당하는 설정이 없습니다.`,
				cls: 'oh-aio-search-empty',
			});
		}
	}

	private renderGeneral(containerEl: HTMLElement): void {
		// ── 설정 탭 ──────────────────────────────────────────
		new Setting(containerEl).setName('설정 탭').setHeading();
		new Setting(containerEl)
			.setName('설정 검색')
			.setDesc('설정 탭 상단에 검색창을 표시합니다. 모든 탭의 설정 항목을 한 번에 검색할 수 있습니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.settingsSearchEnabled)
					.onChange(async (value) => {
						this.plugin.settings.settingsSearchEnabled = value;
						await this.plugin.saveSettings();
						this.searchQuery = '';
						this.display();
					})
			);

		// ── 디버그 ───────────────────────────────────────────
		new Setting(containerEl).setName('디버그').setHeading();
		new Setting(containerEl)
			.setName('디버그 모드')
			.setDesc('각 기능의 동작을 브라우저 콘솔(Ctrl+Shift+I)에 verbose하게 출력합니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.debugMode)
					.onChange(async (value) => {
						this.plugin.settings.debugMode = value;
						await this.plugin.saveSettings();
						if (value) console.log('[oh-utils] debug mode enabled');
					})
			);
	}

	private renderNote(containerEl: HTMLElement): void {
		// ── 빈 새 노트 자동 삭제 ─────────────────────────────
		new Setting(containerEl).setName('빈 새 노트 자동 삭제').setHeading();
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('새로 만든 노트에 아무것도 입력하지 않고 다른 곳으로 이동하면 노트를 자동으로 삭제합니다. 삭제 직후 알림에서 되돌리기 할 수 있습니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.deleteEmptyNewNoteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.deleteEmptyNewNoteEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		// ── 홈 노트 ──────────────────────────────────────────
		new Setting(containerEl).setName('홈 노트').setHeading();
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('모든 탭을 닫으면 지정한 노트를 자동으로 엽니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.homeNoteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.homeNoteEnabled = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName('노트 경로')
			.setDesc('Vault 루트 기준 경로. 예: Home.md, Daily/Home.md')
			.addText(text =>
				text
					.setPlaceholder('Home.md')
					.setValue(this.plugin.settings.homeNotePath)
					.onChange(async (value) => {
						this.plugin.settings.homeNotePath = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}

	private renderTab(containerEl: HTMLElement): void {
		// ── 탭 동작 ──────────────────────────────────────────
		new Setting(containerEl).setName('탭 동작').setHeading();
		new Setting(containerEl)
			.setName('중복 탭 방지')
			.setDesc('이미 열려 있는 파일을 다시 열면 새 탭을 만들지 않고 기존 탭으로 이동합니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.noDuplicateTabsEnabled)
					.onChange(async (value) => {
						this.plugin.settings.noDuplicateTabsEnabled = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName('모바일: 새 탭으로 열기')
			.setDesc('모바일에서 파일을 열 때 현재 탭을 대체하지 않고 새 탭으로 엽니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.mobileOpenInNewTabEnabled)
					.onChange(async (value) => {
						this.plugin.settings.mobileOpenInNewTabEnabled = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName('PC: 새 탭으로 열기')
			.setDesc('PC에서 파일을 열 때 현재 탭을 대체하지 않고 새 탭으로 엽니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.desktopOpenInNewTabEnabled)
					.onChange(async (value) => {
						this.plugin.settings.desktopOpenInNewTabEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		// ── 모바일 탭 목록 ───────────────────────────────────
		new Setting(containerEl).setName('모바일 탭 목록').setHeading();
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('뷰 헤더에 탭 목록 버튼을 추가합니다. 탭 전환, 스와이프로 닫기, 롱프레스로 닫기·탐색기에서 보기를 지원합니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.mobileTabListEnabled)
					.onChange(async (value) => {
						this.plugin.settings.mobileTabListEnabled = value;
						await this.plugin.saveSettings();
						if (value) this.plugin.setupMobileTabList();
						else this.plugin.teardownMobileTabList();
					})
			);

		// ── 안드로이드 뒤로가기 ─────────────────────────────
		new Setting(containerEl).setName('안드로이드 뒤로가기').setHeading();
		if (!Platform.isAndroidApp) {
			containerEl.createEl('p', {
				text: '안드로이드 앱에서만 사용 가능합니다.',
				cls: 'oh-aio-notice-text',
			});
			return;
		}
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('뒤로가기 버튼을 누르면 앱을 종료하는 대신 이전 파일로 이동합니다. 더 이상 이동할 파일이 없으면 앱이 종료됩니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.mobileBackNavigationEnabled)
					.onChange(async (value) => {
						this.plugin.settings.mobileBackNavigationEnabled = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderGlobalHotkeys(containerEl: HTMLElement): void {
		// ── 글로벌 핫키 ──────────────────────────────────────
		new Setting(containerEl).setName('글로벌 핫키').setHeading();

		if (!Platform.isDesktop) {
			containerEl.createEl('p', {
				text: '글로벌 핫키는 데스크탑에서만 사용 가능합니다.',
				cls: 'oh-aio-notice-text',
			});
			return;
		}

		new Setting(containerEl)
			.setName('활성화')
			.setDesc('Obsidian이 백그라운드에 있어도 단축키로 명령어를 실행합니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.globalHotkeysEnabled)
					.onChange(async (value) => {
						this.plugin.settings.globalHotkeysEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.unregisterGlobalHotkeys();
						if (value) this.plugin.registerGlobalHotkeys();
					})
			);

		const { globalHotkeys } = this.plugin.settings;
		if (globalHotkeys.length > 0) {
			const listEl = containerEl.createDiv({ cls: 'oh-aio-hotkey-list' });
			for (const hotkey of globalHotkeys) {
				const rowEl = listEl.createDiv({ cls: 'oh-aio-hotkey-row' });
				rowEl.createEl('kbd', {
					text: displayAccelerator(hotkey.accelerator),
					cls: 'oh-aio-key-badge',
				});
				rowEl.createSpan({ text: hotkey.commandName, cls: 'oh-aio-hotkey-command' });
				const delBtn = rowEl.createEl('button', { text: '삭제', cls: 'oh-aio-hotkey-delete' });
				delBtn.addEventListener('click', async () => {
					this.plugin.unregisterGlobalHotkeys();
					this.plugin.settings.globalHotkeys = globalHotkeys.filter(h => h.id !== hotkey.id);
					await this.plugin.saveSettings();
					this.plugin.registerGlobalHotkeys();
					this.display();
				});
			}
		}

		new Setting(containerEl)
			.addButton(btn =>
				btn
					.setButtonText('+ 단축키 추가')
					.setCta()
					.onClick(() => {
						new GlobalHotkeyModal(this.plugin.app, async (accelerator, commandId, commandName) => {
							this.plugin.unregisterGlobalHotkeys();
							this.plugin.settings.globalHotkeys.push({
								id: Date.now().toString(36),
								accelerator,
								commandId,
								commandName,
							});
							await this.plugin.saveSettings();
							this.plugin.registerGlobalHotkeys();
							this.display();
						}).open();
					})
			);
	}

	private renderFileExplorer(containerEl: HTMLElement): void {
		// ── 핀 고정 ──────────────────────────────────────────
		new Setting(containerEl).setName('핀 고정').setHeading();
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('파일/폴더를 우클릭(모바일: 길게 누르기)하여 핀 고정하면 해당 폴더 최상단에 노출됩니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.pinEnabled)
					.onChange(async (value) => {
						this.plugin.settings.pinEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.requestSort();
						if (!value) this.plugin.clearPinDecorations();
						else this.plugin.applyPinIcons();
					})
			);
		new Setting(containerEl)
			.setName('핀 고정 패턴')
			.setDesc('.gitignore 형식. 한 줄에 하나씩. 예: Daily/, *.canvas, Projects/Important.md')
			.addTextArea(text => {
				text
					.setPlaceholder('Daily/\nProjects/\n*.canvas')
					.setValue(this.plugin.settings.pinnedPatterns)
					.onChange(async (value) => {
						this.plugin.settings.pinnedPatterns = value;
						await this.plugin.saveSettings();
						this.plugin.rebuildPinFilter();
						this.plugin.clearPinDecorations();
						this.plugin.applyPinIcons();
						this.plugin.requestSort();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'var(--font-monospace)';
			});

		// ── 파일 숨기기 ──────────────────────────────────────
		new Setting(containerEl).setName('파일 숨기기').setHeading();
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('패턴에 매칭되는 파일/폴더를 파일 탐색기에서 숨깁니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.hideEnabled)
					.onChange(async (value) => {
						this.plugin.settings.hideEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.requestSort();
					})
			);
		new Setting(containerEl)
			.setName('숨길 패턴')
			.setDesc('.gitignore 형식. 한 줄에 하나씩. 예: *.excalidraw.md, _templates/')
			.addTextArea(text => {
				text
					.setPlaceholder('*.excalidraw.md\n_templates/\n.trash/')
					.setValue(this.plugin.settings.hidePatterns)
					.onChange(async (value) => {
						this.plugin.settings.hidePatterns = value;
						await this.plugin.saveSettings();
						this.plugin.rebuildHideFilter();
						this.plugin.requestSort();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'var(--font-monospace)';
			});

		// ── 하위 폴더 일괄 접기 ──────────────────────────────
		new Setting(containerEl).setName('하위 폴더 일괄 접기').setHeading();
		const collapseDesc = Platform.isMobile
			? '폴더를 길게 눌러 나오는 메뉴에서 "하위 폴더 전부 닫기"를 선택합니다.'
			: 'Opt(⌥, Mac) / Alt(Windows)를 누른 채 폴더를 클릭합니다.';
		new Setting(containerEl)
			.setName('활성화')
			.setDesc(collapseDesc)
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.collapseChildrenEnabled)
					.onChange(async (value) => {
						this.plugin.settings.collapseChildrenEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		// ── 폴더 액션 버튼 ───────────────────────────────────
		new Setting(containerEl).setName('폴더 액션 버튼').setHeading();
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('파일/폴더에 마우스를 올리면 빠른 액션 버튼이 나타납니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.folderActionsEnabled)
					.onChange(async (value) => {
						this.plugin.settings.folderActionsEnabled = value;
						await this.plugin.saveSettings();
						if (value) this.plugin.applyFolderActionButtons();
						else this.plugin.clearFolderActionButtons();
						this.display();
					})
			);

		if (this.plugin.settings.folderActionsEnabled) {
			const subEl = containerEl.createDiv({ cls: 'oh-aio-sub-settings' });

			new Setting(subEl)
				.setName('새 파일')
				.setDesc('폴더 안에 새 파일을 만듭니다. (폴더 전용)')
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.folderActionsShowNewFile)
						.onChange(async (value) => {
							this.plugin.settings.folderActionsShowNewFile = value;
							await this.plugin.saveSettings();
							this.plugin.refreshFolderActionButtons();
						})
				);

			new Setting(subEl)
				.setName('모두 펼치기')
				.setDesc('하위 폴더를 전부 펼칩니다. (폴더 전용)')
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.folderActionsShowExpandAll)
						.onChange(async (value) => {
							this.plugin.settings.folderActionsShowExpandAll = value;
							await this.plugin.saveSettings();
							this.plugin.refreshFolderActionButtons();
						})
				);

			new Setting(subEl)
				.setName('모두 닫기')
				.setDesc('하위 폴더를 전부 접습니다. (폴더 전용)')
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.folderActionsShowCollapseAll)
						.onChange(async (value) => {
							this.plugin.settings.folderActionsShowCollapseAll = value;
							await this.plugin.saveSettings();
							this.plugin.refreshFolderActionButtons();
						})
				);

			new Setting(subEl)
				.setName('핀 고정/해제')
				.setDesc('파일과 폴더 모두에 표시됩니다. 핀 고정 기능이 꺼져 있으면 동작하지 않습니다.')
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.folderActionsShowPin)
						.onChange(async (value) => {
							this.plugin.settings.folderActionsShowPin = value;
							await this.plugin.saveSettings();
							this.plugin.refreshFolderActionButtons();
						})
				);

			new Setting(subEl)
				.setName('삭제')
				.setDesc('파일과 폴더 모두에 표시됩니다. 클릭 시 확인 후 휴지통으로 이동합니다.')
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.folderActionsShowDelete)
						.onChange(async (value) => {
							this.plugin.settings.folderActionsShowDelete = value;
							await this.plugin.saveSettings();
							this.plugin.refreshFolderActionButtons();
						})
				);
			new Setting(subEl)
				.setName('경로 복사')
				.setDesc('파일과 폴더 모두에 표시됩니다. vault 기준 상대 경로를 클립보드에 복사합니다.')
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.folderActionsShowCopyPath)
						.onChange(async (value) => {
							this.plugin.settings.folderActionsShowCopyPath = value;
							await this.plugin.saveSettings();
							this.plugin.refreshFolderActionButtons();
						})
				);
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
