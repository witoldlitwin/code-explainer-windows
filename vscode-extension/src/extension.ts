import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Walkthrough } from "./walkthrough";
import { ExplainerServer } from "./server";
import { SidebarProvider } from "./sidebar";
import { WalkthroughStorage } from "./storage";
import { WalkthroughHistory, hashSegment, relativeDate, type SegmentHashes } from "./history";
import { highlightRange, highlightSegmentRange, highlightSubRange, clearHighlights, disposeHighlights, enableSmoothScrolling, restoreSmoothScrolling } from "./highlight";
import { streamTTS, isTTSAvailable, ensureServer, setWorkspaceRoot, splitSentences } from "./tts-bridge";
import type { AgentMessage, FromWebviewMessage, Segment, Highlight } from "./types";

// ── File-watcher fallback (backward compat) ──

/** Editor id used to keep runtime files apart, e.g. "vscode", "vscode-insiders", "cursor". */
const EDITOR_ID = (vscode.env.uriScheme || "vscode").replace(/[^a-z0-9-]/gi, "") || "vscode";
const HIGHLIGHT_FILE = path.join(os.homedir(), `.claude-highlight-${EDITOR_ID}.json`);

interface HighlightRequest {
	file: string;
	start: number;
	end: number;
}

let fileWatcher: fs.StatWatcher | undefined;

function startFileWatcher(): void {
	// Delete any stale highlight file from a previous session
	// instead of processing it — only react to NEW highlight requests
	try {
		fs.unlinkSync(HIGHLIGHT_FILE);
	} catch {}

	fileWatcher = fs.watchFile(
		HIGHLIGHT_FILE,
		{ interval: 300 },
		(curr, prev) => {
			if (curr.mtimeMs !== prev.mtimeMs) {
				processHighlightFile();
			}
		},
	);
}

function processHighlightFile(): void {
	let raw: string;
	try {
		raw = fs.readFileSync(HIGHLIGHT_FILE, "utf-8");
	} catch {
		return;
	}

	let request: HighlightRequest;
	try {
		request = JSON.parse(raw);
	} catch {
		return;
	}

	if (!request.file || typeof request.start !== "number" || typeof request.end !== "number") {
		return;
	}

	highlightRange(request.file, request.start, request.end).catch((err) => {
		console.error("[code-explainer] Fallback highlight failed:", err);
	});
}

// ── Continuous TTS plan ──

interface SegmentTTSPlan {
	fullText: string;
	/** chunkBoundaries[i] = index of first chunk belonging to the i-th spoken highlight */
	chunkBoundaries: number[];
	/** Maps each entry in chunkBoundaries back to the original highlight index (handles gaps from empty ttsText) */
	highlightIndices: number[];
	totalChunks: number;
}

/** Auto-advance to the next step when its narration ends (setting; default off = wait for Next/Prev). */
function autoAdvanceEnabled(): boolean {
	return vscode.workspace.getConfiguration("codeExplainer").get<boolean>("autoAdvance", false);
}

function buildSegmentTTSPlan(highlights: Highlight[], startFrom = 0, maxHighlights = Infinity): SegmentTTSPlan {
	const chunkBoundaries: number[] = [];
	const highlightIndices: number[] = [];
	const textParts: string[] = [];
	let totalChunks = 0;

	for (let i = startFrom; i < highlights.length && highlightIndices.length < maxHighlights; i++) {
		let text = (highlights[i].ttsText || "").trim();
		if (!text) continue;
		if (!/[.!?]$/.test(text)) text += ".";
		chunkBoundaries.push(totalChunks);
		highlightIndices.push(i);
		totalChunks += splitSentences(text).length;
		textParts.push(text);
	}

	return { fullText: textParts.join(" "), chunkBoundaries, highlightIndices, totalChunks };
}

