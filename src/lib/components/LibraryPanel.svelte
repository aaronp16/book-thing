<script lang="ts">
	import type { Shelf } from '$lib/types';
	import { onMount } from 'svelte';

	interface LibraryBookClick {
		id: string;
		title: string;
		author: string;
		currentShelfIds: string[];
	}

	interface Props {
		forcedTab?: 'library';
		hideTabBar?: boolean;
		showLargeTitle?: boolean;
		titleRight?: import('svelte').Snippet;
		onBookClick?: (book: LibraryBookClick) => void;
	}

	let {
		forcedTab,
		hideTabBar = false,
		showLargeTitle = false,
		titleRight,
		onBookClick
	}: Props = $props();

	interface LibraryBook {
		id: string;
		bookKey: string;
		title: string;
		author: string;
		hasCover: boolean;
		path: string;
		addedAt: string;
		lastModified: string;
		shelf?: string;
		shelfNames?: string[];
		copyCount?: number;
		relativePath?: string;
		extension?: string;
		size?: number;
	}

	const LIBRARY_COLUMN_COUNT = 4;
	const DEFAULT_COVER_RATIO = 1.5;

	let books = $state<LibraryBook[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let searchQuery = $state('');
	let bookCoverRatios = $state<Record<string, number>>({});
	let calibreImportAvailable = $state(false);
	let calibreImportLoading = $state(false);
	let calibreImportRunning = $state(false);
	let calibreImportMessage = $state<string | null>(null);

	// Delete confirmation: bookId currently pending confirmation, null = none
	let confirmDeleteId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);

	async function handleDelete(book: LibraryBook, e: MouseEvent) {
		e.stopPropagation();
		if (confirmDeleteId !== book.id) {
			confirmDeleteId = book.id;
			return;
		}
		// Second click — confirmed
		confirmDeleteId = null;
		deletingId = book.id;
		try {
			const res = await fetch(`/api/library/${book.id}`, { method: 'DELETE' });
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || 'Delete failed');
			}
			books = books.filter((b) => b.id !== book.id);
		} catch (e) {
			console.error('Delete failed:', e);
		} finally {
			deletingId = null;
		}
	}

	function cancelDelete(e: MouseEvent) {
		e.stopPropagation();
		confirmDeleteId = null;
	}

	// Shelf filtering
	let shelves = $state<Shelf[]>([]);
	let selectedShelfId = $state<string | null>(null);
	let shelvesLoading = $state(false);

	const filteredBooks = $derived.by(() => {
		if (!searchQuery.trim()) return books;

		const query = searchQuery.toLowerCase();
		return books.filter(
			(b) => b.title.toLowerCase().includes(query) || b.author.toLowerCase().includes(query)
		);
	});

	const libraryColumns = $derived.by(() => {
		const columns = Array.from({ length: LIBRARY_COLUMN_COUNT }, () => [] as LibraryBook[]);
		const heights = Array.from({ length: LIBRARY_COLUMN_COUNT }, () => 0);

		for (const book of filteredBooks) {
			const ratio = book.hasCover
				? (bookCoverRatios[book.id] ?? DEFAULT_COVER_RATIO)
				: DEFAULT_COVER_RATIO;
			let shortestColumnIndex = 0;
			for (let i = 1; i < heights.length; i += 1) {
				if (heights[i] < heights[shortestColumnIndex]) {
					shortestColumnIndex = i;
				}
			}

			columns[shortestColumnIndex].push(book);
			heights[shortestColumnIndex] += ratio;
		}

		return columns;
	});

	// Load/save shelf selection from localStorage
	onMount(() => {
		const saved = localStorage.getItem('library-selected-shelf');
		if (saved) {
			selectedShelfId = saved === 'null' ? null : saved;
		}
		fetchShelves();
		fetchCalibreImportStatus();
	});

	$effect(() => {
		// Save selection to localStorage whenever it changes
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(
				'library-selected-shelf',
				selectedShelfId === null ? 'null' : selectedShelfId.toString()
			);
		}
	});

	// Re-fetch library when shelf selection changes
	$effect(() => {
		fetchLibrary();
		// eslint-disable-next-line no-unused-expressions
		selectedShelfId;
	});

	async function fetchShelves() {
		shelvesLoading = true;
		try {
			const response = await fetch('/api/shelves');
			if (!response.ok) {
				throw new Error('Failed to load shelves');
			}
			const data = await response.json();
			shelves = data.shelves || [];
		} catch (e) {
			console.error('Failed to load shelves:', e);
		} finally {
			shelvesLoading = false;
		}
	}

	async function fetchLibrary() {
		loading = true;
		error = null;

		try {
			const url = selectedShelfId ? `/api/library?shelf=${selectedShelfId}` : '/api/library';

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error('Failed to load library');
			}
			const data = await response.json();
			books = data.books || [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load library';
		} finally {
			loading = false;
		}
	}

	async function fetchCalibreImportStatus() {
		calibreImportLoading = true;
		try {
			const response = await fetch('/api/calibre/import');
			if (!response.ok) {
				throw new Error('Failed to inspect Calibre import status');
			}
			const data = await response.json();
			calibreImportAvailable = Boolean(data.available);
		} catch {
			calibreImportAvailable = false;
		} finally {
			calibreImportLoading = false;
		}
	}

	async function handleCalibreImport() {
		if (calibreImportRunning) return;

		try {
			const previewResponse = await fetch('/api/calibre/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dryRun: true })
			});
			const previewData = await previewResponse.json();
			if (!previewResponse.ok) {
				throw new Error(previewData.error || 'Failed to preview Calibre import');
			}

			const preview = previewData.preview;
			const topShelves = preview.shelfBreakdown
				.slice(0, 5)
				.map(
					(item: { shelfName: string; bookCount: number }) =>
						`${item.shelfName} (${item.bookCount})`
				)
				.join(', ');
			const confirmed = confirm(
				[
					`This will copy ${preview.plannedCopies} file(s) from Calibre into ${preview.plannedShelves} shelf(s).`,
					preview.unshelvedBooks > 0
						? `${preview.unshelvedBooks} unshelved book(s) will go to Imported.`
						: 'All books have shelf mappings.',
					topShelves ? `Top shelves: ${topShelves}` : '',
					'',
					'Continue?'
				]
					.filter(Boolean)
					.join('\n')
			);
			if (!confirmed) return;
		} catch (e) {
			calibreImportMessage = e instanceof Error ? e.message : 'Failed to preview Calibre import';
			return;
		}

		calibreImportRunning = true;
		calibreImportMessage = null;
		try {
			const response = await fetch('/api/calibre/import', { method: 'POST' });
			const data = await response.json();
			if (!response.ok) {
				throw new Error(data.error || 'Failed to import from Calibre');
			}
			const summary = data.summary;
			calibreImportMessage = `Imported ${summary.copiedFiles} file(s) into ${summary.importedShelves} shelf(s)`;
			refresh();
		} catch (e) {
			calibreImportMessage = e instanceof Error ? e.message : 'Failed to import from Calibre';
		} finally {
			calibreImportRunning = false;
		}
	}

	export function refresh() {
		fetchLibrary();
		fetchShelves();
	}

	function clearSearch() {
		searchQuery = '';
	}

	function rememberBookCoverRatio(bookId: string, event: Event) {
		const img = event.currentTarget as HTMLImageElement;
		if (!img.naturalWidth || !img.naturalHeight) return;
		const ratio = img.naturalHeight / img.naturalWidth;
		if (!Number.isFinite(ratio) || ratio <= 0) return;
		if (bookCoverRatios[bookId] === ratio) return;
		bookCoverRatios = { ...bookCoverRatios, [bookId]: ratio };
	}

	async function handleBookClick(book: LibraryBook) {
		if (!onBookClick) return;
		const currentShelfIds = book.shelfNames ?? (book.shelf ? [book.shelf] : []);
		onBookClick({ id: book.id, title: book.title, author: book.author, currentShelfIds });
	}
