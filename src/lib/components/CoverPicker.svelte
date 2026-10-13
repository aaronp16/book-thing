<script lang="ts">
	import { onMount } from 'svelte';
	import type { CoverCandidate } from '$lib/types';

	interface Props {
		libraryBookId: string;
		onSaved: () => void;
		onCancel: () => void;
	}

	let { libraryBookId, onSaved, onCancel }: Props = $props();

	/** Kobo screens top out around 1264×1680; no point embedding bigger */
	const MAX_HEIGHT = 1680;
	const MAX_WIDTH = 1264;
	const JPEG_QUALITY = 0.9;

	interface Option {
		key: string;
		src: string;
		label: string;
		size?: { width: number; height: number };
		failed?: boolean;
	}

	let options = $state<Option[]>([]);
	let searching = $state(true);
	let searchError = $state<string | null>(null);
	let selectedKey = $state<string | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let uploadUrl: string | null = null;

	const visibleOptions = $derived(options.filter((o) => !o.failed));
	const selected = $derived(options.find((o) => o.key === selectedKey) ?? null);

	onMount(() => {
		void search();
		return () => {
			if (uploadUrl) URL.revokeObjectURL(uploadUrl);
		};
	});

	async function search() {
		searching = true;
		searchError = null;
		try {
			const response = await fetch(`/api/library/${libraryBookId}/cover/candidates`);
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Cover search failed');
			const found: Option[] = (data.candidates as CoverCandidate[]).map((c) => ({
				key: c.url,
				src: c.url,
				label: c.label
			}));
			options = [...options.filter((o) => o.key === 'upload'), ...found];
		} catch (e) {
			searchError = e instanceof Error ? e.message : 'Cover search failed';
		} finally {
			searching = false;
		}
	}

	function handleLoad(option: Option, event: Event) {
		const img = event.currentTarget as HTMLImageElement;
		// Open Library serves a 1×1 placeholder for some missing covers
		if (img.naturalWidth < 50 || img.naturalHeight < 50) {
			option.failed = true;
			return;
		}
		option.size = { width: img.naturalWidth, height: img.naturalHeight };
	}

	function handleUpload(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		if (uploadUrl) URL.revokeObjectURL(uploadUrl);
		uploadUrl = URL.createObjectURL(file);
		const upload: Option = { key: 'upload', src: uploadUrl, label: file.name };
		options = [upload, ...options.filter((o) => o.key !== 'upload')];
		selectedKey = 'upload';
	}

	/** Load an image and re-encode it as a JPEG no larger than a Kobo screen */
	async function toJpeg(src: string): Promise<Blob> {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.src = src;
		await img.decode();

		const scale = Math.min(1, MAX_WIDTH / img.naturalWidth, MAX_HEIGHT / img.naturalHeight);
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(img.naturalWidth * scale);
		canvas.height = Math.round(img.naturalHeight * scale);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas not supported');
		// JPEG has no transparency; flatten onto white like a printed cover
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

		return new Promise((resolve, reject) =>
			canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))),
				'image/jpeg',
				JPEG_QUALITY
			)
		);
	}

	async function save() {
		if (!selected) return;
		saving = true;
		saveError = null;
		try {
			const jpeg = await toJpeg(selected.src);
			const response = await fetch(`/api/library/${libraryBookId}/cover`, {
				method: 'PUT',
				headers: { 'Content-Type': 'image/jpeg' },
				body: jpeg
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.errors?.[0] || data.error || 'Failed to save cover');
			onSaved();
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Failed to save cover';
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex h-full flex-col">
	<div class="mb-3 flex items-center justify-between gap-2">
		<p class="text-sm font-medium text-neutral-300">Choose a cover</p>
		<label
			class="cursor-pointer rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white"
		>
			Upload image
			<input type="file" accept="image/*" class="hidden" onchange={handleUpload} />
		</label>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if visibleOptions.length}
			<div class="grid grid-cols-3 gap-3 sm:grid-cols-4">
				{#each visibleOptions as option (option.key)}
					<button
						type="button"
						onclick={() => (selectedKey = option.key)}
						class="flex flex-col overflow-hidden rounded-lg border-2 bg-neutral-800 text-left transition-colors {selectedKey ===
						option.key
							? 'border-blue-500'
							: 'border-transparent hover:border-neutral-600'}"
					>
						<img
							src={option.src}
							alt={option.label}
							crossorigin="anonymous"
							loading="lazy"
							class="aspect-[2/3] w-full bg-neutral-900 object-cover"
							onload={(e) => handleLoad(option, e)}
							onerror={() => (option.failed = true)}
						/>
						<span class="truncate px-1.5 pt-1 text-[10px] text-neutral-300" title={option.label}
							>{option.label}</span
						>
						<span class="px-1.5 pb-1 text-[10px] text-neutral-500">
							{option.size ? `${option.size.width}×${option.size.height}` : '…'}
						</span>
					</button>
				{/each}
			</div>
		{/if}

		{#if searching}
			<p class="mt-3 text-xs text-neutral-500">Searching Open Library…</p>
		{:else if searchError}
			<p class="mt-3 text-xs text-red-400">{searchError}</p>
		{:else if !visibleOptions.length}
			<p class="mt-3 text-xs text-neutral-500">No covers found online. Upload an image instead.</p>
		{/if}
	</div>

	{#if saveError}
		<p class="mt-3 text-xs text-red-400">{saveError}</p>
	{/if}

	<div class="mt-3 flex shrink-0 gap-3">
		<button
			type="button"
			onclick={onCancel}
			disabled={saving}
			class="rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white disabled:opacity-50"
		>
			Back
		</button>
		<button
			type="button"
			onclick={save}
			disabled={!selected || saving}
			class="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
		>
			{#if saving}
				Saving to book…
			{:else if selected}
				Use this cover
			{:else}
				Select a cover
			{/if}
		</button>
	</div>
</div>
