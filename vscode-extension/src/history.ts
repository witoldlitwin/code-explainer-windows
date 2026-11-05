import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Segment } from "./types";
import { WalkthroughStorage, toAbsolutePaths, toRelativePaths } from "./storage";

/** Hash of a segment's code at the time it was recorded; null if the file could not be read. */
export type SegmentHashes = Record<number, string | null>;

interface HistoryFile {
	version: 1;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	segments: Segment[]; // file paths relative to the workspace root
	hashes: SegmentHashes;
}

export interface HistoryEntry {
	id: string;
	title: string;
	updatedAt: string;
	segmentCount: number;
}

const ID_RE = /^[a-z0-9-]+$/;

/**
 * Private, auto-saved history of walkthroughs for one workspace.
 * Lives in VS Code's workspace storage (outside the repo).
 */
export class WalkthroughHistory {
	private readonly dir: string;

	constructor(storageDir: string, private readonly workspaceRoot: string) {
		this.dir = path.join(storageDir, "history");
	}

	private fileFor(id: string): string {
		if (!ID_RE.test(id)) throw new Error(`Invalid history id: ${id}`);
		return path.join(this.dir, `${id}.json`);
	}

	private async read(id: string): Promise<HistoryFile | null> {
		try {
			const data = JSON.parse(await fs.promises.readFile(this.fileFor(id), "utf-8"));
			if (typeof data.title !== "string" || !Array.isArray(data.segments)) return null;
			return data as HistoryFile;
		} catch {
			return null;
		}
	}

	private async write(data: HistoryFile): Promise<void> {
		await fs.promises.mkdir(this.dir, { recursive: true });
		await fs.promises.writeFile(this.fileFor(data.id), JSON.stringify(data, null, 2), "utf-8");
	}

	/** Create a new history entry and return its id. */
	async create(title: string, segments: Segment[], hashes: SegmentHashes): Promise<string> {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
			+ `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		const base = `${stamp}-${WalkthroughStorage.slugify(title).slice(0, 60)}`;
		let id = base;
		for (let n = 2; fs.existsSync(this.fileFor(id)); n++) id = `${base}-${n}`;

		const iso = now.toISOString();
		await this.write({
			version: 1,
			id,
			title,
			createdAt: iso,
			updatedAt: iso,
			segments: toRelativePaths(this.workspaceRoot, segments),
			hashes,
		});
		return id;
	}

	/** Overwrite the content of an existing entry (e.g. after the agent edited the plan). */
	async update(id: string, title: string, segments: Segment[], hashes: SegmentHashes): Promise<void> {
		const existing = await this.read(id);
		if (!existing) return; // deleted meanwhile
		await this.write({
			...existing,
			title,
			updatedAt: new Date().toISOString(),
			segments: toRelativePaths(this.workspaceRoot, segments),
			hashes,
		});
	}

	/** Mark an entry as recently used so it moves to the top of the list. */
	async touch(id: string): Promise<void> {
		const existing = await this.read(id);
		if (!existing) return;
		await this.write({ ...existing, updatedAt: new Date().toISOString() });
	}

	async load(id: string): Promise<{ title: string; segments: Segment[]; hashes: SegmentHashes } | null> {
		const data = await this.read(id);
		if (!data) return null;
		return {
			title: data.title,
			segments: toAbsolutePaths(this.workspaceRoot, data.segments),
			hashes: data.hashes ?? {},
		};
	}

	/** All entries, most recently used first. */
	async list(): Promise<HistoryEntry[]> {
		let files: string[];
		try {
			files = (await fs.promises.readdir(this.dir)).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
		const entries: HistoryEntry[] = [];
		for (const file of files) {
			const data = await this.read(path.basename(file, ".json"));
			if (!data) continue;
			entries.push({
				id: data.id,
				title: data.title,
				updatedAt: data.updatedAt,
				segmentCount: data.segments.length,
			});
		}
		return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async getTitle(id: string): Promise<string | undefined> {
		return (await this.read(id))?.title;
	}

	async delete(id: string): Promise<void> {
		try {
			await fs.promises.unlink(this.fileFor(id));
		} catch {
			// already gone
		}
	}
}

/** sha1 of the segment's lines (start..end, 1-based), or null if the file cannot be read. */
export async function hashSegment(seg: Segment): Promise<string | null> {
	try {
		const text = (await fs.promises.readFile(seg.file, "utf-8")).replace(/\r\n/g, "\n");
		const lines = text.split("\n");
		if (seg.end > lines.length) return null;
		const slice = lines.slice(seg.start - 1, seg.end).join("\n");
		return crypto.createHash("sha1").update(slice).digest("hex");
	} catch {
		return null;
	}
}

/** Human-friendly relative date, e.g. "5 min ago", "yesterday", "3 Nov". */
export function relativeDate(iso: string): string {
	const then = new Date(iso);
	const diffMin = Math.round((Date.now() - then.getTime()) / 60000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin} min ago`;
	const diffH = Math.round(diffMin / 60);
	if (diffH < 24) return `${diffH} h ago`;
	if (diffH < 48) return "yesterday";
	return then.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
