<script lang="ts">
	import ResultsGrid from '$lib/components/ResultsGrid.svelte';
	import TorrentSidebar from '$lib/components/TorrentSidebar.svelte';
	import LibraryPanel from '$lib/components/LibraryPanel.svelte';
	import MobileTabBar, { type MobileTab } from '$lib/components/MobileTabBar.svelte';
	import DownloadsModal from '$lib/components/DownloadsModal.svelte';
	import DownloadsHeaderIndicator from '$lib/components/DownloadsHeaderIndicator.svelte';
	import type { BookResult, SearchField, DownloadJob } from '$lib/types';
	import { toasts } from '$lib/stores/toasts';
	import { onMount } from 'svelte';

	// Search state
	let searchField: SearchField = $state('title');
	let searchQuery: string = $state('');

	// MAM results
	let books: BookResult[] = $state([]);
	let totalResults: number = $state(0);

	let loading = $state(false);
	let hasSearched = $state(false);
	let error = $state<string | null>(null);

	// Track downloading book IDs (to prevent duplicate downloads)
	let downloadingIds = $state<Set<number>>(new Set());

	// Jobs still being fetched from MAM / in early stages before qBittorrent picks them up
	let fetchingJobs = $state<DownloadJob[]>([]);

	// Sidebar ref for triggering refresh
	let sidebarRef: TorrentSidebar | undefined = $state();

	// Library panel ref for triggering refresh
	let libraryPanelRef: LibraryPanel | undefined = $state();

	// Downloading count from sidebar (for mobile badge & header indicator)
	let downloadingCount = $state(0);

	// Mobile state
	let isMobile = $state(false);
	let mobileTab = $state<MobileTab>('search');
	let previousMobileTab = $state<MobileTab>('search');

	// Downloads modal state
	let isDownloadsModalOpen = $state(false);

	function openDownloadsModal() {
		isDownloadsModalOpen = true;
	}

	function closeDownloadsModal() {
		isDownloadsModalOpen = false;
	}

	onMount(() => {
		// Setup media query listener for mobile detection
		const mediaQuery = window.matchMedia('(max-width: 767px)');
		isMobile = mediaQuery.matches;

		const handleResize = (e: MediaQueryListEvent) => {
			isMobile = e.matches;
		};

		mediaQuery.addEventListener('change', handleResize);
		return () => mediaQuery.removeEventListener('change', handleResize);
	});

	// Mobile tab management
	function handleMobileTabChange(tab: MobileTab) {
		previousMobileTab = mobileTab;
		mobileTab = tab;
	}

	// Compute slide direction for tab transitions
	const tabOrder: MobileTab[] = ['search', 'library', 'downloads'];
	const tabSlideClass = $derived.by(() => {
		const prevIndex = tabOrder.indexOf(previousMobileTab);
		const currIndex = tabOrder.indexOf(mobileTab);
		return currIndex > prevIndex ? 'tab-slide-left' : 'tab-slide-right';
	});

	async function performSearch(query: string, field: SearchField) {
		loading = true;
		error = null;
		hasSearched = true;

		try {
			const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&field=${field}`);
			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Search failed');
			}

			books = data.results;
			totalResults = data.total;
		} catch (e) {
			const message = e instanceof Error ? e.message : 'Search failed';
			error = message;
			toasts.error(message);
			books = [];
			totalResults = 0;
		} finally {
			loading = false;
		}
	}

	function handleSearch() {
		if (searchQuery.trim()) {
			performSearch(searchQuery.trim(), searchField);
		}
	}

	function handleFieldChange(field: SearchField) {
		searchField = field;
		if (searchQuery.trim() && hasSearched) {
			performSearch(searchQuery.trim(), field);
		}
	}

	function clearSearch() {
		searchQuery = '';
		hasSearched = false;
		books = [];
		totalResults = 0;
		error = null;
	}

	async function handleDownload(book: BookResult) {
		if (downloadingIds.has(book.id)) {
			toasts.warning('Already downloading this book');
			return;
		}

		downloadingIds = new Set([...downloadingIds, book.id]);

		// Create an initial fetching job for the sidebar to show immediately
		const tempJob: DownloadJob = {
			id: `fetching-${book.id}`,
			mamId: book.id,
			title: book.title,
			status: 'fetching',
			progress: 0,
			downloadSpeed: 0,
			uploadSpeed: 0,
			numPeers: 0
		};
		fetchingJobs = [...fetchingJobs, tempJob];

		// Auto-switch to downloads tab on mobile when download starts
		if (isMobile && mobileTab !== 'downloads') {
			handleMobileTabChange('downloads');
		}

		try {
			const response = await fetch('/api/download', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mamId: book.id, title: book.title })
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to start download');
			}

			const jobId = data.jobId;
			toasts.success(`Started downloading: ${book.title}`);

			// Tell sidebar to refresh immediately
			sidebarRef?.refresh();

			const eventSource = new EventSource(`/api/progress/${jobId}`);

			eventSource.onmessage = (event) => {
				const payload = JSON.parse(event.data);

				if (payload.type === 'progress') {
					const job = payload as DownloadJob;
					// Update the fetching job with real data
					if (job.status === 'downloading' || job.status === 'complete') {
						// Remove from fetchingJobs — qBittorrent has it now, sidebar will pick it up
						fetchingJobs = fetchingJobs.filter((j) => j.mamId !== book.id);
						sidebarRef?.refresh();
					}
				} else if (payload.type === 'done') {
					const job = payload as { status: string; error?: string };
					if (job.status === 'complete') {
						toasts.success(`Download complete: ${book.title}`);
					} else if (job.status === 'error') {
						toasts.error(`Download failed: ${job.error || 'Unknown error'}`);
					}

					eventSource.close();
					downloadingIds = new Set([...downloadingIds].filter((id) => id !== book.id));
					fetchingJobs = fetchingJobs.filter((j) => j.mamId !== book.id);

					// Refresh sidebar and library after a short delay
					setTimeout(() => {
						sidebarRef?.refresh();
						libraryPanelRef?.refresh();
					}, 2000);
				}
			};

			eventSource.onerror = () => {
				eventSource.close();
				downloadingIds = new Set([...downloadingIds].filter((id) => id !== book.id));
				fetchingJobs = fetchingJobs.filter((j) => j.mamId !== book.id);
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : 'Failed to start download';
			toasts.error(message);
			downloadingIds = new Set([...downloadingIds].filter((id) => id !== book.id));
			fetchingJobs = fetchingJobs.filter((j) => j.mamId !== book.id);
		}
	}

	// Total active download count
	const totalDownloadingCount = $derived(downloadingCount);
</script>

<div class="flex h-full w-full">
	<!-- Main content area (search panel on desktop, tab-controlled on mobile) -->
	<div class="relative flex flex-1 flex-col overflow-hidden border-neutral-800 md:border-r">
		<!-- Desktop: always show search content -->
		<!-- Mobile: only show when search tab is active -->
		{#if !isMobile || mobileTab === 'search'}
			<div class="flex flex-1 flex-col overflow-hidden">
				<!-- Search Header -->
				<div class="animate-fade-in px-4 py-6 sm:px-6 sm:py-8">
					<div class="mb-4 flex items-center justify-between gap-4 sm:mb-6">
						<h1 class="text-2xl font-bold text-white sm:text-3xl md:text-4xl">Search</h1>
						<div class="flex gap-2">
							<button
								type="button"
								onclick={() => handleFieldChange('title')}
								class="rounded-full px-3 py-1.5 text-xs font-medium transition-all sm:px-4 sm:text-sm {searchField ===
								'title'
									? 'bg-white text-black'
									: 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white'}"
							>
								Title
							</button>
							<button
								type="button"
								onclick={() => handleFieldChange('author')}
								class="rounded-full px-3 py-1.5 text-xs font-medium transition-all sm:px-4 sm:text-sm {searchField ===
								'author'
									? 'bg-white text-black'
									: 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white'}"
							>
								Author
							</button>
						</div>
					</div>

					<div class="relative">
						<!-- Leading icon: spinner or magnifier -->
						<div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4">
							{#if loading}
								<svg class="h-5 w-5 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
									<circle
										class="opacity-25"
										cx="12"
										cy="12"
										r="10"
										stroke="currentColor"
										stroke-width="4"
									></circle>
									<path
										class="opacity-75"
										fill="currentColor"
										d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
									></path>
								</svg>
							{:else}
								<svg
									class="h-5 w-5 text-neutral-400"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
									/>
								</svg>
							{/if}
						</div>

						<input
							type="text"
							bind:value={searchQuery}
							onkeydown={(e) => {
								if (e.key === 'Enter') handleSearch();
							}}
							placeholder={searchField === 'title'
								? 'Search by book title...'
								: 'Search by author name...'}
							class="w-full rounded-full border-0 bg-neutral-800 py-3 pl-12 text-white placeholder-neutral-500 ring-1 ring-neutral-700 transition-all focus:bg-neutral-750 focus:ring-2 focus:ring-blue-500 focus:outline-none {searchQuery
								? 'pr-10'
								: 'pr-4'}"
							disabled={loading}
						/>

						<!-- Clear button -->
						{#if searchQuery}
							<button
								type="button"
								onclick={clearSearch}
								class="absolute inset-y-0 right-0 flex items-center pr-3 text-neutral-400 transition-colors hover:text-white"
								aria-label="Clear search"
							>
								<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							</button>
						{/if}
					</div>
				</div>

				<!-- Results area -->
				<div class="min-h-0 flex-1 overflow-y-auto px-4 pb-20 sm:px-6 md:pb-8">
					{#if error}
						<div class="flex flex-col items-center justify-center py-12 text-center">
							<div class="mb-4 rounded-full bg-red-900/30 p-4">
								<svg
									class="h-8 w-8 text-red-400"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
									/>
								</svg>
							</div>
							<p class="text-lg font-medium text-red-400">{error}</p>
						</div>
					{:else if loading}
						<div class="flex flex-col items-center justify-center py-16">
							<svg class="h-10 w-10 animate-spin text-neutral-500" viewBox="0 0 24 24" fill="none">
								<circle
									class="opacity-25"
									cx="12"
									cy="12"
									r="10"
									stroke="currentColor"
									stroke-width="4"
								></circle>
								<path
									class="opacity-75"
									fill="currentColor"
									d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
								></path>
							</svg>
							<p class="mt-4 text-neutral-500">Searching...</p>
						</div>
					{:else if hasSearched}
						<ResultsGrid
							{books}
							total={totalResults}
							onDownload={handleDownload}
							{downloadingIds}
						/>
					{:else}
						<div class="flex flex-col items-center justify-center py-16 text-center">
							<svg
								class="mb-4 h-20 w-20 text-neutral-800"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="1"
									d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
								/>
							</svg>
							<p class="text-lg font-medium text-neutral-400">Find your books</p>
							<p class="mt-1 text-sm text-neutral-500">Search by title or author</p>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Mobile-only: Library tab -->
		{#if isMobile && mobileTab === 'library'}
			{#key mobileTab}
				<div class="absolute inset-0 flex flex-col bg-neutral-900 {tabSlideClass}">
					<div class="flex-1 overflow-hidden p-4 pb-20">
						<LibraryPanel bind:this={libraryPanelRef} forcedTab="library" hideTabBar={true} />
					</div>
				</div>
			{/key}
		{/if}

		<!-- Mobile-only: Downloads tab -->
		{#if isMobile && mobileTab === 'downloads'}
			{#key mobileTab}
				<div class="absolute inset-0 flex flex-col bg-neutral-900 {tabSlideClass}">
					<div class="animate-fade-in px-4 py-6">
						<h1 class="text-2xl font-bold text-white sm:text-3xl">Downloads</h1>
					</div>
					<div class="flex-1 overflow-hidden px-4 pb-20">
						<TorrentSidebar {fetchingJobs} onCountChange={(count) => (downloadingCount = count)} />
					</div>
				</div>
			{/key}
		{/if}
	</div>

	<!-- Side Panel (right side on desktop, hidden on mobile) - Library only -->
	<div class="hidden flex-col md:flex md:w-1/3">
		<LibraryPanel bind:this={libraryPanelRef} showLargeTitle={true}>
			{#snippet titleRight()}
				<div class="flex items-center gap-3">
					<DownloadsHeaderIndicator
						onClick={openDownloadsModal}
						downloadingCount={totalDownloadingCount}
						{fetchingJobs}
					/>
				</div>
			{/snippet}
		</LibraryPanel>
	</div>
</div>

<!-- Mobile Tab Bar -->
{#if isMobile}
	<MobileTabBar
		activeTab={mobileTab}
		activeDownloadCount={totalDownloadingCount + fetchingJobs.length}
		onTabChange={handleMobileTabChange}
	/>
{/if}

<!-- Downloads Modal (desktop drawer) -->
<DownloadsModal
	isOpen={isDownloadsModalOpen}
	onClose={closeDownloadsModal}
	{fetchingJobs}
	onCountChange={(count) => (downloadingCount = count)}
/>
