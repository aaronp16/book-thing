import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveKoboBookOrThrow } from '$lib/server/kobo-library.js';
import { logKoboError, logKoboRequest, logKoboWarn } from '$lib/server/kobo-logging.js';
import { getKoboReadingState, upsertKoboReadingState } from '$lib/server/kobo-state.js';
import {
	createKoboBookNotFoundJsonResponse,
	createKoboShelfNotFoundJsonResponse,
	isKoboBookError,
	isKoboShelfError,
	toKoboTimestamp
} from '$lib/server/kobo-routes.js';

function toKoboReadStatus(status: string | null): string {
	if (status === 'Finished') return 'Finished';
	if (status === 'Reading') return 'Reading';
	return 'ReadyToRead';
}

function fromKoboReadStatus(status: string | null | undefined): string | null {
	if (status === 'Finished') return 'Finished';
	if (status === 'Reading') return 'Reading';
	if (status === 'ReadyToRead') return 'ReadyToRead';
	return null;
}

function cleanProgress(value: number | null): number | null {
	if (value === null || Number.isNaN(value)) return null;
	if (value === Math.trunc(value)) return Math.trunc(value);
	return value;
}

function createReadingStateResponse(
	bookKoboId: string,
	state: Awaited<ReturnType<typeof getKoboReadingState>>
) {
	return {
		EntitlementId: bookKoboId,
		Created: toKoboTimestamp(state?.updatedAt),
		LastModified: toKoboTimestamp(state?.updatedAt),
		PriorityTimestamp: toKoboTimestamp(state?.updatedAt),
		StatusInfo: {
			LastModified: toKoboTimestamp(state?.updatedAt),
			Status: toKoboReadStatus(state?.status ?? null),
			TimesStartedReading: state?.timesStartedReading ?? 0,
			...(state?.lastTimeStartedReading
				? { LastTimeStartedReading: toKoboTimestamp(state.lastTimeStartedReading) }
				: {})
		},
		Statistics: {
			LastModified: toKoboTimestamp(state?.updatedAt),
			...(state?.statistics?.spentReadingMinutes !== null &&
			state?.statistics?.spentReadingMinutes !== undefined
				? { SpentReadingMinutes: state.statistics.spentReadingMinutes }
				: {}),
			...(state?.statistics?.remainingTimeMinutes !== null &&
			state?.statistics?.remainingTimeMinutes !== undefined
				? { RemainingTimeMinutes: state.statistics.remainingTimeMinutes }
				: {})
		},
		CurrentBookmark: {
			LastModified: toKoboTimestamp(state?.updatedAt),
			...(state?.progressPercent !== null && state?.progressPercent !== undefined
				? { ProgressPercent: cleanProgress(state.progressPercent) }
				: {}),
			...(state?.contentSourceProgressPercent !== null &&
			state?.contentSourceProgressPercent !== undefined
				? {
						ContentSourceProgressPercent: cleanProgress(state.contentSourceProgressPercent)
					}
				: {}),
			...(state?.location?.value
				? {
						Location: {
							Value: state.location.value,
							Type: state.location.type,
							Source: state.location.source
						}
					}
				: {})
		}
	};
}

