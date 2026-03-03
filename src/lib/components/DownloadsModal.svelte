<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import TorrentSidebar from './TorrentSidebar.svelte';
	import type { DownloadJob } from '$lib/types';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		fetchingJobs: DownloadJob[];
		onCountChange?: (count: number) => void;
	}

	let { isOpen, onClose, fetchingJobs, onCountChange }: Props = $props();

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onClose();
		}
	}

	function handleEscape(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
		}
	}
</script>

{#if isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-50 bg-black/50"
		onclick={handleBackdropClick}
		onkeydown={handleEscape}
		role="button"
		tabindex="-1"
		transition:fade={{ duration: 200 }}
	>
		<!-- Drawer -->
		<div
			class="absolute top-0 right-0 bottom-0 flex w-full flex-col border-l border-neutral-800 bg-neutral-900 sm:w-[480px] md:w-[520px]"
			transition:fly={{ x: 500, duration: 300, opacity: 1 }}
			role="dialog"
			aria-modal="true"
			aria-labelledby="downloads-modal-title"
		>
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-neutral-800 px-4 py-4 sm:px-6">
				<h2 id="downloads-modal-title" class="text-xl font-bold text-white sm:text-2xl">
					Downloads
				</h2>
				<button
					onclick={onClose}
					class="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-800 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white"
					aria-label="Close downloads"
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

			<!-- Torrents content -->
			<div class="flex-1 overflow-hidden">
				<TorrentSidebar {fetchingJobs} {onCountChange} />
			</div>
		</div>
	</div>
{/if}
