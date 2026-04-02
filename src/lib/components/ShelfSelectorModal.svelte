<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import type { Shelf } from '$lib/types';

	interface CoverResult {
		url: string;
		displayUrl: string;
		source: string;
		preSelected?: boolean;
	}

	interface BookInfo {
		title: string;
		author: string;
	}

	interface UploadCoverTile {
		kind: 'upload';
	}

	interface SearchCoverTile {
		kind: 'cover';
		cover: CoverResult;
	}

	type CoverTile = UploadCoverTile | SearchCoverTile;

	interface Props {
		isOpen: boolean;
		book: BookInfo | null;
		initialShelfIds?: string[];
		/** Filesystem-native book ID — when set, the current local cover is fetched and pre-selected */
		bookId?: string | null;
		/** When true, cover selection is optional (editing existing book) */
		isEdit?: boolean;
		onConfirm: (shelfIds: string[], coverUrl: string | null, coverData: string | null) => void;
		onCancel: () => void;
	}

	let {
		isOpen,
		book,
		initialShelfIds = [],
		bookId = null,
		isEdit = false,
		onConfirm,
		onCancel
	}: Props = $props();

	let shelves = $state<Shelf[]>([]);
	let selectedShelfIds = $state<Set<string>>(new Set());
	let shelvesLoading = $state(true);
	let shelvesError = $state<string | null>(null);
	let cachedShelves = $state<Shelf[] | null>(null);

	let covers = $state<CoverResult[]>([]);
	let selectedCoverUrl = $state<string | null>(null); // original URL (from search results)
	let coversLoading = $state(true);
	let coversError = $state<string | null>(null);
	let failedCoverUrls = $state<Set<string>>(new Set());
	let coverCache = $state<Record<string, CoverResult[]>>({});

	// Uploaded cover state
	let uploadedCoverData = $state<string | null>(null); // base64 image bytes
	let uploadedDisplayUrl = $state<string | null>(null); // object URL for <img> preview
	const UPLOAD_KEY = '__uploaded__';

	let fileInput: HTMLInputElement | undefined = $state();

	// Whether the uploaded tile is selected
	const uploadedSelected = $derived(selectedCoverUrl === UPLOAD_KEY);
	const COVER_COLUMN_COUNT = 4;

	const coverColumns = $derived.by(() => {
		const items: CoverTile[] = [
			{ kind: 'upload' },
			...covers.map((cover): SearchCoverTile => ({ kind: 'cover', cover }))
		];
		const columns = Array.from({ length: COVER_COLUMN_COUNT }, () => [] as CoverTile[]);

		for (const [index, item] of items.entries()) {
			columns[index % COVER_COLUMN_COUNT].push(item);
		}

		return columns;
	});

	// Fetch both when modal transitions from closed → open
	// Using a previous-value pattern so state writes inside the modal don't re-trigger this.
	let wasOpen = $state(false);
	$effect(() => {
		if (isOpen && !wasOpen && book) {
			wasOpen = true;
			selectedShelfIds = new Set(initialShelfIds);
			if (!selectedCoverUrl || selectedCoverUrl === UPLOAD_KEY) {
				selectedCoverUrl = null;
			}
			failedCoverUrls = new Set();
			if (!uploadedCoverData) {
				revokeUploadedUrl();
			}
			fetchShelves();
			if (isEdit) fetchCovers(book);
		} else if (!isOpen && wasOpen) {
			wasOpen = false;
		}
	});

	function revokeUploadedUrl() {
		if (uploadedDisplayUrl) {
			URL.revokeObjectURL(uploadedDisplayUrl);
			uploadedDisplayUrl = null;
		}
	}

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

	async function fetchCovers(b: BookInfo) {
		const cacheKey = bookId ?? `${b.title}::${b.author}`;
		if (coverCache[cacheKey]) {
			covers = coverCache[cacheKey];
			coversLoading = false;
			coversError = covers.length === 0 ? 'No covers found.' : null;
			const preSelected = covers.find((c: CoverResult) => c.preSelected);
			if (!selectedCoverUrl && preSelected) selectedCoverUrl = preSelected.url;
			return;
		}
		coversLoading = true;
		coversError = null;
		covers = [];
		failedCoverUrls = new Set();
		try {
			const params = new URLSearchParams({ title: b.title, author: b.author });
			if (bookId) params.set('bookId', String(bookId));
			const response = await fetch(`/api/covers/search?${params}`);
			if (!response.ok) throw new Error('Failed to load covers');
			const data = await response.json();
			covers = data.covers || [];
			coverCache = { ...coverCache, [cacheKey]: covers };
			// Auto-select the pre-selected cover (embedded EPUB cover)
			const preSelected = covers.find((c: CoverResult) => c.preSelected);
			if (preSelected) selectedCoverUrl = preSelected.url;
			if (covers.length === 0) coversError = 'No covers found.';
		} catch (e) {
			coversError = e instanceof Error ? e.message : 'Failed to load covers';
		} finally {
			coversLoading = false;
		}
	}

	function toggleShelf(shelfId: string) {
		const newSet = new Set(selectedShelfIds);
		if (newSet.has(shelfId)) {
			newSet.delete(shelfId);
		} else {
			newSet.add(shelfId);
		}
		selectedShelfIds = newSet;
	}

	function selectCover(url: string) {
		selectedCoverUrl = url;
	}

	function markCoverFailed(url: string) {
		if (failedCoverUrls.has(url)) return;
		failedCoverUrls = new Set([...failedCoverUrls, url]);
		if (selectedCoverUrl === url) {
			selectedCoverUrl = null;
		}
	}

	function handleUploadClick() {
		fileInput?.click();
	}

	function handleFileChange(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		// Revoke previous object URL
		revokeUploadedUrl();

		// Preview URL
		uploadedDisplayUrl = URL.createObjectURL(file);

		// Read as base64 for sending to server
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			// Strip the data:image/...;base64, prefix
			uploadedCoverData = dataUrl.split(',')[1] ?? null;
			selectedCoverUrl = UPLOAD_KEY;
		};
		reader.readAsDataURL(file);

		// Reset input so same file can be re-selected
		(e.target as HTMLInputElement).value = '';
	}

	function handleConfirm() {
		if (!canDownload) return;
		if (isEdit) {
			if (uploadedSelected && uploadedCoverData) {
				onConfirm(Array.from(selectedShelfIds), null, uploadedCoverData);
			} else if (selectedCoverUrl && selectedCoverUrl !== UPLOAD_KEY) {
				if (selectedCoverUrl.startsWith('data:')) {
					const base64 = selectedCoverUrl.split(',')[1] ?? null;
					onConfirm(Array.from(selectedShelfIds), null, base64);
				} else {
					onConfirm(Array.from(selectedShelfIds), selectedCoverUrl, null);
				}
			} else {
				// No cover change
				onConfirm(Array.from(selectedShelfIds), null, null);
			}
		} else {
			// Download path — no cover
			onConfirm(Array.from(selectedShelfIds), null, null);
		}
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onCancel();
	}

	function handleEscape(e: KeyboardEvent) {
		if (e.key === 'Escape') onCancel();
	}

	const hasCover = $derived(
		(selectedCoverUrl !== null && selectedCoverUrl !== UPLOAD_KEY) ||
			(uploadedSelected && uploadedCoverData !== null)
	);

	const canDownload = $derived(!shelvesLoading && (isEdit ? !coversLoading : true));
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
		<!-- Modal: wide two-column -->
		<div
			class="flex w-full flex-col rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl {isEdit
				? 'h-[85vh] max-w-6xl'
				: 'max-w-sm'}"
			transition:fly={{ y: 20, duration: 300, opacity: 0 }}
			role="dialog"
			aria-modal="true"
			aria-labelledby="shelf-selector-title"
		>
			<!-- Header -->
			<div class="flex shrink-0 items-center justify-between border-b border-neutral-800 px-6 py-4">
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

			<!-- Body: two-column in edit mode, single-column (shelves only) when downloading -->
			<div class="flex min-h-0 flex-1 divide-x divide-neutral-800">
				{#if isEdit}
					<!-- Left: Cover selection (edit only) -->
					<div class="flex flex-1 flex-col overflow-hidden p-5">
						<p class="mb-3 shrink-0 text-sm font-medium text-neutral-300">
							Select a cover <span class="text-neutral-500">(optional)</span>
						</p>

						<!-- Hidden file input -->
						<input
							bind:this={fileInput}
							type="file"
							accept="image/*"
							class="hidden"
							onchange={handleFileChange}
						/>

						{#if coversLoading}
							<div class="flex flex-1 flex-col items-center justify-center">
								<svg class="h-8 w-8 animate-spin text-neutral-500" viewBox="0 0 24 24" fill="none">
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
								<p class="mt-3 text-sm text-neutral-500">Searching for covers...</p>
							</div>
						{:else}
							<div class="grid grid-cols-4 gap-4 overflow-y-auto pr-2">
								{#each coverColumns as column, columnIndex (`cover-column-${columnIndex}`)}
									<div class="flex min-w-0 flex-col gap-4">
										{#each column as item, itemKey (item.kind === 'upload' ? 'upload' : item.cover.url)}
											{#if item.kind === 'upload'}
												<button
													type="button"
													onclick={handleUploadClick}
													class="group overflow-hidden rounded-lg border-2 bg-neutral-950 text-left transition-all {uploadedSelected
														? 'border-blue-500 ring-2 ring-blue-500/40'
														: 'border-dashed border-neutral-600 hover:border-neutral-400'}"
												>
													<div
														class="relative flex min-h-56 w-full items-center justify-center overflow-hidden bg-black"
													>
														{#if uploadedDisplayUrl}
															<img
																src={uploadedDisplayUrl}
																alt="Uploaded cover"
																class="block h-auto w-full"
															/>
															{#if uploadedSelected}
																<div
																	class="absolute inset-0 flex items-center justify-center bg-blue-500/20"
																>
																	<div class="rounded-full bg-blue-500 p-1">
																		<svg
																			class="h-4 w-4 text-white"
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
																	</div>
																</div>
															{/if}
															<div
																class="absolute inset-0 flex flex-col items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
															>
																<svg
																	class="h-5 w-5 text-white"
																	fill="none"
																	stroke="currentColor"
																	viewBox="0 0 24 24"
																>
																	<path
																		stroke-linecap="round"
																		stroke-linejoin="round"
																		stroke-width="2"
																		d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
																	/>
																</svg>
																<span class="mt-1 text-xs text-white">Change</span>
															</div>
														{:else}
															<div
																class="flex h-full flex-col items-center justify-center gap-2 text-neutral-500 transition-colors group-hover:text-neutral-300"
															>
																<svg
																	class="h-7 w-7"
																	fill="none"
																	stroke="currentColor"
																	viewBox="0 0 24 24"
																>
																	<path
																		stroke-linecap="round"
																		stroke-linejoin="round"
																		stroke-width="1.5"
																		d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
																	/>
																</svg>
																<span class="text-center text-xs leading-tight"
																	>Upload<br />cover</span
																>
															</div>
														{/if}
													</div>
													<div
														class="min-h-[3.5rem] border-t border-neutral-800 bg-neutral-900 px-2 py-2"
													>
														<p class="truncate text-xs font-medium text-neutral-200">
															{uploadedDisplayUrl ? 'Uploaded cover' : 'Upload custom cover'}
														</p>
														<p class="truncate text-[11px] text-neutral-500">
															{uploadedSelected ? 'Selected' : 'Local file'}
														</p>
													</div>
												</button>
											{:else}
												<button
													type="button"
													onclick={() => selectCover(item.cover.url)}
													class="group overflow-hidden rounded-lg border-2 bg-neutral-950 text-left transition-all {selectedCoverUrl ===
													item.cover.url
														? 'border-blue-500 ring-2 ring-blue-500/40'
														: 'border-neutral-700 hover:border-neutral-500'}"
												>
													<div
														class="relative flex min-h-56 w-full items-center justify-center overflow-hidden bg-black"
													>
														{#if failedCoverUrls.has(item.cover.url)}
															<div
																class="flex h-full w-full items-center justify-center p-3 text-center text-xs text-neutral-500"
															>
																Preview unavailable
															</div>
														{:else}
															<img
																src={item.cover.displayUrl}
																alt="Book cover"
																class="block h-auto w-full"
																loading="lazy"
																onerror={() => markCoverFailed(item.cover.url)}
															/>
														{/if}
														{#if selectedCoverUrl === item.cover.url}
															<div
																class="absolute inset-0 flex items-center justify-center bg-blue-500/20"
															>
																<div class="rounded-full bg-blue-500 p-1">
																	<svg
																		class="h-4 w-4 text-white"
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
																</div>
															</div>
														{/if}
													</div>
													<div
														class="min-h-[3.5rem] border-t border-neutral-800 bg-neutral-900 px-2 py-2"
													>
														<p class="truncate text-xs font-medium text-neutral-200">
															{item.cover.source === 'current'
																? 'Current cover'
																: failedCoverUrls.has(item.cover.url)
																	? 'Preview unavailable'
																	: 'Cover candidate'}
														</p>
														<p
															class="truncate text-[11px] {item.cover.source === 'current'
																? 'font-medium text-green-400'
																: item.cover.source === 'google'
																	? 'text-blue-300'
																	: item.cover.source === 'openlibrary'
																		? 'text-amber-300'
																		: 'text-neutral-500'}"
														>
															{item.cover.source === 'current'
																? 'Current'
																: item.cover.source === 'google'
																	? 'Google Books'
																	: item.cover.source === 'openlibrary'
																		? 'Open Library'
																		: item.cover.source}
														</p>
													</div>
												</button>
											{/if}
										{/each}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<!-- Right: Shelf selection -->
				<div class="flex {isEdit ? 'w-60 shrink-0' : 'flex-1'} flex-col overflow-hidden p-4">
					<p class="mb-3 shrink-0 text-sm font-medium text-neutral-300">
						Add to shelf <span class="text-neutral-500">{isEdit ? '(optional)' : '(required)'}</span
						>
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
										<span class="block truncate text-sm font-medium text-white">{shelf.name}</span>
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

			<!-- Footer -->
			<div class="flex shrink-0 gap-3 border-t border-neutral-800 px-6 py-4">
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
			</div>
		</div>
	</div>
{/if}
