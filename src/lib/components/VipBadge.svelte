<script lang="ts">
	import { onMount } from 'svelte';

	let vipUntil = $state<Date | null>(null);

	const daysLeft = $derived(
		vipUntil ? Math.max(0, Math.ceil((vipUntil.getTime() - Date.now()) / 86_400_000)) : 0
	);

	onMount(async () => {
		try {
			const res = await fetch('/api/account');
			if (!res.ok) return;
			const data: { vipUntil: string | null } = await res.json();
			vipUntil = data.vipUntil ? new Date(data.vipUntil) : null;
		} catch {
			// Badge is informational; hide it on failure
		}
	});
</script>

{#if vipUntil}
	<span
		class="flex items-center gap-1.5 rounded-full bg-neutral-800 px-3 py-1.5 text-xs font-medium {daysLeft <= 7
			? 'text-amber-400'
			: 'text-white'}"
		title="VIP until {vipUntil.toLocaleString()}"
	>
		<svg class="h-3.5 w-3.5 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
			<path d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7L12 17.5 5.8 21.2l1.6-7L2 9.5l7.1-.6z" />
		</svg>
		VIP · {daysLeft} {daysLeft === 1 ? 'day' : 'days'}
	</span>
{/if}
