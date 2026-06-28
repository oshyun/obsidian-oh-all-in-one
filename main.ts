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
	tabPinEnabled: boolean;
	tabPinnedPaths: string;
	hideEnabled: boolean;
	hidePatterns: string;
	globalHotkeysEnabled: boolean;
	globalHotkeys: GlobalHotkey[];
	settingsSearchEnabled: boolean;
	deleteEmptyNewNoteEnabled: boolean;
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
	tabPinEnabled: false,
	tabPinnedPaths: '',
	hideEnabled: false,
	hidePatterns: '',
	globalHotkeysEnabled: false,
	globalHotkeys: [],
	settingsSearchEnabled: true,
	deleteEmptyNewNoteEnabled: true,
	debugMode: false,
};

export default class OhUtilsPlugin extends Plugin {
	settings: OhUtilsSettings;
	private openingHomeNote = false;
	private sortPatcher: (() => void) | null = null;
	private reopeningTabPinnedFiles = false;
	private pinObserver: MutationObserver | null = null;
	private debouncedApplyExplorer = debounce(() => { this.applyPinIcons(); this.applyFolderActionButtons(); }, 50, true);
	private pinFilter: Ignore | null = null;
	private tabPinFilter: Ignore | null = null;
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

				// getLeavesOfType('markdown') 대신 iterateAllLeaves를 쓴다.
				// getLeavesOfType은 PDF·캔버스·이미지 등 비마크다운 파일을 무시하므로,
				// 그 파일만 남아 있을 때도 홈 노트를 강제로 열어 버린다.
				const homeNoteName = normalizePath(this.settings.homeNotePath);
				let hasNonHomeNoteFile = false;
				let existingHomeNoteLeaf: any = null;
				this.app.workspace.iterateAllLeaves((leaf) => {
					const leafFile = (leaf.view as any)?.file;
					if (!leafFile) return;
					if (leafFile.path === homeNoteName) {
						existingHomeNoteLeaf = leaf;
					} else {
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

				if (abstractFile instanceof TFile && this.settings.tabPinEnabled) {
					const isTabPinned = this.hasExactTabPin(abstractFile.path);
					menu.addItem(item => {
						item
							.setTitle(isTabPinned ? '탭 핀 해제' : '탭 핀 고정')
							.setIcon(isTabPinned ? 'pin-off' : 'pin')
							.onClick(async () => {
								if (isTabPinned) {
									this.log('[tab-pin] unpin:', abstractFile.path);
									this.settings.tabPinnedPaths = this.removePatternLine(this.settings.tabPinnedPaths, abstractFile.path);
								} else {
									this.log('[tab-pin] pin:', abstractFile.path);
									this.settings.tabPinnedPaths = this.addPatternLine(this.settings.tabPinnedPaths, abstractFile.path);
								}
								this.rebuildTabPinFilter();
								let openLeaf: WorkspaceLeaf | null = null;
								this.app.workspace.iterateAllLeaves(leaf => {
									if ((leaf.view as any)?.file?.path === abstractFile.path) openLeaf = leaf as WorkspaceLeaf;
								});
								(openLeaf as WorkspaceLeaf | null)?.setPinned(!isTabPinned);
								await this.saveSettings();
							});
					});
				}
			})
		);

