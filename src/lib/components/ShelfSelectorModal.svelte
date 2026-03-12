<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import type { BookResult, Shelf } from '$lib/types';
	import { onMount } from 'svelte';

	interface Props {
		isOpen: boolean;
		book: BookResult | null;
		onConfirm: (shelfIds: number[]) => void;
		onCancel: () => void;
	}

	let { isOpen, book, onConfirm, onCancel }: Props = $props();

	let shelves = $state<Shelf[]>([]);
	let selectedShelfIds = $state<Set<number>>(new Set());
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Fetch shelves when modal opens
	$effect(() => {
		if (isOpen) {
			fetchShelves();
			selectedShelfIds = new Set();
		}
	});

	async function fetchShelves() {
		loading = true;
		error = null;

		try {
			const response = await fetch('/api/shelves');
			if (!response.ok) {
				throw new Error('Failed to load shelves');
			}
			const data = await response.json();
			shelves = data.shelves || [];

			if (shelves.length === 0) {
				error = 'No shelves found. Create shelves in Calibre-Web first.';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load shelves';
		} finally {
			loading = false;
		}
	}

	function toggleShelf(shelfId: number) {
		const newSet = new Set(selectedShelfIds);
		if (newSet.has(shelfId)) {
			newSet.delete(shelfId);
		} else {
			newSet.add(shelfId);
		}
		selectedShelfIds = newSet;
	}

	function handleConfirm() {
		if (selectedShelfIds.size === 0) return;
		onConfirm(Array.from(selectedShelfIds));
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onCancel();
		}
	}

	function handleEscape(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onCancel();
		}
	}

	const canDownload = $derived(selectedShelfIds.size > 0 && !loading);
</script>

{#if isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={handleBackdropClick}
		onkeydown={handleEscape}
		role="button"
		tabindex="-1"
		transition:fade={{ duration: 200 }}
	>
		<!-- Modal -->
		<div
			class="flex w-full max-w-md flex-col rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl"
			transition:fly={{ y: 20, duration: 300, opacity: 0 }}
			role="dialog"
			aria-modal="true"
			aria-labelledby="shelf-selector-title"
		>
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
				<h2 id="shelf-selector-title" class="text-xl font-bold text-white">Add to Shelf</h2>
				<button
					onclick={onCancel}
					class="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-800 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white"
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

			<!-- Content -->
			<div class="flex-1 overflow-y-auto px-6 py-4">
				<!-- Book info -->
				{#if book}
					<div class="mb-4 rounded-lg bg-neutral-800 p-3">
						<p class="truncate text-sm font-medium text-white">{book.title}</p>
						<p class="truncate text-xs text-neutral-400">
							by {book.authors.map((a) => a.name).join(', ')}
						</p>
					</div>
				{/if}

				<!-- Shelf selection -->
				{#if loading}
					<div class="flex flex-col items-center justify-center py-8">
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
						<p class="mt-3 text-sm text-neutral-500">Loading shelves...</p>
					</div>
				{:else if error}
					<div class="flex flex-col items-center justify-center py-8">
						<div class="mb-3 rounded-full bg-red-900/30 p-3">
							<svg
								class="h-6 w-6 text-red-400"
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
						<p class="text-sm text-red-400">{error}</p>
					</div>
				{:else}
					<div class="mb-2">
						<p class="text-sm font-medium text-neutral-300">Select at least one shelf:</p>
					</div>
					<div class="space-y-2">
						{#each shelves as shelf (shelf.id)}
							<button
								type="button"
								onclick={() => toggleShelf(shelf.id)}
								class="flex w-full items-center justify-between rounded-lg border p-3 text-left transition-all {selectedShelfIds.has(
									shelf.id
								)
									? 'border-blue-500 bg-blue-500/10'
									: 'border-neutral-700 bg-neutral-800 hover:border-neutral-600 hover:bg-neutral-750'}"
							>
								<div class="flex items-center gap-3">
									<!-- Checkbox -->
									<div
										class="flex h-5 w-5 items-center justify-center rounded border-2 transition-colors {selectedShelfIds.has(
											shelf.id
										)
											? 'border-blue-500 bg-blue-500'
											: 'border-neutral-600'}"
									>
										{#if selectedShelfIds.has(shelf.id)}
											<svg
												class="h-3 w-3 text-white"
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

									<!-- Shelf name -->
									<span class="font-medium text-white">{shelf.name}</span>
								</div>

								<!-- Book count -->
								{#if shelf.bookCount !== undefined}
									<span class="text-xs text-neutral-500">({shelf.bookCount})</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex gap-3 border-t border-neutral-800 px-6 py-4">
				<button
					type="button"
					onclick={onCancel}
					class="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-750 hover:text-white"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={handleConfirm}
					disabled={!canDownload}
					class="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-600"
				>
					Download
				</button>
			</div>
		</div>
	</div>
{/if}
