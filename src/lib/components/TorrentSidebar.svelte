<script lang="ts">
	import type { TorrentInfo, DownloadJob } from '$lib/types';

	interface Props {
		/** Jobs still being fetched from MAM (before qBittorrent has them) */
		fetchingJobs?: DownloadJob[];
		/** Whether to show the large title (mobile full-screen mode) */
		showTitle?: boolean;
		/** Callback when the downloading count changes */
		onCountChange?: (count: number) => void;
	}

	let { fetchingJobs = [], showTitle = false, onCountChange }: Props = $props();

	let torrents = $state<TorrentInfo[]>([]);
	let activeTab = $state<'downloading' | 'seeding'>('downloading');
	let pollTimer = $state<ReturnType<typeof setInterval> | null>(null);
	let loading = $state(false);

	const downloading = $derived.by(() => {
		const qbDownloading = torrents.filter((t) => t.status === 'downloading');
		// Merge in fetching jobs that aren't yet in qBittorrent
		const qbHashes = new Set(qbDownloading.map((t) => t.infoHash));
		const fetching: TorrentInfo[] = fetchingJobs
			.filter((j) => !j.infoHash || !qbHashes.has(j.infoHash))
			.map((j) => ({
				infoHash: j.infoHash || j.id,
				name: j.title,
				progress: j.progress,
				downloadSpeed: j.downloadSpeed,
				uploadSpeed: j.uploadSpeed,
				numPeers: j.numPeers,
				downloaded: 0,
				uploaded: 0,
				size: 0,
				ratio: 0,
				status: 'downloading' as const,
				files: [],
				addedAt: new Date().toISOString()
			}));
		return [...fetching, ...qbDownloading];
	});

	const seeding = $derived(torrents.filter((t) => t.status === 'seeding'));

	const totalDownloading = $derived(downloading.length);

	// Notify parent when downloading count changes
	$effect(() => {
		onCountChange?.(totalDownloading);
	});

	async function fetchTorrents() {
		try {
			const response = await fetch('/api/torrents');
			if (response.ok) {
				const data = await response.json();
				torrents = data.torrents || [];
			}
		} catch {
			// Ignore fetch errors silently
		}
	}

	function startPolling() {
		if (pollTimer) return;
		pollTimer = setInterval(fetchTorrents, 3000);
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	/** Trigger an immediate refresh (called by parent after starting a download) */
	export function refresh() {
		fetchTorrents();
		startPolling();
	}

	// Start/stop polling based on whether there are active downloads
	$effect(() => {
		const hasActive = downloading.length > 0 || fetchingJobs.length > 0;
		if (hasActive) {
			startPolling();
		} else {
			stopPolling();
		}
	});

	// Initial load
	$effect(() => {
		loading = true;
		fetchTorrents().finally(() => (loading = false));
		return () => stopPolling();
	});

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
	}

	function formatSpeed(bytesPerSec: number): string {
		return `${formatBytes(bytesPerSec)}/s`;
	}
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="px-4 pt-5 pb-3 sm:px-5">
		{#if showTitle}
			<h1 class="mb-4 text-2xl font-bold text-white">Torrents</h1>
		{/if}
		<div class="flex gap-1 rounded-lg bg-neutral-800/50 p-1">
			<button
				type="button"
				onclick={() => (activeTab = 'downloading')}
				class="flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {activeTab ===
				'downloading'
					? 'bg-neutral-700 text-white'
					: 'text-neutral-400 hover:text-neutral-200'}"
			>
				Downloading
				{#if totalDownloading > 0}
					<span
						class="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500/20 px-1 text-[10px] font-semibold text-blue-400"
					>
						{totalDownloading}
					</span>
				{/if}
			</button>
			<button
				type="button"
				onclick={() => (activeTab = 'seeding')}
				class="flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {activeTab ===
				'seeding'
					? 'bg-neutral-700 text-white'
					: 'text-neutral-400 hover:text-neutral-200'}"
			>
				Seeding
				{#if seeding.length > 0}
					<span
						class="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-green-500/20 px-1 text-[10px] font-semibold text-green-400"
					>
						{seeding.length}
					</span>
				{/if}
			</button>
		</div>
	</div>

	<!-- Content -->
	<div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">
		{#if activeTab === 'downloading'}
			{#if loading && totalDownloading === 0}
				<div class="flex flex-col items-center justify-center py-12">
					<svg class="h-8 w-8 animate-spin text-neutral-600" viewBox="0 0 24 24" fill="none">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
						></circle>
						<path
							class="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						></path>
					</svg>
				</div>
			{:else if totalDownloading === 0}
				<div class="flex flex-col items-center justify-center py-12 text-center">
					<svg
						class="mb-3 h-12 w-12 text-neutral-800"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="1"
							d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
						/>
					</svg>
					<p class="text-sm text-neutral-500">Nothing downloading</p>
				</div>
			{:else}
				<div class="space-y-2">
					<!-- MAM torrent downloads -->
					{#each downloading as torrent (torrent.infoHash)}
						<div class="rounded-lg bg-neutral-800/50 p-3">
							<div class="mb-2 flex items-center justify-between gap-2">
								<span class="truncate text-sm text-white">{torrent.name}</span>
								<div class="flex flex-shrink-0 items-center gap-1.5">
									<span
										class="rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400"
										>MAM</span
									>
									<span class="text-xs font-medium text-neutral-400">
										{Math.round(torrent.progress * 100)}%
									</span>
								</div>
							</div>
							<div class="h-1.5 w-full overflow-hidden rounded-full bg-neutral-700">
								<div
									class="h-full bg-blue-500 transition-all duration-300"
									style="width: {Math.round(torrent.progress * 100)}%"
								></div>
							</div>
							<div class="mt-1.5 flex items-center gap-3 text-xs text-neutral-500">
								{#if torrent.downloadSpeed > 0}
									<span>{formatSpeed(torrent.downloadSpeed)}</span>
								{/if}
								{#if torrent.numPeers > 0}
									<span>{torrent.numPeers} peers</span>
								{/if}
								{#if torrent.downloadSpeed === 0 && torrent.numPeers === 0}
									<span>Connecting...</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{:else if seeding.length === 0}
			<div class="flex flex-col items-center justify-center py-12 text-center">
				<svg
					class="mb-3 h-12 w-12 text-neutral-800"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1"
						d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
					/>
				</svg>
				<p class="text-sm text-neutral-500">Nothing seeding</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each seeding as torrent (torrent.infoHash)}
					<div class="rounded-lg bg-neutral-800/50 p-3">
						<div class="mb-1 flex items-center justify-between gap-2">
							<span class="truncate text-sm text-white">{torrent.name}</span>
							<span class="flex-shrink-0 text-xs font-medium text-green-400">
								{torrent.ratio.toFixed(2)}
							</span>
						</div>
						<div class="flex items-center gap-3 text-xs text-neutral-500">
							<span>Uploaded {formatBytes(torrent.uploaded)}</span>
							{#if torrent.uploadSpeed > 0}
								<span>{formatSpeed(torrent.uploadSpeed)}</span>
							{/if}
							{#if torrent.numPeers > 0}
								<span>{torrent.numPeers} peers</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