/** Map a chunk of the plan's stream to its highlight and its sentence within that highlight. */
function chunkLocation(plan: SegmentTTSPlan, chunkIndex: number): { highlightIndex: number; sentenceIndex: number } | undefined {
	for (let p = plan.chunkBoundaries.length - 1; p >= 0; p--) {
		if (plan.chunkBoundaries[p] <= chunkIndex) {
			return { highlightIndex: plan.highlightIndices[p], sentenceIndex: chunkIndex - plan.chunkBoundaries[p] };
		}
	}
	return undefined;
}

// ── Main activation ──

function playHighlightChunk(
	segment: Segment,
	highlight: Highlight,
	highlightIndex: number,
	sidebar: SidebarProvider,
	voice: string,
	speed: number,
): { promise: Promise<void>; abort: () => void } {
	let abortFn: (() => void) | undefined;
	let aborted = false;

	const promise = new Promise<void>((resolve) => {
		highlightSubRange(segment.file, highlight.start, highlight.end, segment.highlights).catch(() => {});

		if (highlight.ttsText && isTTSAvailable()) {
			// Wait for the webview to signal actual playback completion,
			// not just the TTS server finishing its stream.
			sidebar.waitForPlaybackComplete().then(resolve);

			abortFn = streamTTS(
				highlight.ttsText,
				{ voice, speed },
				(base64, sampleRate, chunkIndex) => {
					if (!aborted) {
						sidebar.sendAudioChunk(base64, sampleRate, { highlightIndex, sentenceIndex: chunkIndex });
					}
				},
				() => {
					if (!aborted) sidebar.sendAudioEnd();
				},
				(err) => {
					console.error("[code-explainer] TTS error:", err);
					resolve();
				},
			);
		} else {
			const timer = setTimeout(() => resolve(), 2000);
			abortFn = () => clearTimeout(timer);
		}
	});

	return {
		promise,
		abort: () => {
			aborted = true;
			if (abortFn) abortFn();
		},
	};
}

