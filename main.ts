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
	autoRevealEnabled: boolean;
	homeNoteEnabled: boolean;
	homeNotePath: string;
	collapseChildrenEnabled: boolean;
	pinEnabled: boolean;
	pinnedPatterns: string;
	hideEnabled: boolean;
	hidePatterns: string;
	globalHotkeysEnabled: boolean;
	globalHotkeys: GlobalHotkey[];
}

const DEFAULT_SETTINGS: OhUtilsSettings = {
	autoRevealEnabled: true,
	homeNoteEnabled: false,
	homeNotePath: '',
	collapseChildrenEnabled: true,
	pinEnabled: true,
	pinnedPatterns: '',
	hideEnabled: false,
	hidePatterns: '',
	globalHotkeysEnabled: false,
	globalHotkeys: [],
};

export default class OhUtilsPlugin extends Plugin {
	settings: OhUtilsSettings;
	private openingHomeNote = false;
	private sortPatcher: (() => void) | null = null;
	private pinObserver: MutationObserver | null = null;
	private debouncedApplyPinIcons = debounce(() => this.applyPinIcons(), 50, true);
	private pinFilter: Ignore | null = null;
	private hideFilter: Ignore | null = null;

	async onload() {
		await this.loadSettings();

		// 노트 열 때 파일 탐색기 자동 reveal
		this.registerEvent(
			this.app.workspace.on('file-open', (file: TFile | null) => {
				if (!this.settings.autoRevealEnabled || !file) return;
				this.revealActiveFile();
			})
		);

		// 마지막 탭 닫을 때 홈 노트로 이동
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (!this.settings.homeNoteEnabled || !this.settings.homeNotePath) return;
				if (this.openingHomeNote) return;

				const openLeaves = this.app.workspace.getLeavesOfType('markdown');
				if (openLeaves.length > 0) return;

				this.openingHomeNote = true;
				this.app.workspace
					.openLinkText(normalizePath(this.settings.homeNotePath), '')
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
							.onClick(() => this.collapseFolderByPath(abstractFile.path));
					});
				}

				if (!this.settings.pinEnabled) return;
				const isPinned = this.hasExactPinPattern(abstractFile.path);
				menu.addItem(item => {
					item
						.setTitle(isPinned ? '핀 해제' : '핀 고정')
						.setIcon(isPinned ? 'pin-off' : 'pin')
						.onClick(async () => {
							if (isPinned) {
								this.settings.pinnedPatterns = this.settings.pinnedPatterns
									.split('\n')
									.filter(line => line.trim() !== abstractFile.path)
									.join('\n');
								this.removePinIcon(abstractFile.path);
							} else {
								const current = this.settings.pinnedPatterns.trimEnd();
								this.settings.pinnedPatterns = current
									? current + '\n' + abstractFile.path
									: abstractFile.path;
							}
							await this.saveSettings();
							this.rebuildPinFilter();
							this.requestSort();
						});
				});
			})
		);

		// 파일 삭제/이름 변경 시 pinnedPatterns 동기화 (정확한 경로 줄만 갱신)
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (!this.hasExactPinPattern(file.path)) return;
				this.settings.pinnedPatterns = this.settings.pinnedPatterns
					.split('\n')
					.filter(line => line.trim() !== file.path)
					.join('\n');
				this.saveSettings();
				this.rebuildPinFilter();
				this.requestSort();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (!this.hasExactPinPattern(oldPath)) return;
				this.settings.pinnedPatterns = this.settings.pinnedPatterns
					.split('\n')
					.map(line => line.trim() === oldPath ? file.path : line)
					.join('\n');
				this.saveSettings();
				this.rebuildPinFilter();
			})
		);

		this.app.workspace.onLayoutReady(() => {
			this.rebuildPinFilter();
			this.rebuildHideFilter();
			this.patchFileExplorerSort();
			this.applyPinIcons();
			this.setupPinObserver();
			this.registerGlobalHotkeys();
		});

		this.addSettingTab(new OhUtilsSettingTab(this.app, this));
	}

	async onunload() {
		this.sortPatcher?.();
		this.pinObserver?.disconnect();
		this.clearPinDecorations();
		this.unregisterGlobalHotkeys();
	}

	// ── 핀 정렬 패치 ─────────────────────────────────────────

	private patchFileExplorerSort() {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer) return;

		const proto = Object.getPrototypeOf(fileExplorer);
		if (!proto.getSortedFolderItems) return;

		const plugin = this;
		this.sortPatcher = around(proto, {
			getSortedFolderItems(old: (...args: any[]) => any[]) {
				return function (this: any, ...args: any[]): any[] {
					let items: any[] = old.call(this, ...args);

					// 숨기기 필터 적용
					if (plugin.settings.hideEnabled && plugin.hideFilter) {
						items = items.filter(item => {
							const file = item.file;
							if (!file) return true;
							// 폴더는 경로 끝에 / 붙여서 디렉토리 패턴 매칭
							const testPath = file instanceof TFolder
								? file.path + '/'
								: file.path;
							try {
								return !plugin.hideFilter!.ignores(testPath);
							} catch {
								return true;
							}
						});
					}

					// 핀 정렬 적용
					if (plugin.settings.pinEnabled && plugin.pinFilter) {
						const isPinned = (item: any) => {
							const file = item.file;
							if (!file) return false;
							const testPath = file instanceof TFolder ? file.path + '/' : file.path;
							try { return plugin.pinFilter!.ignores(testPath); }
							catch { return false; }
						};
						items = [...items.filter(isPinned), ...items.filter(i => !isPinned(i))];
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
		const patterns = this.settings.pinnedPatterns.trim();
		if (!patterns) {
			this.pinFilter = null;
			return;
		}
		this.pinFilter = ignore().add(patterns);
	}

	rebuildHideFilter() {
		const patterns = this.settings.hidePatterns.trim();
		if (!patterns) {
			this.hideFilter = null;
			return;
		}
		this.hideFilter = ignore().add(patterns);
	}

	private hasExactPinPattern(filePath: string): boolean {
		return this.settings.pinnedPatterns
			.split('\n')
			.some(line => line.trim() === filePath);
	}

	// ── 핀 아이콘 표시 ────────────────────────────────────────

	private setupPinObserver() {
		const explorerEl = this.getFileExplorer()?.containerEl as HTMLElement | null;
		if (!explorerEl) return;

		this.pinObserver?.disconnect();
		this.pinObserver = new MutationObserver(() => this.debouncedApplyPinIcons());
		this.pinObserver.observe(explorerEl, { childList: true, subtree: true });
	}

	private applyPinIcons() {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer?.fileItems) return;

		const fileItems = fileExplorer.fileItems as Record<string, any>;

		for (const [path, item] of Object.entries(fileItems)) {
			if (!item?.el || !item.file) continue;

			const testPath = item.file instanceof TFolder ? path + '/' : path;
			let pinned = false;
			try { pinned = this.pinFilter?.ignores(testPath) ?? false; }
			catch { pinned = false; }

			if (!pinned) continue;

			(item.el as HTMLElement).classList.add('oh-utils-pinned');

			// item.el의 firstChild = 타이틀 엘리먼트
			const titleEl = (item.el as HTMLElement).firstChild as HTMLElement | null;
			if (!titleEl || titleEl.querySelector('.oh-utils-pin-icon')) continue;

			const pinIconEl = createEl('span', { cls: 'oh-utils-pin-icon' });
			setIcon(pinIconEl, 'pin');
			// collapse indicator보다 앞에 삽입
			titleEl.insertBefore(pinIconEl, titleEl.firstChild);
		}
	}

	private removePinIcon(path: string) {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer?.fileItems) return;

		const item = (fileExplorer.fileItems as Record<string, any>)[path];
		if (!item?.el) return;

		(item.el as HTMLElement).classList.remove('oh-utils-pinned');
		(item.el as HTMLElement).querySelector('.oh-utils-pin-icon')?.remove();
	}

	private clearPinDecorations() {
		document.querySelectorAll('.oh-utils-pin-icon').forEach(el => el.remove());
		document.querySelectorAll('.oh-utils-pinned').forEach(el => el.classList.remove('oh-utils-pinned'));
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
					if (!win.isVisible()) win.show();
					win.focus();
					const cmd = (this.app as any).commands.commands[hotkey.commandId];
					if (!cmd) return;
					if (cmd.checkCallback) cmd.checkCallback(false);
					else if (cmd.callback) cmd.callback();
				});
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

	revealActiveFile() {
		(this.app as any).commands.executeCommandById('file-explorer:reveal-active-file');
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

class OhUtilsSettingTab extends PluginSettingTab {
	plugin: OhUtilsPlugin;

	constructor(app: App, plugin: OhUtilsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── 자동 펼치기 ──────────────────────────────────────
		new Setting(containerEl).setName('자동 펼치기').setHeading();
		new Setting(containerEl)
			.setName('활성화')
			.setDesc('노트를 열 때마다 파일 탐색기에서 해당 노트의 위치를 자동으로 펼치고 하이라이트합니다.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.autoRevealEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoRevealEnabled = value;
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
						if (!value) this.plugin['clearPinDecorations']();
						else this.plugin['applyPinIcons']();
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
						this.plugin['clearPinDecorations']();
						this.plugin['applyPinIcons']();
						this.plugin.requestSort();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'var(--font-monospace)';
			});

		// ── 글로벌 핫키 ──────────────────────────────────────
		new Setting(containerEl).setName('글로벌 핫키').setHeading();

		if (!Platform.isDesktop) {
			containerEl.createEl('p', {
				text: '글로벌 핫키는 데스크탑에서만 사용 가능합니다.',
				cls: 'oh-utils-notice-text',
			});
		} else {
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

			// 등록된 핫키 목록
			const { globalHotkeys } = this.plugin.settings;
			if (globalHotkeys.length > 0) {
				const listEl = containerEl.createDiv({ cls: 'oh-utils-hotkey-list' });
				for (const hotkey of globalHotkeys) {
					const rowEl = listEl.createDiv({ cls: 'oh-utils-hotkey-row' });
					rowEl.createEl('kbd', {
						text: displayAccelerator(hotkey.accelerator),
						cls: 'oh-utils-key-badge',
					});
					rowEl.createSpan({ text: hotkey.commandName, cls: 'oh-utils-hotkey-command' });
					const delBtn = rowEl.createEl('button', { text: '삭제', cls: 'oh-utils-hotkey-delete' });
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
		contentEl.addClass('oh-utils-hotkey-modal');
		contentEl.createEl('h2', { text: '글로벌 핫키 추가' });

		// ── 단축키 녹화 ────────────────────────────────
		contentEl.createEl('p', { text: '단축키', cls: 'oh-utils-modal-label' });

		const recorderEl = contentEl.createEl('button', {
			cls: 'oh-utils-key-recorder',
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
		contentEl.createEl('p', { text: '명령어', cls: 'oh-utils-modal-label' });

		const commandInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: '명령어 검색…',
			cls: 'oh-utils-command-input',
		}) as HTMLInputElement;

		new CommandSuggest(this.app, commandInput, (cmd) => {
			this.commandId = cmd.id;
			this.commandName = cmd.name;
		});

		// ── 저장 / 취소 ────────────────────────────────
		const btnRow = contentEl.createDiv({ cls: 'oh-utils-modal-buttons' });

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
