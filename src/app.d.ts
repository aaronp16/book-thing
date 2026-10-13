// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	namespace NodeJS {
		interface ProcessEnv {
			MAM_ID?: string;
			MAM_UID?: string;
			BOOKS_DIR?: string;
			MAM_SESSION_FILE?: string;
		}
	}
}

export {};