</script>

<div class="flex h-full flex-col">
	<div class="flex flex-1 flex-col overflow-hidden">
		<!-- Header -->
		<div class="animate-fade-in px-4 py-6 sm:px-6 sm:py-8">
			{#if showLargeTitle}
				<div class="mb-4 flex items-center justify-between gap-4 sm:mb-6">
					<div>
						<h1 class="text-2xl font-bold text-white sm:text-3xl md:text-4xl">Library</h1>
						{#if calibreImportMessage}
							<p class="mt-1 text-xs text-neutral-400">{calibreImportMessage}</p>
						{/if}
					</div>
					<div class="flex items-center gap-2">
						{#if calibreImportAvailable}
							<button
								type="button"
								onclick={handleCalibreImport}
								disabled={calibreImportRunning}
								class="rounded-full bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
							>
								{calibreImportRunning ? 'Importing...' : 'Import From Calibre'}
							</button>
						{/if}
						{#if titleRight}
							{@render titleRight()}
						{/if}
					</div>
				</div>
			{/if}

			<!-- Shelf filter tabs -->
			{#if shelves.length > 0}
				<div class="mb-4 flex items-center gap-2 overflow-x-auto">
					<button
						type="button"
						onclick={() => (selectedShelfId = null)}
						class="rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-all {selectedShelfId ===
						null
							? 'bg-white text-black'
							: 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white'}"
					>
						All Books
					</button>
					{#each shelves as shelf (shelf.id)}
						<button
							type="button"
							onclick={() => (selectedShelfId = shelf.id)}
							class="rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-all {selectedShelfId ===
							shelf.id
								? 'bg-white text-black'
								: 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white'}"
						>
							{shelf.name}
							{#if shelf.bookCount !== undefined}
								<span class="ml-1.5 text-xs opacity-75">({shelf.bookCount})</span>
							{/if}
						</button>
					{/each}
				</div>
			{/if}

			<!-- Search bar -->
			{#if books.length > 0}
				<div class="relative">
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
						placeholder="Filter library..."
						class="w-full rounded-full border-0 bg-neutral-800 py-3 pr-12 pl-12 text-white placeholder-neutral-500 ring-1 ring-neutral-700 transition-all focus:bg-neutral-750 focus:ring-2 focus:ring-blue-500 focus:outline-none"
					/>
					{#if searchQuery}
						<button
							onclick={clearSearch}
							class="absolute top-1/2 right-4 -translate-y-1/2 rounded-full p-0.5 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-300"
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
					{:else}
						<button
							onclick={fetchLibrary}
							disabled={loading}
							class="absolute top-1/2 right-4 -translate-y-1/2 rounded-full p-0.5 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-300 disabled:opacity-50"
							title="Refresh library"
						>
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
								/>
							</svg>
						</button>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Results area -->
		<div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-8">
			<!-- Stats -->
			{#if books.length > 0}
				<div class="mb-3 flex items-center justify-between text-xs text-neutral-500">
					<span>
						{#if searchQuery.trim()}
							Found {filteredBooks.length} book{filteredBooks.length !== 1 ? 's' : ''}
						{:else}
							{books.length} book{books.length !== 1 ? 's' : ''}
						{/if}
					</span>
				</div>
			{/if}

			<!-- Library Content -->
			{#if error}
				<div class="flex flex-col items-center justify-center py-12 text-center">
					<div class="mb-3 rounded-full bg-red-900/30 p-3">
						<svg class="h-6 w-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
							/>
						</svg>
					</div>
					<p class="text-sm text-red-400">{error}</p>
					<button onclick={fetchLibrary} class="mt-2 text-xs text-neutral-400 hover:text-white"
						>Try again</button
					>
				</div>
			{:else if loading && books.length === 0}
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
					<p class="mt-3 text-sm text-neutral-500">Loading library...</p>
				</div>
			{:else if books.length === 0}
				<div class="flex flex-col items-center justify-center py-12 text-center">
					<svg
						class="mb-3 h-12 w-12 text-neutral-700"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="1.5"
							d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
						/>
					</svg>
					<p class="text-sm text-neutral-400">Your library is empty</p>
					<p class="mt-1 text-xs text-neutral-500">Downloaded books will appear here</p>
				</div>
			{:else if filteredBooks.length === 0}
				<div class="flex flex-col items-center justify-center py-12 text-center">
					<svg
						class="mb-3 h-10 w-10 text-neutral-700"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="1.5"
							d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
						/>
					</svg>
					<p class="text-sm text-neutral-400">No matches found</p>
					<p class="mt-1 text-xs text-neutral-500">Try a different search term</p>
				</div>
			{:else}
				<!-- Book cover columns -->
				<div class="grid grid-cols-4 gap-2">
					{#each libraryColumns as column, columnIndex (`library-column-${columnIndex}`)}
						<div class="flex min-w-0 flex-col gap-2">
							{#each column as book (book.id)}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<div
									role="button"
									tabindex="0"
									onclick={() => {
										confirmDeleteId = null;
										handleBookClick(book);
									}}
									class="group relative overflow-hidden rounded-lg bg-neutral-800 text-left {onBookClick
										? 'cursor-pointer'
										: 'cursor-default'}"
								>
									{#if deletingId === book.id}
										<div
											class="flex h-full min-h-52 w-full items-center justify-center bg-neutral-900/80"
										>
											<svg
												class="h-6 w-6 animate-spin text-neutral-400"
												viewBox="0 0 24 24"
												fill="none"
											>
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
										</div>
									{:else}
										{#if book.hasCover}
											<img
												src="/api/library/cover/{book.id}?v={encodeURIComponent(book.lastModified)}"
												alt={book.title}
												class="block h-auto w-full transition-opacity group-hover:opacity-70"
												loading="lazy"
												onload={(event) => rememberBookCoverRatio(book.id, event)}
											/>
										{:else}
											<div
												class="flex min-h-52 w-full flex-col items-center justify-center p-2 text-center"
											>
												<svg
													class="mb-1 h-6 w-6 text-neutral-600"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="1.5"
														d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
													/>
												</svg>
												<span class="text-[10px] leading-tight text-neutral-500">{book.title}</span>
											</div>
										{/if}

										<div
											class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100"
										>
											<p class="truncate text-xs font-medium text-white">{book.title}</p>
											<p class="truncate text-[10px] text-neutral-400">{book.author}</p>
											{#if book.shelf}
												<p class="truncate text-[10px] text-neutral-500">
													{#if book.copyCount && book.copyCount > 1}
														Shelves: {(book.shelfNames ?? []).join(', ')}
													{:else}
														Shelf: {book.shelf}
													{/if}
												</p>
											{/if}
											{#if onBookClick}
												<p class="mt-0.5 text-[10px] text-blue-400">Edit cover / copy to shelf</p>
											{/if}
										</div>

										{#if confirmDeleteId === book.id}
											<div
												class="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-2"
											>
												<p class="text-center text-[10px] leading-tight font-medium text-white">
													{#if book.copyCount && book.copyCount > 1}
														Delete the selected shelf copy?
													{:else}
														Delete this book?
													{/if}
												</p>
												<button
													type="button"
													onclick={(e) => handleDelete(book, e)}
													class="w-full rounded bg-red-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-red-500"
												>
													Delete
												</button>
												<button
													type="button"
													onclick={cancelDelete}
													class="w-full rounded bg-neutral-700 px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-600"
												>
													Cancel
												</button>
											</div>
										{:else}
											<button
												type="button"
												onclick={(e) => handleDelete(book, e)}
												class="pointer-events-auto absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-600 hover:text-white"
												aria-label="Delete book"
												title="Delete book"
											>
												<svg
													class="h-3.5 w-3.5"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
													/>
												</svg>
											</button>
										{/if}
									{/if}
								</div>
							{/each}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
