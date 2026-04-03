<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function formatSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
	}
</script>

<svelte:head>
	<title>{data.shelfName} - book-thing</title>
	<style>
		/* Reset the dark theme from the layout for this page */
		body,
		html {
			background: #fff !important;
			color: #000 !important;
		}
		/* Hide the layout wrapper's dark styling */
		body > div > div {
			background: #fff !important;
			color: #000 !important;
		}
	</style>
</svelte:head>

<div class="eink-page">
	<h1>{data.shelfName}</h1>
	<p class="count">{data.books.length} book{data.books.length !== 1 ? 's' : ''}</p>

	{#if data.books.length === 0}
		<p>No books on this shelf.</p>
	{:else}
		<ul class="book-list">
			{#each data.books as book}
				<li>
					<a href="/api/library/{book.id}/download/{book.downloadFilename}" class="book-link">
						<span class="book-title">{book.title}</span>
						{#if book.author}
							<span class="book-author">by {book.author}</span>
						{/if}
						<span class="book-meta"
							>{book.extension.toUpperCase()} &middot; {formatSize(book.size)}</span
						>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.eink-page {
		background: #fff;
		color: #000;
		font-family: Georgia, 'Times New Roman', serif;
		max-width: 800px;
		margin: 0 auto;
		padding: 20px;
		line-height: 1.4;
	}

	h1 {
		font-size: 28px;
		margin: 0 0 4px 0;
		border-bottom: 2px solid #000;
		padding-bottom: 8px;
		text-transform: capitalize;
	}

	.count {
		margin: 0 0 20px 0;
		font-size: 16px;
		color: #555;
	}

	.book-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.book-list li {
		border-bottom: 1px solid #ccc;
	}

	.book-link {
		display: block;
		padding: 14px 4px;
		text-decoration: none;
		color: #000;
	}

	.book-title {
		display: block;
		font-size: 18px;
		font-weight: bold;
	}

	.book-author {
		display: block;
		font-size: 15px;
		color: #333;
		margin-top: 2px;
	}

	.book-meta {
		display: block;
		font-size: 13px;
		color: #666;
		margin-top: 2px;
	}
</style>
