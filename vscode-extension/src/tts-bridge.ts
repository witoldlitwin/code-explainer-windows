import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as cp from "child_process";

const SAMPLE_RATE = 24000;
const SERVER_START_TIMEOUT_MS = 30_000;

/** Must match SENTENCE_SPLIT_RE in scripts/tts_server.py: the server sends one chunk per sentence. */
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

/** Split text into sentences exactly as the TTS server does. */
export function splitSentences(text: string): string[] {
	return text.trim().split(SENTENCE_SPLIT_RE).filter(Boolean);
}

export interface TTSOptions {
	voice: string;
	speed: number;
}

function runtimeDir(): string {
	return path.join(os.homedir(), ".claude-explainer");
}
const portFile = () => path.join(runtimeDir(), "tts-server.port");
const tokenFile = () => path.join(runtimeDir(), "tts-server.token");
const pidFile = () => path.join(runtimeDir(), "tts-server.pid");

/** Read the server TCP port, or undefined if missing/invalid. */
function readPort(): number | undefined {
	try {
		const port = parseInt(fs.readFileSync(portFile(), "ascii").trim(), 10);
		return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
	} catch {
		return undefined;
	}
}

/** Read the auth token, or undefined if missing/invalid. */
function readToken(): string | undefined {
	try {
		const token = fs.readFileSync(tokenFile(), "utf-8").trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Check if the TTS server process is alive by verifying the PID file.
 */
function isServerProcessAlive(): boolean {
	try {
		const pid = parseInt(fs.readFileSync(pidFile(), "utf-8").trim(), 10);
		if (!Number.isInteger(pid) || pid <= 0) return false;
		process.kill(pid, 0); // signal 0 = check alive
		return true;
	} catch {
		return false;
	}
}

/**
 * Remove stale port, token and PID files left by a dead server.
 */
function cleanupStaleFiles(): void {
	for (const p of [portFile(), tokenFile(), pidFile()]) {
		try {
			fs.unlinkSync(p);
		} catch {}
	}
}

/**
 * Ping the server over TCP to verify it's responsive.
 * Resolves true if alive, false otherwise.
 */
function pingServer(): Promise<boolean> {
	return new Promise((resolve) => {
		const port = readPort();
		const token = readToken();
		if (port === undefined || token === undefined) {
			resolve(false);
			return;
		}

		const conn = net.createConnection({ host: "127.0.0.1", port });
		const timeout = setTimeout(() => {
			conn.destroy();
			resolve(false);
		}, 2000);

		conn.on("connect", () => {
			conn.end(JSON.stringify({ token, ping: true }), "utf-8");
		});

		conn.on("data", () => {
			clearTimeout(timeout);
			conn.destroy();
			resolve(true);
		});

		conn.on("error", () => {
			clearTimeout(timeout);
			resolve(false);
		});

		conn.on("close", () => {
			clearTimeout(timeout);
			resolve(false);
		});
	});
}

let workspaceRoot: string | undefined;

/**
 * Set the workspace root so we can find the TTS server script and venv Python.
 * Call this from extension.ts during activation.
 */
export function setWorkspaceRoot(root: string): void {
	workspaceRoot = root;
}

/** Known locations to search for the code-explainer project root. */
function getProjectRootCandidates(): string[] {
	const candidates: string[] = [];
	if (workspaceRoot) candidates.push(workspaceRoot);
	// Explicit Claude config dir, if VS Code inherited it
	const configDir = process.env.CLAUDE_CONFIG_DIR;
	if (configDir) candidates.push(path.join(configDir, "skills", "explainer"));
	const home = os.homedir();
	if (home) {
		// Skills directories: ~/.claude plus any ~/.claude-* profile (e.g. .claude-personal, .claude-work)
		candidates.push(path.join(home, ".claude", "skills", "explainer"));
		try {
			for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
				if (entry.isDirectory() && entry.name.startsWith(".claude-")) {
					candidates.push(path.join(home, entry.name, "skills", "explainer"));
				}
			}
		} catch {}
	}
	return candidates;
}

/**
 * Resolve the path to the TTS server script.
 */
function getServerScript(): string | undefined {
	for (const root of getProjectRootCandidates()) {
		const p = path.join(root, "scripts", "tts_server.py");
		if (fs.existsSync(p)) return p;
	}
	return undefined;
}

/**
 * Find the venv Python that has the TTS dependencies installed.
 */
function findVenvPython(): string {
	for (const root of getProjectRootCandidates()) {
		const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
		if (fs.existsSync(venvPython)) {
			return path.resolve(venvPython);
		}
	}
	return "python";
}

/**
 * Start the TTS server daemon and wait for it to be ready.
 * Resolves true if server started successfully, false otherwise.
 */
function startServer(): Promise<boolean> {
	return new Promise((resolve) => {
		const serverScript = getServerScript();
		if (!serverScript) {
			console.error("[tts-bridge] Server script not found in workspace:", workspaceRoot);
			resolve(false);
			return;
		}

		const pythonBin = findVenvPython();
		console.log(`[tts-bridge] Starting TTS server daemon using ${pythonBin}...`);

		const env = { ...process.env };
		if (workspaceRoot) env.TTS_WORKSPACE_ROOT = workspaceRoot;

		let poll: NodeJS.Timeout | undefined;
		let polling = false;

		cp.execFile(
			pythonBin,
			[serverScript, "--daemon"],
			{ timeout: 10_000, env, windowsHide: true },
			(err) => {
				if (err) {
					console.error("[tts-bridge] Failed to start server daemon:", err);
					if (poll) clearInterval(poll);
					resolve(false);
				}
			},
		);

		// Poll for port file to appear, then ping to confirm server is ready
		const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
		poll = setInterval(async () => {
			if (polling) return;
			polling = true;
			try {
				if (readPort() !== undefined && (await pingServer())) {
					clearInterval(poll);
					resolve(true);
				} else if (Date.now() > deadline) {
					clearInterval(poll);
					console.error("[tts-bridge] Server did not start in time.");
					resolve(false);
				}
			} finally {
				polling = false;
			}
		}, 500);
	});
}

let pendingEnsure: Promise<boolean> | undefined;

/**
 * Ensure the TTS server is running. Starts it if needed.
 * Concurrent calls are coalesced into a single startup attempt.
 * Returns true if server is available, false otherwise.
 */
export async function ensureServer(): Promise<boolean> {
	if (pendingEnsure) return pendingEnsure;
	pendingEnsure = ensureServerImpl();
	try {
		return await pendingEnsure;
	} finally {
		pendingEnsure = undefined;
	}
}

async function ensureServerImpl(): Promise<boolean> {
	// Fast path: port file exists and server responds to ping
	if (fs.existsSync(portFile())) {
		if (await pingServer()) {
			return true;
		}
		if (isServerProcessAlive()) {
			// Process alive but ping failed (e.g. busy synthesizing): retry, never respawn.
			for (let i = 0; i < 3; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				if (await pingServer()) return true;
			}
			console.warn("[tts-bridge] Server process alive but not responding; TTS unavailable for this call.");
			return false;
		}
		// Port file exists but server is dead — clean up
		console.log("[tts-bridge] Stale server files detected, cleaning up...");
		cleanupStaleFiles();
	}

	// Server not running — try to start it
	return startServer();
}

/**
 * Streams TTS audio from the Kokoro server.
 * Automatically starts the server if it's not running.
 * Calls onChunk with base64-encoded float32 PCM data for each sentence,
 * plus the chunk's index (= index of its sentence in splitSentences(text)).
 * Calls onEnd when the stream completes.
 * Returns a function to abort the stream.
 */
export function streamTTS(
	text: string,
	options: TTSOptions,
	onChunk: (base64Data: string, sampleRate: number, chunkIndex: number) => void,
	onEnd: () => void,
	onError: (err: Error) => void,
): () => void {
	let aborted = false;
	let conn: net.Socket | undefined;

	const run = async () => {
		if (!(await ensureServer())) {
			if (!aborted) onError(new Error("TTS server unavailable"));
			return;
		}
		if (aborted) return;
		conn = connectAndStream(text, options, onChunk, onEnd, onError, () => aborted);
	};

	run();

	return () => {
		aborted = true;
		if (conn) conn.destroy();
	};
}

/**
 * Internal: connect to the running server and stream audio.
 */
function connectAndStream(
	text: string,
	options: TTSOptions,
	onChunk: (base64Data: string, sampleRate: number, chunkIndex: number) => void,
	onEnd: () => void,
	onError: (err: Error) => void,
	isAborted: () => boolean,
): net.Socket {
	let ended = false;
	let chunkIndex = 0;

	const port = readPort();
	const token = readToken();
	const conn = new net.Socket();

	if (port === undefined || token === undefined) {
		setImmediate(() => {
			if (!isAborted()) onError(new Error("TTS server port/token unavailable"));
		});
		return conn;
	}

	conn.on("connect", () => {
		const request = JSON.stringify({
			token,
			// One id per extension host: a new request from this window
			// cancels the server's work on any older one.
			client: `ext-${process.pid}`,
			text,
			voice: options.voice,
			speed: options.speed,
		});
		conn.end(request, "utf-8");
	});

	let buffer = Buffer.alloc(0);
	let waitingForHeader = true;
	let expectedLength = 0;

	conn.on("data", (data: Buffer) => {
		if (isAborted()) return;

		buffer = Buffer.concat([buffer, data]);

		while (buffer.length >= 4) {
			if (waitingForHeader) {
				expectedLength = buffer.readUInt32BE(0);
				buffer = buffer.subarray(4);

				if (expectedLength === 0) {
					ended = true;
					onEnd();
					conn.destroy();
					return;
				}
				waitingForHeader = false;
			}

			if (!waitingForHeader && buffer.length >= expectedLength) {
				const audioBytes = buffer.subarray(0, expectedLength);
				buffer = buffer.subarray(expectedLength);
				waitingForHeader = true;

				onChunk(audioBytes.toString("base64"), SAMPLE_RATE, chunkIndex++);
			} else {
				break;
			}
		}
	});

	conn.on("error", (err) => {
		if (!isAborted()) onError(err);
	});

	conn.on("close", () => {
		if (!isAborted() && !ended && waitingForHeader && buffer.length === 0) {
			onEnd();
		}
	});

	conn.connect({ host: "127.0.0.1", port });

	return conn;
}

/**
 * Check if the TTS server is available (quick, non-blocking check).
 * For a more reliable check that auto-starts the server, use streamTTS directly.
 */
export function isTTSAvailable(): boolean {
	// If port file exists and process is alive, likely available
	if (fs.existsSync(portFile()) && isServerProcessAlive()) {
		return true;
	}
	// Even if server is down, we can auto-start it — so report available
	// if the server script exists (meaning TTS is installed)
	return getServerScript() !== undefined;
}