export function activate(context: vscode.ExtensionContext): void {
	// Set workspace root so TTS bridge can find venv Python
	const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (wsFolder) setWorkspaceRoot(wsFolder);

	const walkthrough = new Walkthrough();
	const sidebar = new SidebarProvider(context.extensionUri);
	const server = new ExplainerServer(walkthrough, EDITOR_ID);

	let storage: WalkthroughStorage | undefined;
	if (wsFolder) {
		storage = new WalkthroughStorage(wsFolder);
		server.setStorage(storage);
	}
	// Private auto-saved history (VS Code workspace storage, outside the repo)
	const history = wsFolder && context.storageUri
		? new WalkthroughHistory(context.storageUri.fsPath, wsFolder)
		: undefined;

	// Register sidebar
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	// Initialize walkthrough-active context as false
	vscode.commands.executeCommand('setContext', 'codeExplainer.walkthroughActive', false);

	// Start file-watcher fallback
	startFileWatcher();

	// Start HTTP+WS server
	server.start().then((port) => {
		console.log(`[code-explainer] Server listening on port ${port}`);
	});

	// ── Walkthrough events → sidebar + highlights ──

	// TTS settings — updated by webview messages
	let ttsVoice = "af_heart";
	let ttsSpeed = 1;

	let currentChunkAbort: (() => void) | undefined;
	let highlightLoopGeneration = 0;
	// When navigating prev_highlight across segment boundary, we want to start
	// from the last highlight of the previous segment instead of the default 0.
	let pendingHighlightStart: number | undefined;
	// True when audio was suspended (not stopped) during pause — allows exact-position resume
	let hasSuspendedAudio = false;
	// True when the current step's narration finished and we wait for Next/Prev (autoAdvance off)
	let awaitingNext = false;

	/** Stop audio and reset suspended flag. Use this instead of sidebar.sendAudioStop() directly. */
	function fullAudioStop(): void {
		sidebar.sendAudioStop();
		sidebar.setChunkPlayedCallback(undefined);
		hasSuspendedAudio = false;
		awaitingNext = false;
	}

	/**
	 * Resume from suspended audio — just unpause the AudioContext.
	 * The original playSegmentHighlights loop is still alive (paused at `await playbackDone`)
	 * with its chunkPlayedCallback intact, so highlights will continue advancing
	 * as the buffered audio plays out.
	 */
	function resumeFromSuspended(): void {
		hasSuspendedAudio = false;
		sidebar.sendAudioResume();
	}

	/** Pre-warm the TTS server then resume playback from a specific highlight index. */
	function preWarmAndResume(startHighlight: number): void {
		const seg = walkthrough.getCurrentSegment();
		if (!seg) return;
		highlightLoopGeneration++;
		if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
		fullAudioStop();
		sidebar.sendServerLoading(true);
		const segId = seg.id;
		ensureServer().then(() => {
			sidebar.sendServerLoading(false);
			// Guard: segment may have changed while server was warming up
			if (walkthrough.getCurrentSegment()?.id !== segId) return;
			if (walkthrough.getState().status === "playing") {
				playSegmentHighlights(seg, walkthrough, sidebar, startHighlight).catch((err) => {
					console.error("[code-explainer] Highlight loop error:", err);
				});
			}
		}).catch((err) => {
			sidebar.sendServerLoading(false);
			console.error("[code-explainer] ensureServer failed:", err);
		});
	}

	async function playSegmentHighlights(
		segment: Segment,
		wt: Walkthrough,
		sb: SidebarProvider,
		startFromHighlight = 0,
	): Promise<void> {
		const myGeneration = ++highlightLoopGeneration;
		awaitingNext = false;
		const autoAdvance = autoAdvanceEnabled();

		const highlights = segment.highlights;

		// If not playing, just show the code location without starting TTS
		if (wt.getState().status !== "playing") {
			await highlightSegmentRange(segment.file, segment.start, segment.end).catch(() => {});
			sb.updateState(wt.getState());
			return;
		}

		await highlightSegmentRange(segment.file, segment.start, segment.end).catch(() => {});
		sb.updateState(wt.getState());

		// ── Continuous TTS path: one call per segment ──
		const hasTTS = isTTSAvailable() && highlights.some((h) => h.ttsText);
		if (hasTTS) {
			// Without auto-advance, narrate only the current step.
			const plan = buildSegmentTTSPlan(highlights, startFromHighlight, autoAdvance ? Infinity : 1);
			if (plan.fullText && plan.chunkBoundaries.length > 0) {
				// Show first highlight immediately
				const firstHighlightIdx = plan.highlightIndices[0] ?? startFromHighlight;
				wt.setHighlightIndex(firstHighlightIdx);
				sb.sendHighlightAdvance(firstHighlightIdx, highlights.length, highlights[firstHighlightIdx].explanation);
				await highlightSubRange(segment.file, highlights[firstHighlightIdx].start, highlights[firstHighlightIdx].end, highlights).catch(() => {});

				// Track played chunks (from webview onended) to advance pointer at playback speed
				let playedChunks = 0;
				let pointerOffset = 0;

				sb.setChunkPlayedCallback(() => {
					if (myGeneration !== highlightLoopGeneration) return;
					playedChunks++;

					const nextPointer = pointerOffset + 1;
					if (
						nextPointer < plan.chunkBoundaries.length &&
						playedChunks >= plan.chunkBoundaries[nextPointer]
					) {
						pointerOffset = nextPointer;
						const highlightIdx = plan.highlightIndices[nextPointer];
						if (highlightIdx !== undefined && highlightIdx < highlights.length) {
							wt.setHighlightIndex(highlightIdx);
							sb.sendHighlightAdvance(highlightIdx, highlights.length, highlights[highlightIdx].explanation);
							highlightSubRange(segment.file, highlights[highlightIdx].start, highlights[highlightIdx].end, highlights).catch(() => {});
						}
					}
				});

				const playbackDone = sb.waitForPlaybackComplete();

				const abortTTS = streamTTS(
					plan.fullText,
					{ voice: ttsVoice, speed: ttsSpeed },
					(base64, sampleRate, chunkIndex) => {
						if (myGeneration !== highlightLoopGeneration) return;
						sb.sendAudioChunk(base64, sampleRate, chunkLocation(plan, chunkIndex));
					},
					() => {
						if (myGeneration !== highlightLoopGeneration) return;
						sb.sendAudioEnd();
					},
					(err) => {
						console.error("[code-explainer] TTS error:", err);
					},
				);

				currentChunkAbort = abortTTS;
				await playbackDone;
				currentChunkAbort = undefined;
				sb.setChunkPlayedCallback(undefined);

				if (myGeneration !== highlightLoopGeneration) return;

				if (!autoAdvance) {
					// Step narrated — wait for the user to press Next/Prev.
					awaitingNext = true;
					return;
				}

				// All highlights done — auto-advance to next segment
				if (wt.getState().status === "playing") {
					wt.next();
				}
				return;
			}
		}

		// ── Fallback: per-highlight TTS (no TTS available or no ttsText) ──
		for (let i = startFromHighlight; i < highlights.length; i++) {
			if (myGeneration !== highlightLoopGeneration) return;

			wt.setHighlightIndex(i);
			sb.sendHighlightAdvance(i, highlights.length, highlights[i].explanation);

			const chunk = playHighlightChunk(
				segment,
				highlights[i],
				i,
				sb,
				ttsVoice,
				ttsSpeed,
			);
			currentChunkAbort = chunk.abort;

			await chunk.promise;
			currentChunkAbort = undefined;

			if (myGeneration !== highlightLoopGeneration) return;
			if (!autoAdvance) break; // narrate only the current step
		}

		if (!autoAdvance) {
			if (myGeneration === highlightLoopGeneration) awaitingNext = true;
			return;
		}

		// All highlights done — auto-advance to next segment
		if (myGeneration === highlightLoopGeneration && wt.getState().status === "playing") {
			wt.next();
		}
	}

	/** Show (and, while playing, narrate) highlight `idx` of the current segment. */
	function goToHighlight(seg: Segment, idx: number): void {
		highlightLoopGeneration++;
		if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
		fullAudioStop();
		walkthrough.setHighlightIndex(idx);
		if (walkthrough.getState().status === "playing") {
			playSegmentHighlights(seg, walkthrough, sidebar, idx).catch((err) => {
				console.error("[code-explainer] Highlight loop error:", err);
			});
		} else {
			sidebar.sendHighlightAdvance(idx, seg.highlights.length, seg.highlights[idx].explanation);
			highlightSubRange(seg.file, seg.highlights[idx].start, seg.highlights[idx].end, seg.highlights).catch(() => {});
		}
	}

	/** Next step: next highlight, or the first highlight of the next segment. */
	function stepNext(): void {
		const seg = walkthrough.getCurrentSegment();
		if (!seg) return;
		const count = seg.highlights?.length ?? 0;
		const curIdx = walkthrough.getHighlightIndex();
		if (count > 0 && curIdx < count - 1) {
			goToHighlight(seg, curIdx + 1);
			return;
		}
		const state = walkthrough.getState();
		if (state.currentIndex + 1 >= state.segments.length) return; // At walkthrough end
		if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
		fullAudioStop();
		walkthrough.next(); // emits "segment" → starts from highlight 0
	}

	/** Previous step: previous highlight, or the last highlight of the previous segment. */
	function stepPrev(): void {
		const seg = walkthrough.getCurrentSegment();
		if (!seg) return;
		const count = seg.highlights?.length ?? 0;
		const curIdx = walkthrough.getHighlightIndex();
		if (count > 0 && curIdx > 0) {
			goToHighlight(seg, curIdx - 1);
			return;
		}
		const state = walkthrough.getState();
		const prevSegIdx = state.currentIndex - 1;
		if (prevSegIdx < 0) return; // Already at the very first segment
		const prevHighlightCount = state.segments[prevSegIdx]?.highlights?.length ?? 0;
		if (prevHighlightCount > 0) pendingHighlightStart = prevHighlightCount - 1;
		if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
		fullAudioStop();
		walkthrough.prev(); // emits "segment" → pendingHighlightStart used
	}

	walkthrough.on("segment", (segment: Segment) => {
		// Enable smooth scrolling for the walkthrough
		enableSmoothScrolling().catch(() => {});

		// Increment generation to invalidate any in-flight highlight loop
		highlightLoopGeneration++;
		if (currentChunkAbort) {
			currentChunkAbort();
			currentChunkAbort = undefined;
		}
		fullAudioStop();

		const startIdx = pendingHighlightStart ?? 0;
		pendingHighlightStart = undefined;
		playSegmentHighlights(segment, walkthrough, sidebar, startIdx).catch((err) => {
			console.error("[code-explainer] Highlight loop error:", err);
		});
	});

	// ── History auto-save ──

	/** Where the next brand-new plan comes from; consumed by the "newPlan" handler. */
	let nextPlanSource: "agent" | "history" | undefined;
	let currentHistoryId: string | undefined;
	/** Recorded hash per segment id, plus the range it was taken from (to detect replaced segments). */
	const segmentHashes = new Map<number, { range: string; hash: string | null }>();
	let staleSegments = new Set<number>();
	let historySaveTimer: ReturnType<typeof setTimeout> | undefined;

	const rangeKey = (s: Segment) => `${s.file}:${s.start}-${s.end}`;

	function setStale(ids: Set<number>): void {
		staleSegments = ids;
		sidebar.setStaleSegments([...ids]);
	}

	/** Hash segments that are new or whose range changed; returns the hashes of the current plan. */
	async function refreshHashes(segments: Segment[]): Promise<SegmentHashes> {
		const result: SegmentHashes = {};
		for (const seg of segments) {
			const known = segmentHashes.get(seg.id);
			if (!known || known.range !== rangeKey(seg)) {
				const hash = await hashSegment(seg);
				segmentHashes.set(seg.id, { range: rangeKey(seg), hash });
				if (staleSegments.has(seg.id)) {
					const next = new Set(staleSegments);
					next.delete(seg.id);
					setStale(next);
				}
			}
			result[seg.id] = segmentHashes.get(seg.id)!.hash;
		}
		return result;
	}

	function scheduleHistorySave(): void {
		if (!history || !currentHistoryId) return;
		if (historySaveTimer) clearTimeout(historySaveTimer);
		historySaveTimer = setTimeout(async () => {
			historySaveTimer = undefined;
			const id = currentHistoryId;
			if (!id) return;
			const state = walkthrough.getState();
			if (state.segments.length === 0) return;
			try {
				const hashes = await refreshHashes(state.segments);
				await history.update(id, state.title, state.segments, hashes);
			} catch (err) {
				console.error("[code-explainer] History update failed:", err);
			}
		}, 300);
	}

	walkthrough.on("newPlan", () => {
		const source = nextPlanSource;
		nextPlanSource = undefined;
		if (source === "history") return; // openFromHistory already set id, hashes and stale set
		currentHistoryId = undefined;
		segmentHashes.clear();
		setStale(new Set());
		if (source !== "agent" || !history) return; // e.g. loaded from .walkthroughs/
		const state = walkthrough.getState();
		refreshHashes(state.segments)
			.then((hashes) => history.create(state.title, state.segments, hashes))
			.then((id) => {
				currentHistoryId = id;
				scheduleHistorySave(); // catch agent edits that arrived while creating
			})
			.catch((err) => console.error("[code-explainer] History save failed:", err));
	});

	async function openFromHistory(id: string): Promise<void> {
		if (!history) return;
		const data = await history.load(id);
		if (!data) {
			vscode.window.showErrorMessage("That walkthrough could not be loaded (the history file is missing or damaged).");
			await sendHistoryList();
			return;
		}
		if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
		fullAudioStop();
		segmentHashes.clear();
		const stale = new Set<number>();
		for (const seg of data.segments) {
			const recorded = data.hashes[seg.id];
			segmentHashes.set(seg.id, { range: rangeKey(seg), hash: recorded ?? null });
			const current = await hashSegment(seg);
			if (recorded === undefined || recorded === null || current !== recorded) stale.add(seg.id);
		}
		currentHistoryId = id;
		setStale(stale);
		nextPlanSource = "history";
		walkthrough.setPlan(data.title, data.segments);
		sidebar.reveal();
		await history.touch(id);
	}

	async function sendHistoryList(): Promise<void> {
		sidebar.postMessage({ type: "history_list", entries: history ? await history.list() : [] });
	}

	/** Ask for confirmation, then delete a history entry. Returns true if deleted. */
	async function deleteFromHistory(id: string): Promise<boolean> {
		if (!history) return false;
		const title = (await history.getTitle(id)) ?? "this walkthrough";
		const choice = await vscode.window.showWarningMessage(
			`Delete "${title}" from history?`,
			{ modal: true },
			"Delete",
		);
		if (choice !== "Delete") return false;
		await history.delete(id);
		if (currentHistoryId === id) currentHistoryId = undefined;
		await sendHistoryList();
		return true;
	}

	/** Quick pick listing history entries (deletable) and shared .walkthroughs/ entries. */
	async function showWalkthroughPicker(): Promise<void> {
		type Item = vscode.QuickPickItem & { historyId?: string; sharedName?: string };
		const trash: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete from history" };

		const buildItems = async (): Promise<Item[]> => {
			const items: Item[] = [];
			const entries = history ? await history.list() : [];
			if (entries.length > 0) {
				items.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator });
				for (const e of entries) {
					items.push({
						label: e.title,
						description: `${relativeDate(e.updatedAt)} · ${e.segmentCount} segment${e.segmentCount === 1 ? "" : "s"}`,
						historyId: e.id,
						buttons: [trash],
					});
				}
			}
			const shared = storage ? await storage.list() : [];
			if (shared.length > 0) {
				items.push({ label: "Shared in repo (.walkthroughs/)", kind: vscode.QuickPickItemKind.Separator });
				for (const s of shared) items.push({ label: s.title, description: s.name, sharedName: s.name });
			}
			return items;
		};

		const items = await buildItems();
		if (items.length === 0) {
			vscode.window.showInformationMessage("No previous walkthroughs yet. Run /explainer in your coding agent to create one.");
			return;
		}
		const qp = vscode.window.createQuickPick<Item>();
		qp.placeholder = "Open a previous walkthrough";
		qp.matchOnDescription = true;
		qp.items = items;
		qp.onDidTriggerItemButton(async (e) => {
			if (!e.item.historyId) return;
			qp.ignoreFocusOut = true; // keep the picker open while the modal confirm shows
			const deleted = await deleteFromHistory(e.item.historyId);
			qp.ignoreFocusOut = false;
			if (deleted) {
				qp.items = await buildItems();
				if (qp.items.length === 0) qp.hide();
			}
			qp.show();
		});
		qp.onDidAccept(async () => {
			const pick = qp.selectedItems[0];
			qp.hide();
			if (!pick) return;
			if (pick.historyId) {
				await openFromHistory(pick.historyId);
			} else if (pick.sharedName && storage) {
				const data = await storage.load(pick.sharedName);
				if (!data) {
					vscode.window.showErrorMessage("Failed to load walkthrough");
					return;
				}
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.setPlan(data.title, data.segments);
				sidebar.reveal();
			}
		});
		qp.onDidHide(() => qp.dispose());
		qp.show();
	}

	walkthrough.on("plan", () => {
		scheduleHistorySave();
		sidebar.updateState(walkthrough.getState());
		server.broadcastState();
		vscode.commands.executeCommand('setContext', 'codeExplainer.walkthroughActive', true);
	});

	walkthrough.on("status", () => {
		sidebar.updateState(walkthrough.getState());
		server.broadcastState();

		const state = walkthrough.getState();
		if (state.status === "paused" || state.status === "stopped") {
			if (currentChunkAbort) {
				currentChunkAbort();
				currentChunkAbort = undefined;
			}
			if (state.status === "paused") {
				if (!awaitingNext) {
					// Suspend audio but keep the highlight loop alive — don't
					// increment highlightLoopGeneration so the chunkPlayedCallback
					// remains valid and can advance highlights when audio resumes.
					// (If the step already finished, Play replays it instead.)
					sidebar.sendAudioSuspend();
					hasSuspendedAudio = true;
				}
			} else {
				highlightLoopGeneration++;
			}
		}

		if (state.status === "stopped") {
			hasSuspendedAudio = false;
			clearHighlights();
			restoreSmoothScrolling().catch(() => {});
			vscode.commands.executeCommand('setContext', 'codeExplainer.walkthroughActive', false);
		}
	});

	// ── Keybinding command registrations ──

	const speedPresets = [0.75, 1, 1.25, 1.5, 2];

	context.subscriptions.push(
		vscode.commands.registerCommand('codeExplainer.togglePlayPause', () => {
			walkthrough.togglePlayPause();
			if (walkthrough.getState().status === "playing") {
				if (hasSuspendedAudio) {
					resumeFromSuspended();
				} else {
					preWarmAndResume(walkthrough.getHighlightIndex());
				}
			}
		}),
		vscode.commands.registerCommand('codeExplainer.next', () => stepNext()),
		vscode.commands.registerCommand('codeExplainer.prev', () => stepPrev()),
		vscode.commands.registerCommand('codeExplainer.nextSegment', () => {
			if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
			fullAudioStop();
			walkthrough.next();
		}),
		vscode.commands.registerCommand('codeExplainer.prevSegment', () => {
			if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
			fullAudioStop();
			walkthrough.prev();
		}),
		vscode.commands.registerCommand('codeExplainer.stop', () => {
			fullAudioStop();
			walkthrough.stop();
		}),
		vscode.commands.registerCommand('codeExplainer.speedUp', () => {
			const currentIdx = speedPresets.indexOf(ttsSpeed);
			const idx = currentIdx === -1 ? 1 : currentIdx;
			const nextIdx = Math.min(idx + 1, speedPresets.length - 1);
			ttsSpeed = speedPresets[nextIdx];
			vscode.window.setStatusBarMessage(`Speed: ${ttsSpeed}x`, 2000);
		}),
		vscode.commands.registerCommand('codeExplainer.speedDown', () => {
			const currentIdx = speedPresets.indexOf(ttsSpeed);
			const idx = currentIdx === -1 ? 1 : currentIdx;
			const nextIdx = Math.max(idx - 1, 0);
			ttsSpeed = speedPresets[nextIdx];
			vscode.window.setStatusBarMessage(`Speed: ${ttsSpeed}x`, 2000);
		}),
		vscode.commands.registerCommand('codeExplainer.saveWalkthrough', async () => {
			if (!storage) {
				vscode.window.showErrorMessage("No workspace folder open");
				return;
			}
			const state = walkthrough.getState();
			if (state.segments.length === 0) {
				vscode.window.showWarningMessage("No active walkthrough to save");
				return;
			}
			const defaultName = WalkthroughStorage.slugify(state.title);
			const name = await vscode.window.showInputBox({
				prompt: "Walkthrough name",
				value: defaultName,
				validateInput: (v) => v.trim() ? null : "Name cannot be empty",
			});
			if (!name) return;
			if (await storage.exists(name)) {
				const overwrite = await vscode.window.showWarningMessage(
					`"${name}" already exists. Overwrite?`,
					"Overwrite", "Cancel"
				);
				if (overwrite !== "Overwrite") return;
			}
			await storage.save(state.title, state.segments, name);
			vscode.window.showInformationMessage(`Walkthrough saved to .walkthroughs/${name}.json`);
		}),
		vscode.commands.registerCommand('codeExplainer.loadWalkthrough', async () => {
			if (!storage && !history) {
				vscode.window.showErrorMessage("No workspace folder open");
				return;
			}
			await showWalkthroughPicker();
		}),
	);

	// ── Agent messages → walkthrough state ──

	server.setMessageHandler((msg: AgentMessage) => {
		switch (msg.type) {
			case "set_plan":
				nextPlanSource = "agent";
				walkthrough.setPlan(msg.title, msg.segments);
				sidebar.reveal();
				break;
			case "insert_after":
				walkthrough.insertAfter(msg.afterSegment, msg.segments);
				break;
			case "replace_segment":
				walkthrough.replaceSegment(msg.id, msg.segment);
				break;
			case "remove_segments":
				walkthrough.removeSegments(msg.ids);
				break;
			case "goto":
				walkthrough.navigateTo(msg.segmentId);
				break;
			case "resume": {
				const resumeHighlightIdx = walkthrough.getHighlightIndex();
				walkthrough.play();
				if (hasSuspendedAudio) {
					resumeFromSuspended();
				} else {
					preWarmAndResume(resumeHighlightIdx);
				}
				break;
			}
			case "stop":
				fullAudioStop();
				walkthrough.stop();
				break;
		}
	});

	// ── Webview messages → walkthrough state + server ──

	sidebar.setMessageHandler(async (msg: FromWebviewMessage) => {
		switch (msg.type) {
			case "play_pause":
				walkthrough.togglePlayPause();
				// If resuming, try to resume suspended audio first for exact-position resume
				if (walkthrough.getState().status === "playing") {
					if (hasSuspendedAudio) {
						resumeFromSuspended();
					} else {
						preWarmAndResume(walkthrough.getHighlightIndex());
					}
				}
				break;
			case "next_highlight":
				stepNext();
				break;
			case "prev_highlight":
				stepPrev();
				break;
			case "next":
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.next();
				break;
			case "prev":
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.prev();
				break;
			case "goto_segment":
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.goto(msg.segmentId);
				break;
			case "speed_change":
				ttsSpeed = msg.speed;
				break;
			case "volume_change":
				// Volume is handled in webview's Web Audio GainNode
				break;
			case "voice_change":
				ttsVoice = msg.voice;
				break;
			case "mute_toggle":
				// Mute is handled in webview's Web Audio GainNode
				break;
			case "restart": {
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				const segments = walkthrough.getState().segments;
				if (segments.length > 0) {
					walkthrough.goto(segments[0].id);
				}
				break;
			}
			case "save":
				vscode.commands.executeCommand('codeExplainer.saveWalkthrough');
				break;
			case "load":
				if (storage) {
					const data = await storage.load(msg.name);
					if (data) {
						walkthrough.setPlan(data.title, data.segments);
						sidebar.reveal();
					}
				}
				break;
			case "request_saved_list":
				await sendHistoryList();
				if (storage) {
					const list = await storage.list();
					sidebar.postMessage({
						type: "saved_list",
						walkthroughs: list.map(({ name, title }) => ({ name, title })),
					});
				}
				break;
			case "open_history":
				await openFromHistory(msg.id);
				break;
			case "delete_history":
				await deleteFromHistory(msg.id);
				break;
			case "show_history":
				await showWalkthroughPicker();
				break;
			case "close_walkthrough":
				// Walkthroughs are auto-saved to history, so closing needs no confirmation.
				if (currentChunkAbort) { currentChunkAbort(); currentChunkAbort = undefined; }
				fullAudioStop();
				walkthrough.stop();
				break;
		}
	});

	// ── Cleanup ──

	context.subscriptions.push({
		dispose: () => {
			server.stop();
			if (fileWatcher) {
				fs.unwatchFile(HIGHLIGHT_FILE);
				fileWatcher = undefined;
			}
			restoreSmoothScrolling().catch(() => {});
			disposeHighlights();
		},
	});
}

export function deactivate(): void {}