		// 파일 삭제/이름 변경 시 pinnedPatterns + tabPinnedPaths 동기화
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				let changed = false;
				if (this.hasExactPinPattern(file.path)) {
					this.log('[pin] vault delete → remove from pinnedPatterns:', file.path);
					this.settings.pinnedPatterns = this.removePatternLine(this.settings.pinnedPatterns, file.path);
					this.rebuildPinFilter();
					this.requestSort();
					changed = true;
				}
				if (this.hasExactTabPin(file.path)) {
					this.log('[tab-pin] vault delete → remove from tabPinnedPaths:', file.path);
					this.settings.tabPinnedPaths = this.removePatternLine(this.settings.tabPinnedPaths, file.path);
					this.rebuildTabPinFilter();
					changed = true;
				}
				if (changed) this.saveSettings();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				let changed = false;
				if (this.hasExactPinPattern(oldPath)) {
					this.log('[pin] vault rename → update pinnedPatterns:', oldPath, '→', file.path);
					this.settings.pinnedPatterns = this.renamePatternLine(this.settings.pinnedPatterns, oldPath, file.path);
					this.rebuildPinFilter();
					changed = true;
				}
				if (this.hasExactTabPin(oldPath)) {
					this.log('[tab-pin] vault rename → update tabPinnedPaths:', oldPath, '→', file.path);
					this.settings.tabPinnedPaths = this.renamePatternLine(this.settings.tabPinnedPaths, oldPath, file.path);
					this.rebuildTabPinFilter();
					changed = true;
				}
				if (changed) this.saveSettings();
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
			this.rebuildTabPinFilter();
			this.patchFileExplorerSort();
			this.applyPinIcons();
			this.applyFolderActionButtons();
			this.applyTabPinButtons();
			this.setupPinObserver();
			this.registerGlobalHotkeys();
			this.reopenTabPinnedFiles();
			this.registerEvent(
				this.app.workspace.on('layout-change', () => {
					if (this.settings.tabPinEnabled) {
						this.applyTabPinButtons();
						if (!this.reopeningTabPinnedFiles) this.reopenTabPinnedFiles();
					}
				})
			);
		});

		this.addSettingTab(new OhUtilsSettingTab(this.app, this));
	}

	async onunload() {
		this.sortPatcher?.();
		this.pinObserver?.disconnect();
		this.clearPinDecorations();
		this.clearFolderActionButtons();
		this.clearTabPinButtons();
		this.unregisterGlobalHotkeys();
	}

	// ── 탭 핀 ────────────────────────────────────────────────

	rebuildTabPinFilter() {
		this.tabPinFilter = this.buildIgnoreFilter(this.settings.tabPinnedPaths);
		this.log('[tab-pin] filter', this.tabPinFilter ? 'rebuilt' : 'cleared');
	}

	private hasExactTabPin(path: string): boolean {
		return this.hasExactMatch(this.settings.tabPinnedPaths, path);
	}

	private isTabPinned(path: string): boolean {
		if (!this.tabPinFilter) return false;
		try { return this.tabPinFilter.ignores(path); } catch { return false; }
	}

	applyTabPinButtons() {
		if (!this.settings.tabPinEnabled) return;
		this.app.workspace.iterateAllLeaves(leaf => {
			const tabHeaderEl = (leaf as any).tabHeaderEl as HTMLElement | undefined;
			if (!tabHeaderEl) return;
			if (tabHeaderEl.querySelector('.oh-aio-tab-pin-btn')) return;

			const filePath = (leaf.view as any)?.file?.path as string | undefined;
			if (!filePath) return;

			const closeBtn = tabHeaderEl.querySelector('.workspace-tab-header-inner-close-button');
			if (!closeBtn) return;

			const pinBtn = createEl('div', { cls: 'oh-aio-tab-pin-btn clickable-icon' });
			pinBtn.toggleClass('is-active', this.isTabPinned(filePath));
			setIcon(pinBtn, 'pin');

			pinBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				const currentlyPinned = this.hasExactTabPin(filePath);
				this.settings.tabPinnedPaths = currentlyPinned
					? this.removePatternLine(this.settings.tabPinnedPaths, filePath)
					: this.addPatternLine(this.settings.tabPinnedPaths, filePath);
				this.rebuildTabPinFilter();
				leaf.setPinned(!currentlyPinned);
				pinBtn.toggleClass('is-active', !currentlyPinned);
				await this.saveSettings();
			});

			closeBtn.parentElement?.insertBefore(pinBtn, closeBtn);
		});
	}

	clearTabPinButtons() {
		document.querySelectorAll('.oh-aio-tab-pin-btn').forEach(el => el.remove());
	}

	private reopenTabPinnedFiles() {
		if (!this.settings.tabPinEnabled || !this.tabPinFilter) return;

		const openFilePaths = new Set<string>();
		this.app.workspace.iterateAllLeaves(leaf => {
			const file = (leaf.view as any)?.file;
			if (file) openFilePaths.add(file.path);
		});

		const pinnedFiles = this.app.vault.getMarkdownFiles().filter(file => {
			try { return this.tabPinFilter!.ignores(file.path); } catch { return false; }
		});
		const missingFiles = pinnedFiles.filter(file => !openFilePaths.has(file.path));
		if (missingFiles.length === 0) return;

		this.reopeningTabPinnedFiles = true;
		Promise.all(missingFiles.map(async file => {
			this.log('[tab-pin] reopening closed tab:', file.path);
			const leaf = this.app.workspace.getLeaf('tab');
			await leaf.openFile(file);
			leaf.setPinned(true);
		})).finally(() => { this.reopeningTabPinnedFiles = false; });
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

type SettingsTab = 'general' | 'homeNote' | 'fileExplorer' | 'globalHotkeys';

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

	private renderTabsContent(containerEl: HTMLElement): void {
		// ── 탭 바 ────────────────────────────────────────────
		const tabBar = containerEl.createDiv({ cls: 'oh-aio-tab-bar' });
		const tabs: { id: SettingsTab; label: string }[] = [
			{ id: 'general', label: '일반' },
			{ id: 'homeNote', label: '홈 노트' },
			{ id: 'fileExplorer', label: '파일 탐색기' },
			{ id: 'globalHotkeys', label: '글로벌 핫키' },
		];
		for (const tab of tabs) {
			const btn = tabBar.createEl('button', {
				text: tab.label,
				cls: 'oh-aio-tab-btn' + (this.activeTab === tab.id ? ' is-active' : ''),
			});
			btn.addEventListener('click', () => {
				this.activeTab = tab.id;
				this.display();
			});
		}

		if (this.activeTab === 'general') {
			this.renderGeneral(containerEl);
		} else if (this.activeTab === 'homeNote') {
			this.renderHomeNote(containerEl);
		} else if (this.activeTab === 'fileExplorer') {
			this.renderFileExplorer(containerEl);
		} else if (this.activeTab === 'globalHotkeys') {
			this.renderGlobalHotkeys(containerEl);
		}
	}

	private renderSearchResults(containerEl: HTMLElement, query: string): void {
		const tempEl = createDiv();
		this.renderGeneral(tempEl);
		this.renderHomeNote(tempEl);
		this.renderFileExplorer(tempEl);
		this.renderGlobalHotkeys(tempEl);

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

		// ── 노트 ─────────────────────────────────────────────
		new Setting(containerEl).setName('노트').setHeading();
		new Setting(containerEl)
			.setName('빈 새 노트 자동 삭제')
			.setDesc('새로 만든 노트에 아무것도 입력하지 않고 다른 곳으로 이동하면 노트를 자동으로 삭제합니다. 삭제 직후 알림에서 되돌리기 할 수 있습니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.deleteEmptyNewNoteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.deleteEmptyNewNoteEnabled = value;
						await this.plugin.saveSettings();
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

	private renderHomeNote(containerEl: HTMLElement): void {
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

		// ── 탭 핀 ──────────────────────────────────────────────
		new Setting(containerEl).setName('탭 핀').setHeading();
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('탭 핀 고정된 파일은 탭을 닫아도 자동으로 다시 열립니다. 파일을 우클릭하거나 탭 핀 버튼으로 설정할 수 있습니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.tabPinEnabled)
					.onChange(async (value) => {
						this.plugin.settings.tabPinEnabled = value;
						if (value) {
							this.plugin.applyTabPinButtons();
						} else {
							this.plugin.clearTabPinButtons();
						}
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName('탭 핀 패턴')
			.setDesc('.gitignore 형식. 한 줄에 하나씩. 예: Notes/Home.md, Daily/*.md')
			.addTextArea(text => {
				text
					.setPlaceholder('Notes/Home.md\nDaily/*.md')
					.setValue(this.plugin.settings.tabPinnedPaths)
					.onChange(async (value) => {
						this.plugin.settings.tabPinnedPaths = value;
						await this.plugin.saveSettings();
						this.plugin.rebuildTabPinFilter();
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
