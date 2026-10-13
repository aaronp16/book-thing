<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import type { BookMetadata, Shelf } from '$lib/types';
	import CoverPicker from './CoverPicker.svelte';

	interface BookInfo {
		title: string;
		author: string;
	}

	interface Props {
		isOpen: boolean;
		book: BookInfo | null;
		initialShelfIds?: string[];
		/** When true, shelves are optional (editing existing book) */
		isEdit?: boolean;
		/** Library item ID; when set, embedded book metadata is shown */
		libraryBookId?: string | null;
		onConfirm: (shelfIds: string[]) => void;
		onCancel: () => void;
		/** Called after a new cover has been embedded in the book */
		onCoverChanged?: () => void;
	}

	let {
		isOpen,
		book,
		initialShelfIds = [],
		isEdit = false,
		libraryBookId = null,
		onConfirm,
		onCancel,
		onCoverChanged
	}: Props = $props();

	let shelves = $state<Shelf[]>([]);
	let selectedShelfIds = $state<Set<string>>(new Set());
	let shelvesLoading = $state(true);
	let shelvesError = $state<string | null>(null);
	let cachedShelves = $state<Shelf[] | null>(null);

	let metadata = $state<BookMetadata | null>(null);
	let metadataLoading = $state(false);
	let metadataError = $state<string | null>(null);
	let descriptionExpanded = $state(false);
	let coverMissing = $state(false);
	let pickingCover = $state(false);
	/** Bumped after saving so the <img> refetches the embedded cover */
	let coverVersion = $state(0);

	function handleCoverSaved() {
		pickingCover = false;
		coverMissing = false;
		coverVersion = Date.now();
		onCoverChanged?.();
	}

	type Tab = 'details' | 'shelves';
	let activeTab = $state<Tab>('details');
	/** Library books get Details/Shelves tabs; search downloads only pick shelves */
	const showTabs = $derived(!!libraryBookId);
	const showShelves = $derived(!showTabs || activeTab === 'shelves');

	// Fetch shelves when modal transitions from closed → open
	// Using a previous-value pattern so state writes inside the modal don't re-trigger this.
	let wasOpen = $state(false);
	$effect(() => {
		if (isOpen && !wasOpen && book) {
			wasOpen = true;
			selectedShelfIds = new Set(initialShelfIds);
			fetchShelves();
			metadata = null;
			metadataError = null;
			descriptionExpanded = false;
			coverMissing = false;
			pickingCover = false;
			activeTab = 'details';
			if (libraryBookId) fetchMetadata(libraryBookId);
		} else if (!isOpen && wasOpen) {
			wasOpen = false;
		}
	});

	async function fetchShelves() {
		if (cachedShelves) {
			shelves = cachedShelves;
			shelvesLoading = false;
			shelvesError = null;
			return;
		}
		shelvesLoading = true;
		shelvesError = null;
		try {
			const response = await fetch('/api/shelves');
			if (!response.ok) throw new Error('Failed to load shelves');
			const data = await response.json();
			shelves = data.shelves || [];
			cachedShelves = shelves;
			if (shelves.length === 0) {
				shelvesError = 'No shelves found.';
			}
		} catch (e) {
			shelvesError = e instanceof Error ? e.message : 'Failed to load shelves';
		} finally {
			shelvesLoading = false;
		}
	}

	async function fetchMetadata(id: string) {
		metadataLoading = true;
		try {
			const response = await fetch(`/api/library/${id}/metadata`);
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Failed to read metadata');
			metadata = data.metadata;
			if (!metadata) metadataError = 'No readable metadata for this format.';
		} catch (e) {
			metadataError = e instanceof Error ? e.message : 'Failed to read metadata';
		} finally {
			metadataLoading = false;
		}
	}

	const metadataRows = $derived.by(() => {
		if (!metadata) return [];
		const rows: [string, string][] = [];
		if (metadata.title) rows.push(['Title', metadata.title]);
		if (metadata.authors.length) rows.push(['Author', metadata.authors.join(', ')]);
		if (metadata.series)
			rows.push([
				'Series',
				metadata.seriesIndex !== undefined
					? `${metadata.series} #${metadata.seriesIndex}`
					: metadata.series
			]);
		if (metadata.publisher) rows.push(['Publisher', metadata.publisher]);
		if (metadata.published) rows.push(['Published', metadata.published]);
		if (metadata.language) rows.push(['Language', metadata.language]);
		if (metadata.isbn) rows.push(['ISBN', metadata.isbn]);
		if (metadata.rating !== undefined) rows.push(['Rating', `${metadata.rating} / 5`]);
		return rows;
	});

	function toggleShelf(shelfId: string) {
		const newSet = new Set(selectedShelfIds);
		if (newSet.has(shelfId)) {
			newSet.delete(shelfId);
		} else {
			newSet.add(shelfId);
		}
		selectedShelfIds = newSet;
	}

	function handleConfirm() {
		if (!canDownload) return;
		onConfirm(Array.from(selectedShelfIds));
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onCancel();
	}

	function handleEscape(e: KeyboardEvent) {
		if (e.key === 'Escape') onCancel();
	}

	const canDownload = $derived(!shelvesLoading);
