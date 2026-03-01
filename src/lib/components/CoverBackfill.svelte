<script lang="ts">
	interface BackfillEvent {
		type: 'start' | 'done' | 'skip';
		bookId: number;
		title: string;
		author: string;
		success?: boolean;
		source?: 'epub' | 'openlibrary' | 'google' | 'none';
		processed: number;
		total: number;
	}

	interface Props {
		/** Called when the backfill finishes (total > 0) or finds nothing to do (total = 0) */
		onComplete?: (found: number, succeeded: number) => void;
	}

	let { onComplete }: Props = $props();

	type Phase = 'idle' | 'running' | 'done';

	let phase = $state<Phase>('idle');
	let total = $state(0);
	let processed = $state(0);
	let succeeded = $state(0);
	let currentTitle = $state('');
	let dismissed = $state(false);

	$effect(() => {
		startBackfill();
	});

	function startBackfill() {
		phase = 'running';
		const es = new EventSource('/api/covers/backfill');

		es.onmessage = (e) => {
			const event: BackfillEvent = JSON.parse(e.data);
			total = event.total;
			processed = event.processed;

			if (event.type === 'start') {
				currentTitle = event.title;
			} else if (event.type === 'done') {
				if (event.success) succeeded++;
				currentTitle = event.title;
			}
		};

		es.onerror = () => {
			es.close();
			finish();
		};

		// SSE streams close naturally — ReadableStream.close() causes an error event
		// after the last message, so onerror is the correct completion signal.
		// We also handle the case where the stream sends all messages and closes cleanly.
		es.addEventListener('error', () => {
			es.close();
			finish();
		});
	}

	function finish() {
		phase = 'done';
		onComplete?.(total, succeeded);
	}

	const progress = $derived(total > 0 ? processed / total : 0);
	const progressPct = $derived(Math.round(progress * 100));
</script>

{#if !dismissed && (phase === 'running' || (phase === 'done' && total > 0))}
	<div class="mx-4 mb-3 rounded-lg bg-neutral-800/50 p-3 sm:mx-5">
		<div class="mb-2 flex items-center justify-between gap-2">
			<div class="flex items-center gap-1.5">
				{#if phase === 'running'}
					<svg class="h-3.5 w-3.5 animate-spin flex-shrink-0 text-amber-400" viewBox="0 0 24 24" fill="none">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
				{:else}
					<svg class="h-3.5 w-3.5 flex-shrink-0 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
					</svg>
				{/if}
				<span class="text-xs font-medium text-neutral-300">
					{phase === 'running' ? 'Fetching covers' : 'Covers fetched'}
				</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="text-xs text-neutral-500">{processed}/{total}</span>
				{#if phase === 'done'}
					<button
						type="button"
						onclick={() => (dismissed = true)}
						class="text-neutral-600 transition-colors hover:text-neutral-400"
						aria-label="Dismiss"
					>
						<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				{/if}
			</div>
		</div>

		<!-- Progress bar -->
		<div class="h-1 w-full overflow-hidden rounded-full bg-neutral-700">
			<div
				class="h-full transition-all duration-300 {phase === 'done' ? 'bg-green-500' : 'bg-amber-500'}"
				style="width: {progressPct}%"
			></div>
		</div>

		<!-- Current book -->
		{#if phase === 'running' && currentTitle}
			<p class="mt-1.5 truncate text-xs text-neutral-500">{currentTitle}</p>
		{:else if phase === 'done'}
			<p class="mt-1.5 text-xs text-neutral-500">
				{succeeded} cover{succeeded !== 1 ? 's' : ''} found
			</p>
		{/if}
	</div>
{/if}