export const GET: RequestHandler = async ({ params }) => {
	try {
		const book = await resolveKoboBookOrThrow(params.shelf, params.id);
		logKoboRequest('library/state GET', { shelf: params.shelf, bookId: book.koboId });
		const state = await getKoboReadingState(book.koboId);
		logKoboRequest('library/state GET response', {
			shelf: params.shelf,
			bookId: book.koboId,
			status: state?.status ?? 'ReadyToRead'
		});
		return json([createReadingStateResponse(book.koboId, state)], {
			headers: {
				'Content-Type': 'application/json; charset=utf-8'
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			logKoboWarn('library/state GET shelf not found', { shelf: params.shelf, bookId: params.id });
			return createKoboShelfNotFoundJsonResponse();
		}
		if (isKoboBookError(error)) {
			logKoboWarn('library/state GET book not found', { shelf: params.shelf, bookId: params.id });
			return createKoboBookNotFoundJsonResponse();
		}

		logKoboError('library/state GET failed', error, { shelf: params.shelf, bookId: params.id });
		return json({ error: 'Failed to load reading state' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	try {
		const book = await resolveKoboBookOrThrow(params.shelf, params.id);
		const payload = await request.json();
		logKoboRequest('library/state PUT', { shelf: params.shelf, bookId: book.koboId, payload });
		const requestReadingState = payload?.ReadingStates?.[0];
		if (!requestReadingState) {
			logKoboWarn('library/state PUT malformed request', {
				shelf: params.shelf,
				bookId: book.koboId,
				payloadKeys: payload ? Object.keys(payload) : []
			});
			return json({ error: 'Malformed request: missing ReadingStates[0]' }, { status: 400 });
		}

		const currentState = await getKoboReadingState(book.koboId);
		const newStatus = fromKoboReadStatus(requestReadingState?.StatusInfo?.Status);
		const wasReading = currentState?.status === 'Reading';
		const isReading = newStatus === 'Reading';

		const nextState = await upsertKoboReadingState(book.koboId, {
			status: newStatus,
			timesStartedReading:
				isReading && !wasReading
					? (currentState?.timesStartedReading ?? 0) + 1
					: (currentState?.timesStartedReading ?? 0),
			lastTimeStartedReading:
				isReading && !wasReading
					? new Date().toISOString()
					: (currentState?.lastTimeStartedReading ?? null),
			progressPercent:
				typeof requestReadingState?.CurrentBookmark?.ProgressPercent === 'number'
					? requestReadingState.CurrentBookmark.ProgressPercent
					: (currentState?.progressPercent ?? null),
			contentSourceProgressPercent:
				typeof requestReadingState?.CurrentBookmark?.ContentSourceProgressPercent === 'number'
					? requestReadingState.CurrentBookmark.ContentSourceProgressPercent
					: (currentState?.contentSourceProgressPercent ?? null),
			location: requestReadingState?.CurrentBookmark?.Location
				? {
						value: requestReadingState.CurrentBookmark.Location.Value ?? null,
						type: requestReadingState.CurrentBookmark.Location.Type ?? null,
						source: requestReadingState.CurrentBookmark.Location.Source ?? null
					}
				: (currentState?.location ?? null),
			statistics: requestReadingState?.Statistics
				? {
						spentReadingMinutes:
							typeof requestReadingState.Statistics.SpentReadingMinutes === 'number'
								? requestReadingState.Statistics.SpentReadingMinutes
								: (currentState?.statistics?.spentReadingMinutes ?? null),
						remainingTimeMinutes:
							typeof requestReadingState.Statistics.RemainingTimeMinutes === 'number'
								? requestReadingState.Statistics.RemainingTimeMinutes
								: (currentState?.statistics?.remainingTimeMinutes ?? null)
					}
				: (currentState?.statistics ?? null)
		});

		logKoboRequest('library/state PUT response', {
			shelf: params.shelf,
			bookId: book.koboId,
			status: nextState.status,
			progressPercent: nextState.progressPercent
		});

		return json({
			RequestResult: 'Success',
			UpdateResults: [
				{
					EntitlementId: book.koboId,
					CurrentBookmarkResult: { Result: 'Success' },
					StatisticsResult: { Result: 'Success' },
					StatusInfoResult: { Result: 'Success' },
					LastModified: toKoboTimestamp(nextState.updatedAt),
					PriorityTimestamp: toKoboTimestamp(nextState.updatedAt)
				}
			]
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			logKoboWarn('library/state PUT shelf not found', { shelf: params.shelf, bookId: params.id });
			return createKoboShelfNotFoundJsonResponse();
		}
		if (isKoboBookError(error)) {
			logKoboWarn('library/state PUT book not found', { shelf: params.shelf, bookId: params.id });
			return createKoboBookNotFoundJsonResponse();
		}

		logKoboError('library/state PUT failed', error, { shelf: params.shelf, bookId: params.id });
		return json({ error: 'Failed to update reading state' }, { status: 500 });
	}
};