</script>

{#if isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		onclick={handleBackdropClick}
		onkeydown={handleEscape}
		role="button"
		tabindex="-1"
		transition:fade={{ duration: 200 }}
	>
		<!-- Modal -->
		<div
			class="flex max-h-[90vh] w-full {showTabs
				? 'h-[36rem] max-w-lg'
				: 'max-w-sm'} flex-col rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl"
			transition:fly={{ y: 20, duration: 300, opacity: 0 }}
			role="dialog"
			aria-modal="true"
			aria-labelledby="shelf-selector-title"
		>
			<!-- Header -->
			<div
				class="flex shrink-0 items-center justify-between px-6 {showTabs
					? 'pt-4 pb-3'
					: 'border-b border-neutral-800 py-4'}"
			>
				<div>
					<h2 id="shelf-selector-title" class="text-xl font-bold text-white">
						{isEdit ? 'Edit Book' : 'Download Book'}
					</h2>
					{#if book}
						<p class="mt-0.5 truncate text-sm text-neutral-400">
							{book.title}
							{#if book.author}
								&mdash; {book.author}
							{/if}
						</p>
					{/if}
				</div>
				<button
					onclick={onCancel}
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white"
					aria-label="Close"
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
			</div>

			{#if showTabs}
				<div class="flex shrink-0 gap-1 border-b border-neutral-800 px-6" role="tablist">
					{#each [['details', 'Details'], ['shelves', 'Shelves']] as const as [tab, label] (tab)}
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === tab}
							onclick={() => (activeTab = tab)}
							class="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab ===
							tab
								? 'border-blue-500 text-white'
								: 'border-transparent text-neutral-400 hover:text-neutral-200'}"
						>
							{label}
							{#if tab === 'shelves' && selectedShelfIds.size > 0}
								<span class="ml-1 text-xs text-neutral-500">{selectedShelfIds.size}</span>
							{/if}
						</button>
					{/each}
				</div>
			{/if}

			<!-- Details tab: embedded metadata (library books only) -->
			{#if showTabs && activeTab === 'details'}
				<div class="min-h-0 flex-1 overflow-y-auto px-6 py-4" role="tabpanel">
					{#if pickingCover && libraryBookId}
						<CoverPicker
							{libraryBookId}
							onSaved={handleCoverSaved}
							onCancel={() => (pickingCover = false)}
						/>
					{:else if metadataLoading}
						<p class="text-xs text-neutral-500">Reading book…</p>
					{:else if metadataError}
						<p class="text-xs text-neutral-500">{metadataError}</p>
					{:else if metadata}
						<div class="flex gap-4">
							<div class="flex w-24 shrink-0 flex-col items-center gap-2 self-start">
								{#if !coverMissing}
									<img
										src="/api/library/{libraryBookId}/cover{coverVersion
											? `?t=${coverVersion}`
											: ''}"
										alt="Cover"
										class="w-full rounded-md shadow-lg"
										onerror={() => (coverMissing = true)}
									/>
								{:else}
									<div
										class="flex aspect-[2/3] w-full items-center justify-center rounded-md border border-dashed border-neutral-700 text-[10px] text-neutral-500"
									>
										No cover
									</div>
								{/if}
								<button
									type="button"
									onclick={() => (pickingCover = true)}
									class="text-xs text-blue-400 hover:text-blue-300"
								>
									{coverMissing ? 'Add cover' : 'Change cover'}
								</button>
							</div>
							<dl
								class="grid min-w-0 flex-1 grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1.5 text-sm"
							>
								{#each metadataRows as [label, value] (label)}
									<dt class="text-neutral-500">{label}</dt>
									<dd class="min-w-0 break-words text-neutral-200">{value}</dd>
								{/each}
							</dl>
						</div>
						{#if metadata.subjects.length}
							<div class="mt-3 flex flex-wrap gap-1.5">
								{#each metadata.subjects as subject (subject)}
									<span class="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300"
										>{subject}</span
									>
								{/each}
							</div>
						{/if}
						{#if metadata.description}
							<p
								class="mt-3 text-sm whitespace-pre-line text-neutral-400 {descriptionExpanded
									? ''
									: 'line-clamp-4'}"
							>
								{metadata.description}
							</p>
							<button
								type="button"
								onclick={() => (descriptionExpanded = !descriptionExpanded)}
								class="mt-1 text-xs text-blue-400 hover:text-blue-300"
							>
								{descriptionExpanded ? 'Show less' : 'Show more'}
							</button>
						{/if}
					{/if}
				</div>
			{/if}

			<!-- Shelves (a tab for library books, the whole body for downloads) -->
			{#if showShelves}
				<div class="flex min-h-[10rem] flex-1" role={showTabs ? 'tabpanel' : undefined}>
					<!-- Shelf selection -->
					<div class="flex flex-1 flex-col overflow-hidden p-4">
						<p class="mb-3 shrink-0 text-sm font-medium text-neutral-300">
							{#if showTabs}
								Shelves this book is on
							{:else}
								Add to shelf <span class="text-neutral-500"
									>{isEdit ? '(optional)' : '(required)'}</span
								>
							{/if}
						</p>

						{#if shelvesLoading}
							<div class="flex flex-1 flex-col items-center justify-center">
								<svg class="h-6 w-6 animate-spin text-neutral-500" viewBox="0 0 24 24" fill="none">
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
								<p class="mt-2 text-xs text-neutral-500">Loading...</p>
							</div>
						{:else if shelvesError}
							<div class="flex flex-1 flex-col items-center justify-center">
								<p class="text-xs text-red-400">{shelvesError}</p>
							</div>
						{:else}
							<div class="flex-1 space-y-2 overflow-y-auto">
								{#each shelves as shelf (shelf.id)}
									<button
										type="button"
										onclick={() => toggleShelf(shelf.id)}
										class="flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left transition-all {selectedShelfIds.has(
											shelf.id
										)
											? 'border-blue-500 bg-blue-500/10'
											: 'border-neutral-700 bg-neutral-800 hover:border-neutral-600'}"
									>
										<div
											class="flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors {selectedShelfIds.has(
												shelf.id
											)
												? 'border-blue-500 bg-blue-500'
												: 'border-neutral-600'}"
										>
											{#if selectedShelfIds.has(shelf.id)}
												<svg
													class="h-2.5 w-2.5 text-white"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="3"
														d="M5 13l4 4L19 7"
													/>
												</svg>
											{/if}
										</div>
										<div class="min-w-0 flex-1">
											<span class="block truncate text-sm font-medium text-white">{shelf.name}</span
											>
											{#if shelf.bookCount !== undefined}
												<span class="text-xs text-neutral-500">{shelf.bookCount} books</span>
											{/if}
										</div>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Footer -->
			<div class="flex shrink-0 gap-3 border-t border-neutral-800 px-6 py-4">
				{#if !showShelves}
					<button
						type="button"
						onclick={onCancel}
						class="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white"
					>
						Close
					</button>
				{:else}
					<button
						type="button"
						onclick={onCancel}
						class="rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={handleConfirm}
						disabled={!canDownload}
						class="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-600"
					>
						{#if isEdit}
							Save
						{:else if selectedShelfIds.size === 0}
							Select a shelf to download
						{:else}
							Download
						{/if}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}
